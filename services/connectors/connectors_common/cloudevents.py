"""CloudEvents 1.0 envelope (prompt §1) — Python side, mirrors packages/sim.

Connectors publish canonical CargoEvents wrapped in this envelope onto the same
Kafka topics the demo console uses, so the dashboard cannot tell sim from live
except via the Health Card mode badge.
"""
from __future__ import annotations

from typing import Any, Optional

TOPICS = {
    "cargo_events": "jnpa.uc2.cargo-events",
    "gate_txns": "jnpa.uc2.gate-transactions",
    "rail": "jnpa.uc2.rail",
    "itrho": "jnpa.uc2.itrho",
    "scans": "jnpa.uc2.scans",
    "notifications": "jnpa.uc2.notifications",
    "integration_health": "jnpa.uc2.integration-health",
    "gate_decisions": "jnpa.uc2.gate-decisions",
    "cross_twin": "jnpa.crosstwin.deferred-arrival",
}

_SOURCE_BASE = "urn:jnpa:uc2"


class CloudEvent(dict):
    """A CloudEvents 1.0 structured-mode JSON envelope (a plain dict subclass)."""


def cargo_event_envelope(ev: dict, mode: str) -> CloudEvent:
    source = (
        f"{_SOURCE_BASE}:sim"
        if mode == "SYNTHETIC"
        else f"{_SOURCE_BASE}:connector:{str(ev.get('sourceSystem', '')).lower()}"
    )
    return CloudEvent(
        {
            "specversion": "1.0",
            "type": f"jnpa.uc2.cargo.{ev['eventType']}",
            "source": source,
            "id": ev["eventId"],
            "time": ev["ts"],
            "subject": ev.get("containerNo"),
            "datacontenttype": "application/json",
            "dataschema": "jnpa:uc2:CargoEvent",
            "data": ev,
            "jnpamode": mode,
        }
    )


def envelope(
    *,
    type: str,
    id: str,
    time: str,
    data: Any,
    subject: Optional[str] = None,
    dataschema: Optional[str] = None,
    mode: Optional[str] = None,
    source_suffix: str = "platform",
) -> CloudEvent:
    return CloudEvent(
        {
            "specversion": "1.0",
            "type": type,
            "source": f"{_SOURCE_BASE}:{source_suffix}",
            "id": id,
            "time": time,
            "subject": subject,
            "datacontenttype": "application/json",
            "dataschema": dataschema,
            "data": data,
            "jnpamode": mode,
        }
    )
