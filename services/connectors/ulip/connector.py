"""ULIP connector (prompt §6, PRIMARY) — container milestones, gate events,
FOIS rail, Vahan. Real client hits the goulip.in gateway (token issued post-NDA);
until onboarded it raises SourceUnavailable and the chain serves synthetic.

Fallback chain: live → cached (60-min staleness budget) → synthetic.
"""
from __future__ import annotations

import os
import random

from typing import Optional

from connectors_common.base import BaseConnector, ConnectorConfig, ReplaySpec
from connectors_common.fallback import SourceUnavailable
from connectors_common.synth import synth_cargo_event


class UlipConnector(BaseConnector):
    source_system = "ULIP"
    event_types = ["GATE_IN", "GATE_OUT", "RAIL_IN", "RAIL_OUT", "CUSTOMS_FLAG"]

    def __init__(self, publisher=None, seed: int = 11):
        staleness_min = float(os.environ.get("ULIP_CACHE_STALENESS_MIN", "60"))
        super().__init__(
            ConnectorConfig(source_system="ULIP", cache_staleness_s=staleness_min * 60),
            publisher,
        )
        self._rng = random.Random(seed)
        self._base_url = os.environ.get("ULIP_BASE_URL", "")
        self._api_key = os.environ.get("ULIP_API_KEY", "")

    def live_poll(self) -> list[dict]:
        # Real ULIP contract: POST encrypted request to goulip.in gateway, unwrap
        # the {code,message,response[]} envelope, decrypt, map via
        # packages/schemas mapUlipContainerTrack. Requires the post-NDA token.
        if not self._base_url or not self._api_key:
            raise SourceUnavailable("ULIP: ULIP_BASE_URL/ULIP_API_KEY not set — complete NDA onboarding")
        # When credentials are present, an httpx call would go here. We never
        # pretend to have live data in the PoC, so this stays a guarded stub.
        raise SourceUnavailable("ULIP: live call not exercised in PoC build")

    def replay_spec(self) -> Optional[ReplaySpec]:
        """POC-3's cargo lifecycle stream stands in for ULIP track/trace (UC2-041).

        ULIP is a milestone aggregator, and `/api/cargo/events` is precisely a
        per-container milestone stream over the ingested corpus — each row
        carries its OWN event_type, so nothing about the event is inferred. That
        makes it the one register that needs no interpretation to replay.
        """
        return ReplaySpec(
            path="/api/cargo/events",
            event_type=lambda r: str(r.get("event_type") or "CONTAINER_MILESTONE").upper(),
        )

    def synthetic_poll(self) -> list[dict]:
        n = self._rng.randint(3, 8)
        return [synth_cargo_event(self._rng, "ULIP", self._rng.choice(self.event_types)) for _ in range(n)]


connector = UlipConnector()
app = connector.build_app()
