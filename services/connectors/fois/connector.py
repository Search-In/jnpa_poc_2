"""FOIS / rail connector (prompt §6) — via ULIP track/trace primary, direct
CRIS/FOIS JNPA-facilitated fallback. Emits RAIL_IN/RAIL_OUT events for T1/T2.
Fallback chain: ULIP → CRIS → synthetic.
"""
from __future__ import annotations

import os
import random

from connectors_common.base import BaseConnector, ConnectorConfig
from connectors_common.fallback import SourceUnavailable
from connectors_common.synth import synth_cargo_event


class FoisConnector(BaseConnector):
    source_system = "FOIS"
    event_types = ["RAIL_IN", "RAIL_OUT"]

    def __init__(self, publisher=None, seed: int = 44):
        super().__init__(ConnectorConfig(source_system="FOIS"), publisher)
        self._rng = random.Random(seed)
        self._via_ulip = os.environ.get("FOIS_VIA_ULIP", "true").lower() == "true"
        self._cris_url = os.environ.get("CRIS_FOIS_URL", "")

    def live_poll(self) -> list[dict]:
        # Primary: reach FOIS through the ULIP connector (one fewer credential).
        # Direct CRIS is the JNPA-facilitated fallback.
        if self._via_ulip and not os.environ.get("ULIP_API_KEY"):
            raise SourceUnavailable("FOIS-via-ULIP: needs ULIP onboarding (ULIP_API_KEY)")
        if not self._via_ulip and not self._cris_url:
            raise SourceUnavailable("FOIS: CRIS_FOIS_URL not set (JNPA-facilitated CRIS access)")
        raise SourceUnavailable("FOIS: live rail feed not exercised in PoC build")

    def synthetic_poll(self) -> list[dict]:
        n = self._rng.randint(2, 5)
        evs = []
        for _ in range(n):
            ev = synth_cargo_event(self._rng, "FOIS", self._rng.choice(self.event_types))
            ev["rakeId"] = f"RK-{self._rng.choice(['CONCOR', 'ADANI'])}-{self._rng.randint(100, 999)}"
            ev["facilityId"] = self._rng.choice(["T1", "T2"])
            ev["payload"] = {"sidingId": ev["facilityId"]}
            evs.append(ev)
        return evs


connector = FoisConnector()
app = connector.build_app()
