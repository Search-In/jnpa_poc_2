"""TOS connector (prompt §6) — polyglot adapter: EDIFACT + ANSI X12 + REST +
file-drop, per terminal access mode (config/terminals.json). Synthetic emits
CODECO/COARRI/322-style gate + yard events. The real adapter would parse the
terminal's native feed via packages/schemas mappers (mapCodeco / map322 / ...).
"""
from __future__ import annotations

import os
import random

from connectors_common.base import BaseConnector, ConnectorConfig
from connectors_common.fallback import SourceUnavailable
from connectors_common.synth import synth_cargo_event


class TosConnector(BaseConnector):
    source_system = "TOS"
    event_types = ["GATE_IN", "GATE_OUT", "YARD_MOVE", "DAMAGE_FLAG", "ESEAL_AFFIX"]

    def __init__(self, publisher=None, seed: int = 33):
        super().__init__(ConnectorConfig(source_system="TOS"), publisher)
        self._rng = random.Random(seed)
        # one access mode per terminal; defaults document the polyglot intent
        self._modes = {
            "NSICT": os.environ.get("TOS_NSICT_MODE", "EDIFACT"),
            "NSIGT": os.environ.get("TOS_NSIGT_MODE", "REST"),
            "GTI": os.environ.get("TOS_GTI_MODE", "X12"),
            "BMCT": os.environ.get("TOS_BMCT_MODE", "REST"),
            "JNPCT": os.environ.get("TOS_JNPCT_MODE", "FILE_DROP"),
        }

    def live_poll(self) -> list[dict]:
        configured = {t: m for t, m in self._modes.items() if os.environ.get(f"TOS_{t}_URL") or os.environ.get(f"TOS_{t}_DROP_DIR")}
        if not configured:
            raise SourceUnavailable("TOS: no terminal feed configured (set TOS_<terminal>_URL or _DROP_DIR)")
        raise SourceUnavailable("TOS: live terminal feed not exercised in PoC build")

    def synthetic_poll(self) -> list[dict]:
        n = self._rng.randint(4, 10)
        return [synth_cargo_event(self._rng, "TOS", self._rng.choice(self.event_types)) for _ in range(n)]


connector = TosConnector()
app = connector.build_app()
