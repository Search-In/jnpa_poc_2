"""ICEGATE / ICES 1.5 connector (prompt §6) — Form13/LEO/e-seal/scan/DPD-ready.
Real client does ICES 1.5 message exchange (IEC + Class-3 DSC). Until onboarded
it serves synthetic. Synthetic emits LEO/CUSTOMS_FLAG/STUFFING events.
"""
from __future__ import annotations

import os
import random

from connectors_common.base import BaseConnector, ConnectorConfig
from connectors_common.fallback import SourceUnavailable
from connectors_common.synth import synth_cargo_event


class IcegateConnector(BaseConnector):
    source_system = "ICEGATE"
    event_types = ["LEO", "CUSTOMS_FLAG", "STUFFING", "DESTUFFING", "ESEAL_AFFIX"]

    def __init__(self, publisher=None, seed: int = 22):
        super().__init__(ConnectorConfig(source_system="ICEGATE"), publisher)
        self._rng = random.Random(seed)
        self._base_url = os.environ.get("ICEGATE_BASE_URL", "")
        self._client_id = os.environ.get("ICEGATE_CLIENT_ID", "")
        self._dsc = os.environ.get("ICEGATE_DSC_THUMBPRINT", "")

    def live_poll(self) -> list[dict]:
        if not (self._base_url and self._client_id and self._dsc):
            raise SourceUnavailable(
                "ICEGATE: needs ICEGATE_BASE_URL + CLIENT_ID + DSC_THUMBPRINT (IEC + Class-3 DSC onboarding)"
            )
        raise SourceUnavailable("ICEGATE: live ICES 1.5 exchange not exercised in PoC build")

    def synthetic_poll(self) -> list[dict]:
        n = self._rng.randint(2, 6)
        evs = []
        for _ in range(n):
            ev = synth_cargo_event(self._rng, "ICEGATE", self._rng.choice(self.event_types))
            if ev["eventType"] == "CUSTOMS_FLAG":
                ev["payload"] = {"selectedForScan": self._rng.random() < 0.5, "dpdReady": self._rng.random() < 0.3}
            evs.append(ev)
        return evs


connector = IcegateConnector()
app = connector.build_app()
