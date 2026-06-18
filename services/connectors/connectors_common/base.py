"""BaseConnector — FastAPI app factory shared by all six connectors (prompt §6).

Each connector subclasses this and provides:
  - source_system name
  - a `live_poll()` (real contract client; raises SourceUnavailable when no creds)
  - a `synthetic_poll()` (schema-accurate simulator; always works offline)
  - optional `event_types` it emits

The base wires the fallback chain, exposes /health (Health Card), /poll (returns
canonical events through the fallback chain), /inject-fault (demo console), and
publishes onto the event bus via an injected publisher.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from .cloudevents import cargo_event_envelope, TOPICS
from .fallback import FallbackChain, FallbackTier, SourceUnavailable
from .health import Degradation, HealthCard, IntegrationMode


@dataclass
class ConnectorConfig:
    source_system: str
    cache_staleness_s: float = 3600.0
    data_mode: str = os.environ.get("DATA_MODE", "mock")


class FaultRequest(BaseModel):
    level: Optional[str] = None  # "AMBER" | "RED" | null to clear


# A publisher takes (topic, cloud_event) -> None. Default is an in-memory sink
# captured for the connector self-test; production injects a Kafka publisher.
Publisher = Callable[[str, dict], None]


class BaseConnector:
    source_system: str = "TOS"
    event_types: list[str] = ["GATE_IN"]

    def __init__(self, config: ConnectorConfig, publisher: Optional[Publisher] = None):
        self.config = config
        self.health = HealthCard(source_system=config.source_system, mode=IntegrationMode.SYNTHETIC)
        self.chain: FallbackChain = FallbackChain(self.health, config.cache_staleness_s)
        self._published: list[tuple[str, dict]] = []
        self.publisher: Publisher = publisher or (lambda t, e: self._published.append((t, e)))

    # ---- subclass hooks ---------------------------------------------------
    def live_poll(self) -> list[dict]:
        """Real contract client. Raise SourceUnavailable when not onboarded."""
        raise SourceUnavailable(f"{self.source_system}: live source not onboarded")

    def synthetic_poll(self) -> list[dict]:
        """Schema-accurate simulator. Always returns canonical CargoEvent dicts."""
        raise NotImplementedError

    # ---- core -------------------------------------------------------------
    def poll(self) -> dict:
        """Run the fallback chain and publish the resulting events."""
        prefer = FallbackTier.LIVE if self.config.data_mode == "live" else FallbackTier.SYNTHETIC
        live = self.live_poll if self.config.data_mode == "live" else None
        events, tier = self.chain.run(live=live, synthetic=self.synthetic_poll, prefer=prefer)
        mode = tier.value
        for ev in events:
            self.publisher(TOPICS["cargo_events"], cargo_event_envelope(ev, mode))
        self.publisher(TOPICS["integration_health"], {"data": self.health.to_dict()})
        return {"emitted": len(events), "tier": tier.value, "health": self.health.to_dict()}

    # ---- FastAPI app ------------------------------------------------------
    def build_app(self) -> FastAPI:
        app = FastAPI(title=f"JNPA UC2 — {self.source_system} connector")

        @app.get("/health")
        def health() -> dict:
            return self.health.to_dict()

        @app.post("/poll")
        def do_poll() -> dict:
            return self.poll()

        @app.post("/inject-fault")
        def inject_fault(req: FaultRequest) -> dict:
            level = Degradation(req.level) if req.level else None
            self.health.inject_fault(level)
            return self.health.to_dict()

        @app.get("/published")
        def published() -> list[dict]:
            return [{"topic": t, "event": e} for t, e in self._published[-50:]]

        return app
