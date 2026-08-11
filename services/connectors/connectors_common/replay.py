"""POC-3 row → canonical CargoEvent mapping (ticket UC2-041).

The connectors emit one shape — the canonical CargoEvent that `synth.py`
generates and `cloudevents.py` envelopes — and downstream cannot tell which tier
produced it except by the `jnpamode` on the envelope and the Health Card. That is
deliberate, and it means the replay tier has to land in the SAME shape.

The mapping is defensive on purpose. POC-3 serves several registers whose row
shapes differ (`core.cargo` spells it `container_number`, CODECO movements spell
it `container_no`, the lifecycle-event stream carries `event_type` of its own),
and a mapper that assumed one spelling would emit events with a null container
number the moment it was pointed at a different register. So keys are looked up
across the spellings that actually occur, and a row that yields no usable
container number is DROPPED rather than emitted with a hole in it.

If no row in the page survives, the caller raises SourceUnavailable and the chain
falls through. An event nobody can trace to a container is worse than no event:
it would count towards `emitted`, appear on /published, and be untraceable.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional, Union

from .fallback import SourceUnavailable
from .synth import check_digit

_ISO6346 = re.compile(r"^[A-Z]{3}[UJZ]\d{7}$")

# The spellings that actually occur across the POC-3 registers, in priority order.
_CONTAINER_KEYS = ("container_no", "container_number", "containerNo", "container")
_TS_KEYS = (
    "event_ts", "created_at", "gate_pass_ts", "arrival_ts", "receipt_date",
    "movement_ts", "movement_date", "processing_end_date", "ts", "updated_at", "date",
)
_FACILITY_KEYS = (
    "terminal_code", "terminal_id", "terminal", "facility_id", "facility",
    "yard_block", "scan_location", "location",
)
_VEHICLE_KEYS = ("vehicle_number", "vehicle_no", "truck_no", "vehicle")
_GATE_KEYS = ("gate_id", "gate_no", "gate")

EventTypeFor = Union[str, Callable[[dict], str]]


def valid_iso6346(value: Any) -> bool:
    """True for a well-formed container number with a correct check digit.

    The check digit is verified, not just the pattern: POC-3 holds real corpus
    rows and also rows typed by hand into the console, and only the check digit
    separates them. A replayed event carrying a number that cannot exist would
    fail the same validation the synthetic tier passes, which would make the live
    tier look *less* trustworthy than the simulator.
    """
    s = str(value or "").strip().upper()
    if not _ISO6346.match(s):
        return False
    return int(s[10]) == check_digit(s[:10])


def _first(row: dict, keys: Iterable[str]) -> Optional[Any]:
    for k in keys:
        v = row.get(k)
        if v not in (None, "", []):
            return v
    return None


def _iso(value: Any) -> Optional[str]:
    """Normalise a POC-3 timestamp to ISO-8601, or None if it is not one."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        # Postgres/asyncpg render as '2026-06-15T09:00:00+00:00' or with a 'Z'.
        return datetime.fromisoformat(s.replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def rows_to_events(
    rows: list[dict],
    source_system: str,
    event_type: EventTypeFor,
    upstream_path: str,
    limit: Optional[int] = None,
    row_filter: Optional[Callable[[dict], bool]] = None,
    payload_keys: tuple[str, ...] = (),
) -> list[dict]:
    """Map a POC-3 page onto canonical CargoEvents.

    `event_type` is either a fixed string or a per-row function, because some
    registers carry their own type (the lifecycle-event stream) while others
    imply one (a CODECO movement is a gate event).

    `row_filter` drops rows a source genuinely does not cover — the e-seal reader
    only has something to say about a container that carries a seal number, and
    emitting an ESEAL event for one that does not would be fabrication.

    `payload_keys` copies register-specific fields onto the event payload so the
    published event still names where each fact came from.

    Raises SourceUnavailable when nothing usable survives — see the module note.
    """
    polled_at = datetime.now(timezone.utc).isoformat()
    events: list[dict] = []

    for row in rows:
        if row_filter is not None and not row_filter(row):
            continue
        cn = _first(row, _CONTAINER_KEYS)
        if not valid_iso6346(cn):
            continue
        cn = str(cn).strip().upper()
        et = event_type(row) if callable(event_type) else event_type

        ts_key = next((k for k in _TS_KEYS if _iso(row.get(k))), None)
        ts = _iso(row.get(ts_key)) if ts_key else None
        facility = _first(row, _FACILITY_KEYS)
        vehicle = _first(row, _VEHICLE_KEYS)
        gate = _first(row, _GATE_KEYS)

        # Stable id: same row replayed twice is the same event, so a consumer can
        # de-duplicate. No randomness and no wall clock in the key.
        row_key = row.get("id") or row.get("pk") or f"{ts or 'nots'}:{et}"
        events.append({
            "eventId": f"{source_system}:poc3:{cn}:{et}:{row_key}",
            "containerNo": cn,
            "eventType": et,
            # A row with no timestamp of its own is stamped with the poll instant,
            # and `tsSource` below says so. Back-dating it to something plausible
            # would put an invented time on a real container.
            "ts": ts or polled_at,
            "sourceOffsetMin": 330,
            "facilityId": str(facility) if facility else None,
            "terminalId": str(facility) if facility else None,
            "gateId": str(gate) if gate else None,
            "vehicleNo": str(vehicle) if vehicle else None,
            "rakeId": None,
            "sourceSystem": source_system,
            "rawRef": f"poc3{upstream_path}#{row_key}",
            "payload": {
                "replay": True,
                "upstreamPath": upstream_path,
                "tsSource": ts_key or "poll-time (row carried no timestamp)",
                **{k: row.get(k) for k in payload_keys if row.get(k) is not None},
            },
        })
        if limit is not None and len(events) >= limit:
            break

    if not events:
        raise SourceUnavailable(
            f"POC-3: {upstream_path} returned {len(rows)} rows, none with a valid container number"
        )
    return events
