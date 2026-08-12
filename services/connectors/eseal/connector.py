"""Universal e-seal RFID reader connector (prompt §6). Ingests pre-doc RFID
reads and emits ESEAL_AFFIX / ESEAL_BREAK. Fallback: live → cached.
"""
from __future__ import annotations

import os
import random

from typing import Optional

from connectors_common.base import BaseConnector, ConnectorConfig, ReplaySpec
from connectors_common.fallback import SourceUnavailable
from connectors_common.synth import synth_cargo_event


class EsealConnector(BaseConnector):
    source_system = "ESEAL"
    event_types = ["ESEAL_AFFIX", "ESEAL_BREAK"]

    def __init__(self, publisher=None, seed: int = 55):
        super().__init__(ConnectorConfig(source_system="ESEAL"), publisher)
        self._rng = random.Random(seed)
        self._feed_url = os.environ.get("ESEAL_FEED_URL", "")

    def live_poll(self) -> list[dict]:
        if not self._feed_url:
            raise SourceUnavailable("ESEAL: ESEAL_FEED_URL not set (RFID reader feed)")
        raise SourceUnavailable("ESEAL: live RFID feed not exercised in PoC build")

    def replay_spec(self) -> Optional[ReplaySpec]:
        """Containers carrying a real e-seal number stand in for the RFID feed.

        `core.cargo` records `eseal_number` / `eseal_status` per container, which
        is what an e-seal reader produces. Rows WITHOUT a seal number are dropped
        rather than emitted: this reader has nothing to say about a container it
        never read, and an ESEAL event for an unsealed box would be fabrication.
        If no row in the page carries a seal, the tier reports itself unavailable
        and the chain falls through — which is the correct answer, not a failure.
        """
        return ReplaySpec(
            path="/api/cargo",
            event_type=lambda r: (
                "ESEAL_BREAK" if str(r.get("eseal_status") or "").upper() in ("BROKEN", "TAMPERED")
                else "ESEAL_AFFIX"
            ),
            row_filter=lambda r: bool(str(r.get("eseal_number") or "").strip()),
            payload_keys=("eseal_number", "eseal_status"),
        )

    def synthetic_poll(self) -> list[dict]:
        n = self._rng.randint(1, 4)
        evs = []
        for _ in range(n):
            et = "ESEAL_BREAK" if self._rng.random() < 0.15 else "ESEAL_AFFIX"
            ev = synth_cargo_event(self._rng, "ESEAL", et)
            ev["payload"] = {"sealNo": f"ESEAL{self._rng.randint(100000, 999999)}", "tamper": et == "ESEAL_BREAK"}
            evs.append(ev)
        return evs


connector = EsealConnector()
app = connector.build_app()
