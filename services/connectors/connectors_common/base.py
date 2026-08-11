"""BaseConnector — FastAPI app factory shared by all six connectors (prompt §6).

Each connector subclasses this and provides:
  - source_system name
  - a `live_poll()` (real contract client; raises SourceUnavailable when no creds)
  - a `synthetic_poll()` (schema-accurate simulator; always works offline)
  - optional `event_types` it emits

The base wires the fallback chain, exposes /health (Health Card), /poll (returns
canonical events through the fallback chain), /inject-fault (demo console), and
publishes onto the event bus via an injected publisher.

UC2-041 adds two things to that list:

  - a SECOND live upstream behind each connector's own — `connectors_common/
    poc3.py`, a real authenticated read of the ingested corpus. `live_poll()` is
    tried first and is untouched; the replay reader is only reached when the
    source's real API is not onboarded, which today is all six of them. This is
    what finally writes the fallback cache and so makes the CACHED tier reachable
    at all. Which upstream answered is recorded on the card, never blurred.
  - `POST /drill` — the rehearsal itself, run server-side and returned as a
    transcript. See `run_drill`.
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
from .poc3 import DEFAULT_LIMIT, Poc3Client
from .replay import EventTypeFor, rows_to_events


@dataclass
class ConnectorConfig:
    source_system: str
    cache_staleness_s: float = 3600.0
    data_mode: str = os.environ.get("DATA_MODE", "mock")


@dataclass
class ReplaySpec:
    """Which POC-3 register stands in for this source's live feed, and as what.

    `path` is a real POC-3 route holding ingested corpus rows; `event_type` is
    either fixed or derived per row. A connector with no ingested counterpart
    leaves this None and stays honestly SYNTHETIC — inventing a register for it
    would be worse than an amber card.
    """
    path: str
    event_type: EventTypeFor
    params: Optional[dict] = None
    #: Drop rows this source genuinely does not cover (see EsealConnector).
    row_filter: Optional[Callable[[dict], bool]] = None
    #: Register-specific fields to carry onto the published event's payload, so a
    #: consumer can see what the row actually said rather than only our reading.
    payload_keys: tuple[str, ...] = ()


class FaultRequest(BaseModel):
    level: Optional[str] = None  # "AMBER" | "RED" | null to clear
    #: Run one poll after setting the fault so the returned card reflects an
    #: ACTUAL poll under the injected condition rather than a pinned colour. This
    #: is what lets the console show the tier move LIVE→CACHED→SYNTHETIC as the
    #: operator drags the control. Set false to pin without re-polling.
    repoll: bool = True


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
        self.poc3 = Poc3Client()
        #: Set by `_live_tier` to whichever upstream actually answered; read by
        #: the chain AFTER the call, so a card can never name an upstream that
        #: did not serve it.
        self._last_upstream: Optional[str] = None

    # ---- subclass hooks ---------------------------------------------------
    def live_poll(self) -> list[dict]:
        """Real contract client. Raise SourceUnavailable when not onboarded."""
        raise SourceUnavailable(f"{self.source_system}: live source not onboarded")

    def synthetic_poll(self) -> list[dict]:
        """Schema-accurate simulator. Always returns canonical CargoEvent dicts."""
        raise NotImplementedError

    def replay_spec(self) -> Optional[ReplaySpec]:
        """The POC-3 register that stands in for this source. None = no counterpart."""
        return None

    # ---- the live tier ----------------------------------------------------
    def replay_poll(self) -> list[dict]:
        """Read this source's register from POC-3 and map it to CargoEvents."""
        spec = self.replay_spec()
        if spec is None:
            raise SourceUnavailable(
                f"{self.source_system}: no ingested POC-3 register stands in for this source"
            )
        # Ask for more rows than we emit when a filter will thin them, so a
        # register where only some rows are relevant can still fill one poll.
        fetch = DEFAULT_LIMIT * (4 if spec.row_filter else 1)
        rows = self.poc3.rows(spec.path, {"limit": fetch, **(spec.params or {})})
        return rows_to_events(
            rows, self.source_system, spec.event_type, spec.path,
            limit=DEFAULT_LIMIT, row_filter=spec.row_filter, payload_keys=spec.payload_keys,
        )

    def _live_tier(self) -> list[dict]:
        """The source's own API first, the POC-3 replay second.

        Order matters and is not negotiable: when JNPA finally onboards a source,
        that source's real feed must win without anyone editing this file. The
        replay reader exists to make the fallback chain demonstrable in the
        meantime, not to stand in front of a real integration.

        Both failure reasons are kept in the raised message, because "ULIP needs
        an NDA token" and "POC-3 refused the login" are different problems and an
        operator staring at an amber card needs to know which one they have.
        """
        try:
            events = self.live_poll()
            self._last_upstream = f"{self.source_system} production API"
            return events
        except SourceUnavailable as own:
            try:
                events = self.replay_poll()
                self._last_upstream = self.poc3.label()
                return events
            except SourceUnavailable as replay:
                self._last_upstream = None
                raise SourceUnavailable(f"{own}  |  {replay}") from replay

    def _prefer(self) -> FallbackTier:
        """Try the live tier when there is anything live to try.

        DATA_MODE=live is one way in; a configured POC-3 replay reader is the
        other, and configuring it IS the opt-in. With neither, `prefer` stays
        SYNTHETIC and the connector behaves exactly as it did before this ticket.
        """
        live_configured = self.config.data_mode == "live" or self.poc3.configured
        return FallbackTier.LIVE if live_configured else FallbackTier.SYNTHETIC

    # ---- core -------------------------------------------------------------
    def poll(self) -> dict:
        """Run the fallback chain and publish the resulting events."""
        prefer = self._prefer()
        live = self._live_tier if prefer == FallbackTier.LIVE else None
        events, tier = self.chain.run(
            live=live,
            synthetic=self.synthetic_poll,
            prefer=prefer,
            upstream_label=lambda: self._last_upstream,
        )
        mode = tier.value
        for ev in events:
            self.publisher(TOPICS["cargo_events"], cargo_event_envelope(ev, mode))
        self.publisher(TOPICS["integration_health"], {"data": self.health.to_dict()})
        return {"emitted": len(events), "tier": tier.value, "health": self.health.to_dict()}

    # ---- the chaos rehearsal (UC2-041) ------------------------------------
    def run_drill(self) -> dict:
        """Walk the whole fallback chain and return what actually happened.

        Four real polls, each under a real injected condition — no narration and
        no expected-value substitution. `matched` compares the tier the step was
        designed to reach against the tier that served, and a step that did not
        reach its tier is reported as such rather than quietly relabelled. On a
        laptop with no POC-3 credentials every step lands on SYNTHETIC and the
        transcript says so plainly; that is a true statement about the deployment
        and is more useful than a green tick.

        The connector is left as it was found: the fault is cleared on the last
        step whatever happened on the ones before it.
        """
        steps: list[dict] = []
        live_configured = self.poc3.configured or self.config.data_mode == "live"

        def step(name: str, level: Optional[Degradation], expect: FallbackTier, why: str) -> None:
            self.health.inject_fault(level)
            result = self.poll()
            steps.append({
                "step": name,
                "injected": level.value if level else None,
                "expectedTier": expect.value,
                "tier": result["tier"],
                # A step only demonstrates something if the chain could actually
                # MOVE. With no live upstream every tier is SYNTHETIC, so the
                # outage step would land on SYNTHETIC and tick green without the
                # chain having fallen anywhere — a rehearsal that passes on an
                # unconfigured laptop and fails in the room.
                "matched": live_configured and result["tier"] == expect.value,
                "emitted": result["emitted"],
                "mode": result["health"]["mode"],
                "degradation": result["health"]["degradation"],
                "upstream": result["health"]["upstream"],
                "note": result["health"]["note"],
                "why": why,
            })

        step("1 · baseline", None, FallbackTier.LIVE,
             "No fault. The live upstream should answer and fill the cache.")
        step("2 · degrade", Degradation.AMBER, FallbackTier.CACHED,
             "Source degraded: no fresh read, so the last-known-good payload serves with its true age.")
        step("3 · outage", Degradation.RED, FallbackTier.SYNTHETIC,
             "Source down: the cache is refused rather than replayed as current; the simulator takes over.")
        step("4 · recover", None, FallbackTier.LIVE,
             "Fault cleared. The live upstream should answer again on the very next poll.")

        return {
            "sourceSystem": self.source_system,
            "liveUpstreamConfigured": live_configured,
            "steps": steps,
            "allMatched": all(s["matched"] for s in steps),
        }

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
            if req.repoll:
                # Return the card as an ACTUAL poll under this condition leaves
                # it, so the caller sees the tier that really served rather than
                # the colour that was requested.
                return self.poll()["health"]
            return self.health.to_dict()

        @app.post("/drill")
        def drill() -> dict:
            return self.run_drill()

        @app.get("/published")
        def published() -> list[dict]:
            return [{"topic": t, "event": e} for t, e in self._published[-50:]]

        return app
