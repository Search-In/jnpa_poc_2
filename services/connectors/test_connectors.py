"""Connector tests (prompt §6): fallback chain, Health Card, fault injection,
schema-accurate synthetic output. Network-free — proves each integration +
fallback works without production credentials (D.2 / poc-selftest).
"""
import re

import pytest

from connectors_common.fallback import FallbackChain, SourceUnavailable
from connectors_common.health import Degradation, HealthCard, IntegrationMode
from connectors_common.synth import check_digit, container_no, _LETTER_VALUES
import random

from ulip.connector import UlipConnector
from icegate.connector import IcegateConnector
from tos.connector import TosConnector
from fois.connector import FoisConnector
from eseal.connector import EsealConnector
from shipline.connector import ShiplineConnector

ALL = [UlipConnector, IcegateConnector, TosConnector, FoisConnector, EsealConnector, ShiplineConnector]
ISO6346 = re.compile(r"^[A-Z]{3}[UJZ]\d{6}\d$")


def _valid_iso6346(cn: str) -> bool:
    if not ISO6346.match(cn):
        return False
    s = sum((_LETTER_VALUES[c] if c.isalpha() else int(c)) * (2 ** i) for i, c in enumerate(cn[:10]))
    return int(cn[10]) == (0 if s % 11 == 10 else s % 11)


def test_check_digit_known_value():
    assert check_digit("MAEU123456") == 7
    assert _valid_iso6346(container_no(random.Random(1)))


@pytest.mark.parametrize("ConnCls", ALL)
def test_synthetic_poll_emits_valid_events(ConnCls):
    c = ConnCls()
    result = c.poll()
    assert result["emitted"] > 0
    assert result["tier"] == "SYNTHETIC"  # no creds → synthetic tier
    # every emitted cargo event must be schema-shaped with a valid ISO 6346 no.
    cargo = [e for (t, e) in c._published if t == "jnpa.uc2.cargo-events"]
    assert len(cargo) == result["emitted"]
    for env in cargo:
        ev = env["data"]
        assert _valid_iso6346(ev["containerNo"]), ev["containerNo"]
        assert ev["sourceSystem"] == c.source_system
        assert env["specversion"] == "1.0"
        assert env["jnpamode"] == "SYNTHETIC"


@pytest.mark.parametrize("ConnCls", ALL)
def test_health_card_green_in_mock(ConnCls):
    c = ConnCls()
    c.poll()
    h = c.health.to_dict()
    assert h["degradation"] == "GREEN"
    assert h["mode"] == "SYNTHETIC"


@pytest.mark.parametrize("ConnCls", ALL)
def test_fault_injection_flips_health_card(ConnCls):
    c = ConnCls()
    c.health.inject_fault(Degradation.RED)
    c.poll()  # still serves synthetic, but health stays RED (forced)
    assert c.health.to_dict()["degradation"] == "RED"
    # clearing restores GREEN on next poll
    c.health.inject_fault(None)
    c.poll()
    assert c.health.to_dict()["degradation"] == "GREEN"


@pytest.mark.parametrize("ConnCls", ALL)
def test_clearing_a_fault_is_true_immediately_not_after_the_next_poll(ConnCls):
    """UC2-041 — the recovery half of the chaos drill.

    `inject_fault(None)` used to drop the `forced` pin WITHOUT recomputing the
    visible degradation, so a card pinned RED kept reporting RED until something
    else polled it. `POST /inject-fault` returns the card immediately, so the
    operator clearing a fault was told it was still active at the exact moment
    they cleared it. The test above hid this by polling first.
    """
    c = ConnCls()
    c.poll()
    c.health.inject_fault(Degradation.RED)
    assert c.health.to_dict()["degradation"] == "RED"

    c.health.inject_fault(None)  # no poll in between — this is the point

    assert c.health.to_dict()["degradation"] == "GREEN"
    assert c.health.forced is None


def test_clearing_does_not_hide_real_accumulated_errors():
    """Clearing removes the OPERATOR's pin, not the source's actual state.

    A connector that has genuinely failed three times must not come back GREEN
    just because someone cleared a fault they had injected on top of it — that
    would turn the console into a way of hiding an outage.
    """
    h = HealthCard(source_system="ULIP", mode=IntegrationMode.LIVE)
    for _ in range(3):
        h.record_error()
    assert h.to_dict()["degradation"] == "RED"

    h.inject_fault(Degradation.AMBER)
    h.inject_fault(None)

    assert h.to_dict()["degradation"] == "RED"
    assert h.error_count == 3


def test_cleared_card_reports_cached_as_amber():
    """With no pin, the serving tier decides — CACHED is a degraded state."""
    h = HealthCard(source_system="TOS", mode=IntegrationMode.CACHED)
    h.inject_fault(Degradation.RED)
    h.inject_fault(None)
    assert h.to_dict()["degradation"] == "AMBER"


def test_fallback_chain_live_to_cached_to_synthetic():
    health = HealthCard(source_system="ULIP")
    chain = FallbackChain(health, cache_staleness_s=3600)

    calls = {"n": 0}

    def live_ok():
        calls["n"] += 1
        return ["LIVE-DATA"]

    # 1) live succeeds → cache populated, mode LIVE
    val, tier = chain.run(live=live_ok, synthetic=lambda: ["SYN"])
    assert tier.value == "LIVE" and val == ["LIVE-DATA"]
    assert health.mode == IntegrationMode.LIVE

    # 2) live now fails → served from fresh cache
    def live_fail():
        raise SourceUnavailable("down")

    val, tier = chain.run(live=live_fail, synthetic=lambda: ["SYN"])
    assert tier.value == "CACHED" and val == ["LIVE-DATA"]

    # 3) cache expired + live fails → synthetic
    chain.cache_staleness_s = 0
    val, tier = chain.run(live=live_fail, synthetic=lambda: ["SYN"])
    assert tier.value == "SYNTHETIC" and val == ["SYN"]


def test_live_poll_raises_without_credentials():
    # Each connector's live_poll must refuse rather than fake live data.
    with pytest.raises(SourceUnavailable):
        UlipConnector().live_poll()
    with pytest.raises(SourceUnavailable):
        IcegateConnector().live_poll()
