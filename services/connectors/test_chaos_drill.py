"""UC2-041 — the LIVE→CACHED→SYNTHETIC chaos drill.

THE DEFECT THIS TICKET FOUND
----------------------------
The middle tier was unreachable in every configuration the stack can boot in.
`FallbackChain` wrote its cache in exactly one place — inside the LIVE branch —
and no connector had a live poll that could succeed, so the cache was never
populated and CACHED was never served. Measured before the fix::

    DATA_MODE=mock (how compose runs it)   -> ['SYNTHETIC'] * 5
    DATA_MODE=live, no creds               -> ['SYNTHETIC'] * 5
    DATA_MODE=live + creds set             -> ['SYNTHETIC'] * 5

A rehearsal of "watch it fall from LIVE to CACHED to SYNTHETIC" would have shown
SYNTHETIC three times. Every test below exists to keep that from being true again.

These run against a REAL HTTP server standing in for POC-3, not a mocked httpx:
the tier boundary is a network boundary, and a drill proven only against a stub
object would not have caught the fact that nothing could reach the connectors in
the first place (UC2-040) either.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import pytest

from connectors_common.fallback import FallbackTier, SourceUnavailable
from connectors_common.health import Degradation
from connectors_common.poc3 import Poc3Client
from connectors_common.replay import rows_to_events, valid_iso6346
from connectors_common.synth import check_digit

from ulip.connector import UlipConnector
from icegate.connector import IcegateConnector
from tos.connector import TosConnector
from fois.connector import FoisConnector
from eseal.connector import EsealConnector
from shipline.connector import ShiplineConnector

TOKEN = "test-token-not-a-credential"


def cn(serial: int) -> str:
    """A valid ISO 6346 number, so replayed rows pass the same check synth does."""
    prefix = f"MAEU{serial:06d}"
    return prefix + str(check_digit(prefix))


class _Poc3Stub(BaseHTTPRequestHandler):
    """Stands in for the POC-3 gateway: same auth handshake, same page shape."""

    # Mutated per-test to steer the stub.
    rows_by_path: dict = {}
    reject_login = False
    expire_first_token = False
    _served_401 = False

    def log_message(self, *a):  # keep pytest output clean
        pass

    def _json(self, code: int, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if urlparse(self.path).path == "/api/auth/login":
            if type(self).reject_login:
                return self._json(401, {"detail": "invalid credentials"})
            return self._json(200, {"access_token": TOKEN, "role": "admin"})
        self._json(404, {"detail": "not found"})

    def do_GET(self):
        path = urlparse(self.path).path
        if type(self).expire_first_token and not type(self)._served_401:
            type(self)._served_401 = True
            return self._json(401, {"detail": "token expired"})
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._json(401, {"detail": "no bearer"})
        rows = type(self).rows_by_path.get(path)
        if rows is None:
            return self._json(404, {"detail": f"no stub for {path}"})
        self._json(200, {"items": rows, "total": len(rows)})


@pytest.fixture
def poc3():
    """A live POC-3 stub on a real socket; yields its base URL."""
    _Poc3Stub.rows_by_path = {}
    _Poc3Stub.reject_login = False
    _Poc3Stub.expire_first_token = False
    _Poc3Stub._served_401 = False
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Poc3Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()


def wired(ConnCls, base_url, rows_by_path):
    """A connector pointed at the stub, with its registers populated."""
    _Poc3Stub.rows_by_path = rows_by_path
    c = ConnCls()
    c.poc3 = Poc3Client(base_url=base_url, username="u", password="p")
    return c


ULIP_ROWS = [
    {"id": i, "container_number": cn(100000 + i), "event_type": "GATE_IN",
     "created_at": "2026-06-15T09:00:00+00:00", "terminal": "NSICT"}
    for i in range(5)
]


# ---------------------------------------------------------------- the drill --
def test_the_drill_walks_all_three_tiers(poc3):
    """The acceptance case: one control, three tiers, in order, and back."""
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    report = c.run_drill()

    assert [s["tier"] for s in report["steps"]] == ["LIVE", "CACHED", "SYNTHETIC", "LIVE"]
    assert report["allMatched"] is True
    assert report["liveUpstreamConfigured"] is True


def test_the_drill_reports_a_missing_live_upstream_instead_of_a_green_tick(poc3):
    """On a laptop with no POC-3 credentials the drill must SAY so.

    The tempting failure here is a drill that quietly relabels whatever tier it
    reached as the expected one. Then a rehearsal on an unconfigured machine
    passes, and the first time anyone checks is in front of the evaluator.
    """
    c = UlipConnector()  # no poc3 client configured

    report = c.run_drill()

    assert report["liveUpstreamConfigured"] is False
    assert {s["tier"] for s in report["steps"]} == {"SYNTHETIC"}
    assert report["allMatched"] is False
    assert [s["matched"] for s in report["steps"]] == [False, False, False, False]


def test_the_drill_leaves_the_connector_clean(poc3):
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    c.run_drill()
    assert c.health.forced is None
    assert c.health.degradation == Degradation.GREEN


# ------------------------------------------------------------ tier by tier --
def test_live_names_the_upstream_that_actually_answered(poc3):
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    result = c.poll()

    assert result["tier"] == "LIVE"
    # It was the REPLAY reader, not ULIP's own gateway — the card must not blur
    # the two, or "LIVE" reads as "ULIP is onboarded".
    assert "POC-3 replay" in result["health"]["upstream"]
    assert "production API" not in result["health"]["upstream"]


def test_cached_replays_the_live_payload_and_states_its_true_age(poc3):
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    live = c.poll()
    assert live["tier"] == "LIVE"

    c.health.inject_fault(Degradation.AMBER)
    cached = c.poll()

    assert cached["tier"] == "CACHED"
    assert cached["emitted"] == live["emitted"]          # the same payload, replayed
    assert "last-known-good" in cached["health"]["note"]
    assert "s old" in cached["health"]["note"]           # a real age, not "stale"
    assert "POC-3 replay" in cached["health"]["upstream"]  # whose data it is survives
    assert cached["health"]["degradation"] == "AMBER"


def test_red_refuses_the_cache_rather_than_replaying_an_outage_as_current(poc3):
    """RED is the honesty case, and the reason AMBER and RED differ at all.

    A source marked down must not keep serving its pre-outage payload as though
    it were current — that is the failure mode the whole fallback story exists to
    avoid. The simulator takes over and the note says why.
    """
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    c.poll()
    cached_containers = {e["data"]["containerNo"] for t, e in c._published if "cargo" in t}

    c.health.inject_fault(Degradation.RED)
    out = c.poll()

    assert out["tier"] == "SYNTHETIC"
    assert out["health"]["degradation"] == "RED"
    assert "refused" in out["health"]["note"]
    fresh = [e for t, e in c._published if "cargo" in t][-out["emitted"]:]
    assert all(e["jnpamode"] == "SYNTHETIC" for e in fresh)
    assert not cached_containers & {e["data"]["containerNo"] for e in fresh}


def test_a_stale_cache_is_skipped_and_the_note_gives_the_numbers(poc3):
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    c.chain.cache_staleness_s = 0.0   # budget already exhausted
    c.poll()

    c.health.inject_fault(Degradation.AMBER)
    out = c.poll()

    assert out["tier"] == "SYNTHETIC"
    assert "budget" in out["health"]["note"]


def test_recovery_is_immediate_on_the_very_next_poll(poc3):
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    c.poll()
    c.health.inject_fault(Degradation.RED)
    assert c.poll()["tier"] == "SYNTHETIC"

    c.health.inject_fault(None)

    assert c.poll()["tier"] == "LIVE"


# ------------------------------------------------- the replay tier's honesty --
def test_a_source_with_no_ingested_register_stays_synthetic(poc3):
    """FOIS. Rail is not ingested, so it cannot reach LIVE — and must not pretend.

    Five of six connectors going green while rail stays amber is the honest
    picture, and the Integration tab should show that asymmetry.
    """
    c = wired(FoisConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    result = c.poll()

    assert result["tier"] == "SYNTHETIC"
    assert c.replay_spec() is None
    assert "no ingested POC-3 register" in result["health"]["note"]


def test_an_empty_page_is_unavailable_not_a_live_badge_on_zero_rows(poc3):
    c = wired(UlipConnector, poc3, {"/api/cargo/events": []})

    result = c.poll()

    assert result["tier"] == "SYNTHETIC"
    assert result["emitted"] > 0  # the simulator still serves


def test_rows_without_a_usable_container_number_are_dropped_not_emitted():
    rows = [
        {"container_number": cn(1), "event_type": "GATE_IN"},
        {"container_number": "NOTACONTAINER", "event_type": "GATE_IN"},
        {"container_number": "MAEU1234560", "event_type": "GATE_IN"},  # check digit is 7, not 0
        {"event_type": "GATE_IN"},                                     # no number at all
    ]

    events = rows_to_events(rows, "ULIP", "GATE_IN", "/api/cargo/events")

    assert len(events) == 1
    assert all(valid_iso6346(e["containerNo"]) for e in events)


def test_a_page_with_no_mappable_row_reports_unavailable():
    with pytest.raises(SourceUnavailable, match="none with a valid container number"):
        rows_to_events([{"foo": 1}], "ULIP", "GATE_IN", "/api/cargo/events")


def test_the_eseal_reader_says_nothing_about_containers_it_never_read(poc3):
    """Only rows carrying a real seal number become e-seal events."""
    rows = [
        {"id": 1, "container_number": cn(200001), "eseal_number": "ESEAL900001"},
        {"id": 2, "container_number": cn(200002), "eseal_number": None},
        {"id": 3, "container_number": cn(200003), "eseal_number": "", "eseal_status": "OK"},
        {"id": 4, "container_number": cn(200004), "eseal_number": "ESEAL900004",
         "eseal_status": "BROKEN"},
    ]
    c = wired(EsealConnector, poc3, {"/api/cargo": rows})

    result = c.poll()

    assert result["tier"] == "LIVE"
    assert result["emitted"] == 2
    emitted = [e["data"] for t, e in c._published if "cargo" in t]
    assert {e["eventType"] for e in emitted} == {"ESEAL_AFFIX", "ESEAL_BREAK"}
    assert all(e["payload"]["eseal_number"] for e in emitted)


def test_a_timestamp_is_never_invented_only_labelled():
    """A row with no time of its own is stamped at the poll and SAYS so."""
    dated, undated = rows_to_events(
        [{"container_number": cn(300001), "created_at": "2026-06-15T09:00:00+00:00"},
         {"container_number": cn(300002)}],
        "ULIP", "GATE_IN", "/api/cargo/events",
    )
    assert dated["payload"]["tsSource"] == "created_at"
    assert dated["ts"].startswith("2026-06-15T09:00:00")
    assert "poll-time" in undated["payload"]["tsSource"]


def test_replaying_the_same_row_twice_produces_the_same_event_id():
    """So a consumer can de-duplicate a replay instead of double-counting it."""
    a = rows_to_events(ULIP_ROWS, "ULIP", "GATE_IN", "/api/cargo/events")
    b = rows_to_events(ULIP_ROWS, "ULIP", "GATE_IN", "/api/cargo/events")
    assert [e["eventId"] for e in a] == [e["eventId"] for e in b]


def test_the_terminals_gate_feed_does_not_guess_a_direction(poc3):
    """`core.codeco_movement` has no direction column — so neither do we."""
    rows = [{"id": 1, "container_no": cn(400001), "gate_pass_ts": "2026-06-15T02:51:00+00:00",
             "terminal_code": "NSICT", "vehicle_no": "MH46H6948", "equipment_status": "FCL"}]
    c = wired(TosConnector, poc3, {"/api/shipping-lines/gate-movements": rows})

    c.poll()

    ev = [e["data"] for t, e in c._published if "cargo" in t][0]
    assert ev["eventType"] == "GATE_MOVE"
    assert ev["eventType"] not in ("GATE_IN", "GATE_OUT")
    assert ev["vehicleNo"] == "MH46H6948"
    assert ev["payload"]["equipment_status"] == "FCL"


def test_customs_walks_a_real_manifest_before_reading_its_containers(poc3):
    rows = {
        "/api/customs/igm": [{"igm_no": 1194313, "igm_date": "2026-06-10"}],
        "/api/customs/igm/1194313/containers": [
            {"igm_no": 1194313, "container_no": cn(500001), "seal_no": "SL1", "container_status": "FCL"},
        ],
    }
    c = wired(IcegateConnector, poc3, rows)

    result = c.poll()

    assert result["tier"] == "LIVE"
    ev = [e["data"] for t, e in c._published if "cargo" in t][0]
    assert ev["eventType"] == "CUSTOMS_FLAG"
    assert ev["payload"]["igm_no"] == 1194313
    assert "/api/customs/igm/1194313/containers" in ev["rawRef"]


# ------------------------------------------------------------------- client --
def test_an_expired_token_is_re_minted_once_rather_than_read_as_an_outage(poc3):
    """An 8 h JWT expiring mid-demo is not a source failure."""
    _Poc3Stub.expire_first_token = True
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    assert c.poll()["tier"] == "LIVE"


def test_rejected_credentials_fall_through_instead_of_pretending(poc3):
    _Poc3Stub.reject_login = True
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    result = c.poll()

    assert result["tier"] == "SYNTHETIC"
    assert "login rejected" in result["health"]["note"]


def test_an_unreachable_upstream_falls_through_instead_of_hanging(poc3):
    c = wired(UlipConnector, "http://127.0.0.1:1", {"/api/cargo/events": ULIP_ROWS})
    c.poc3.timeout_s = 1.0

    assert c.poll()["tier"] == "SYNTHETIC"


def test_the_note_keeps_BOTH_failure_reasons(poc3):
    """"ULIP needs an NDA token" and "POC-3 refused the login" are different
    problems, and an operator looking at an amber card needs to know which."""
    _Poc3Stub.reject_login = True
    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    note = c.poll()["health"]["note"]

    assert "ULIP" in note and "POC-3" in note


def test_no_credential_configuration_leaves_every_connector_exactly_as_it_was():
    """A cold checkout must behave identically to before this ticket."""
    for ConnCls in (UlipConnector, IcegateConnector, TosConnector,
                    FoisConnector, EsealConnector, ShiplineConnector):
        c = ConnCls()
        assert c.poc3.configured is False
        assert c._prefer() == FallbackTier.SYNTHETIC
        assert c.poll()["tier"] == "SYNTHETIC"


# ---------------------------------------------------------------- HTTP API --
def test_inject_fault_returns_the_card_an_actual_poll_left(poc3):
    """The console drags a control and must see the tier that really served.

    Before this, /inject-fault only pinned a colour: the card kept whatever mode
    the LAST poll had set, so the console showed AMBER over a LIVE mode until
    something else happened to poll.
    """
    from fastapi.testclient import TestClient

    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    client = TestClient(c.build_app())
    client.post("/poll")

    amber = client.post("/inject-fault", json={"level": "AMBER"}).json()
    assert amber["mode"] == "CACHED"
    assert amber["degradation"] == "AMBER"

    red = client.post("/inject-fault", json={"level": "RED"}).json()
    assert red["mode"] == "SYNTHETIC"

    clear = client.post("/inject-fault", json={"level": None}).json()
    assert clear["mode"] == "LIVE"
    assert clear["degradation"] == "GREEN"


def test_inject_fault_can_still_pin_without_polling(poc3):
    from fastapi.testclient import TestClient

    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})
    client = TestClient(c.build_app())
    client.post("/poll")

    body = client.post("/inject-fault", json={"level": "AMBER", "repoll": False}).json()

    assert body["degradation"] == "AMBER"
    assert body["mode"] == "LIVE"   # unchanged — no poll happened


def test_the_drill_endpoint_returns_a_transcript(poc3):
    from fastapi.testclient import TestClient

    c = wired(UlipConnector, poc3, {"/api/cargo/events": ULIP_ROWS})

    report = TestClient(c.build_app()).post("/drill").json()

    assert [s["tier"] for s in report["steps"]] == ["LIVE", "CACHED", "SYNTHETIC", "LIVE"]
    assert all(s["why"] for s in report["steps"])
    assert all(s["note"] for s in report["steps"])
