"""Schema-accurate synthetic generators for the Python connectors (prompt §6).

These produce canonical CargoEvent dicts (and source-native payloads) that match
@jnpa/schemas exactly, with valid ISO 6346 container numbers. Deterministic given
a seed so connector self-tests and demos are repeatable.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

# ISO 6346 letter-value table (A=10, skip multiples of 11).
_LETTER_VALUES: dict[str, int] = {}
_v = 10
for _i in range(26):
    if _v % 11 == 0:
        _v += 1
    _LETTER_VALUES[chr(65 + _i)] = _v
    _v += 1


def check_digit(prefix10: str) -> int:
    s = 0
    for i, ch in enumerate(prefix10):
        base = _LETTER_VALUES[ch] if ch.isalpha() else int(ch)
        s += base * (2 ** i)
    r = s % 11
    return 0 if r == 10 else r


def container_no(rng: random.Random) -> str:
    owner = rng.choice(["MAE", "MSC", "CMA", "HLC", "ONE", "COS"])
    serial = f"{rng.randint(100000, 999999)}"
    prefix = f"{owner}U{serial}"
    return prefix + str(check_digit(prefix))


_FACILITIES = ["NSICT", "NSIGT", "GTI", "BMCT", "JNPCT"]
_GATES = {"NSICT": "NSICT-G1", "GTI": "GTI-G2", "BMCT": "BMCT-G1", "NSIGT": "NSIGT-G1", "JNPCT": "JNPCT-G1"}


def synth_cargo_event(rng: random.Random, source_system: str, event_type: str) -> dict:
    """Build one canonical CargoEvent dict tagged with the given source."""
    cn = container_no(rng)
    facility = rng.choice(_FACILITIES)
    ts = (datetime.now(timezone.utc) - timedelta(minutes=rng.randint(0, 120))).isoformat()
    eid = f"{source_system}:synth:{cn}:{event_type}:{rng.randint(0, 10**9)}"
    return {
        "eventId": eid,
        "containerNo": cn,
        "eventType": event_type,
        "ts": ts,
        "sourceOffsetMin": 330,
        "facilityId": facility,
        "terminalId": facility,
        "gateId": _GATES.get(facility) if event_type in ("GATE_IN", "GATE_OUT") else None,
        "vehicleNo": f"MH04AB{rng.randint(1000, 9999)}" if event_type in ("GATE_IN", "GATE_OUT") else None,
        "rakeId": None,
        "sourceSystem": source_system,
        "rawRef": f"raw/{source_system.lower()}/synth/{cn}-{event_type}",
        "payload": {"synthetic": True},
    }
