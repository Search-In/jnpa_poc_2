"""ICEGATE / ICES 1.5 connector (prompt §6) — Form13/LEO/e-seal/scan/DPD-ready.
Real client does ICES 1.5 message exchange (IEC + Class-3 DSC). Until onboarded
it serves synthetic. Synthetic emits LEO/CUSTOMS_FLAG/STUFFING events.
"""
from __future__ import annotations

import os
import random

from connectors_common.base import BaseConnector, ConnectorConfig
from connectors_common.fallback import SourceUnavailable
from connectors_common.poc3 import DEFAULT_LIMIT
from connectors_common.replay import rows_to_events
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

    def replay_poll(self) -> list[dict]:
        """Walk a real IGM the way the dashboard does — manifest, then containers.

        Two hops rather than a ReplaySpec, because customs' container-level facts
        live UNDER a manifest: there is no one-shot route that returns customs
        rows keyed by container. `/api/customs/igm` gives a real manifest number
        and `/api/customs/igm/{no}/containers` gives the containers declared on
        it, which is exactly the path `Igm.tsx` drills through.

        `CUSTOMS_FLAG` is the closest type in this connector's declared
        vocabulary for "customs holds a record against this container". The
        payload and rawRef name the register outright so the reading is never
        hidden behind the label.
        """
        manifests = self.poc3.rows("/api/customs/igm", {"limit": 1})
        igm_no = str(manifests[0].get("igm_no") or "").strip()
        if not igm_no:
            raise SourceUnavailable("POC-3: /api/customs/igm returned a manifest with no igm_no")
        path = f"/api/customs/igm/{igm_no}/containers"
        rows = self.poc3.rows(path, {"limit": DEFAULT_LIMIT})
        return rows_to_events(
            rows, self.source_system, "CUSTOMS_FLAG", path, limit=DEFAULT_LIMIT,
            payload_keys=("igm_no", "seal_no", "container_status", "container_agent_code"),
        )

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
