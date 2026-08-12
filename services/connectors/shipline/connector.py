"""Shipping-line connector (prompt §6) — IAL/EAL, D/O, empty-pool inventory
(line portals / EDI). Emits gate-relevant status + documentary events. Fallback:
live → cached. Synthetic emits a mix of GATE_OUT and YARD_MOVE plus doc payloads.
"""
from __future__ import annotations

import os
import random

from typing import Optional

from connectors_common.base import BaseConnector, ConnectorConfig, ReplaySpec
from connectors_common.fallback import SourceUnavailable
from connectors_common.synth import synth_cargo_event


class ShiplineConnector(BaseConnector):
    source_system = "SHIPLINE"
    event_types = ["GATE_OUT", "YARD_MOVE"]

    def __init__(self, publisher=None, seed: int = 66):
        super().__init__(ConnectorConfig(source_system="SHIPLINE"), publisher)
        self._rng = random.Random(seed)
        self._urls = {
            "MAERSK": os.environ.get("SHIPLINE_MAERSK_URL", ""),
            "MSC": os.environ.get("SHIPLINE_MSC_URL", ""),
            "CMACGM": os.environ.get("SHIPLINE_CMACGM_URL", ""),
        }

    def live_poll(self) -> list[dict]:
        if not any(self._urls.values()):
            raise SourceUnavailable("SHIPLINE: no line portal configured (SHIPLINE_<line>_URL)")
        raise SourceUnavailable("SHIPLINE: live line feed not exercised in PoC build")

    def replay_spec(self) -> Optional[ReplaySpec]:
        """The EAL export advance list stands in for the line portals (UC2-041).

        An advance list is issued by the shipping line — it is the line's own
        declaration of what it intends to load — so it is the right register for
        this source. 5,743 rows are ingested.

        ⚠ `LOAD_DECLARED`, not GATE_OUT or YARD_MOVE: a load-list entry is an
        intention, and no container has moved because it appears on one.
        """
        return ReplaySpec(
            path="/api/export-chain/load-list",
            event_type="LOAD_DECLARED",
            payload_keys=("list_type", "iso_code", "pol", "pod", "freight_kind"),
        )

    def synthetic_poll(self) -> list[dict]:
        n = self._rng.randint(2, 6)
        return [synth_cargo_event(self._rng, "SHIPLINE", self._rng.choice(self.event_types)) for _ in range(n)]


connector = ShiplineConnector()
app = connector.build_app()
