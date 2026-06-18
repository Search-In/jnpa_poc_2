"""IntegrationHealth / Health Card model (prompt §3, §6).

Mirrors the canonical IntegrationHealth entity in @jnpa/schemas. The gateway
aggregates these and the dashboard renders a Health Card per source with the
last good poll, error count, GREEN/AMBER/RED and the active mode badge.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class Degradation(str, Enum):
    GREEN = "GREEN"
    AMBER = "AMBER"
    RED = "RED"


class IntegrationMode(str, Enum):
    LIVE = "LIVE"
    CACHED = "CACHED"
    SYNTHETIC = "SYNTHETIC"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class HealthCard:
    source_system: str
    last_good_poll_ts: Optional[str] = None
    error_count: int = 0
    degradation: Degradation = Degradation.GREEN
    mode: IntegrationMode = IntegrationMode.SYNTHETIC
    note: Optional[str] = None
    # forced fault for demo (Addendum B.1 fault injection); None = no override
    forced: Optional[Degradation] = field(default=None, repr=False)

    def record_success(self, mode: IntegrationMode) -> None:
        self.last_good_poll_ts = _now_iso()
        self.error_count = 0
        self.mode = mode
        self.degradation = self.forced or (
            Degradation.GREEN if mode == IntegrationMode.LIVE else Degradation.AMBER
            if mode == IntegrationMode.CACHED else Degradation.AMBER
        )
        # SYNTHETIC in PoC mock mode is intentionally GREEN (healthy simulator).
        if mode == IntegrationMode.SYNTHETIC and self.forced is None:
            self.degradation = Degradation.GREEN

    def record_error(self) -> None:
        self.error_count += 1
        if self.forced is None:
            self.degradation = Degradation.RED if self.error_count >= 3 else Degradation.AMBER

    def inject_fault(self, level: Optional[Degradation]) -> None:
        """Demo console fault injection — pin to AMBER/RED, or None to clear."""
        self.forced = level
        if level is not None:
            self.degradation = level

    def to_dict(self) -> dict:
        return {
            "sourceSystem": self.source_system,
            "lastGoodPollTs": self.last_good_poll_ts,
            "errorCount": self.error_count,
            "degradation": self.degradation.value,
            "mode": self.mode.value,
            "note": self.note,
        }
