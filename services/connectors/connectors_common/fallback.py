"""Fallback chain (prompt §6, bid §8.4.3): live → cached → synthetic.

The chain tries each tier in order; on failure it falls through and updates the
Health Card so the dashboard shows the active mode. A cached tier honours a
staleness budget (e.g. ULIP 60 min) beyond which it is skipped.

⚠ UC2-041 — the middle tier used to be unreachable.
The cache was written in exactly one place, inside the LIVE branch, and no
connector had a live poll that could succeed (every one raises SourceUnavailable
until its source is onboarded). So the cache was never populated and CACHED was
never served. Measured across every configuration the stack can boot in, the tier
was SYNTHETIC five polls out of five, in all three of them. A "LIVE→CACHED→
SYNTHETIC drill" on that would have shown SYNTHETIC three times.

Two changes make the drill real, and neither invents data:

1. A live tier that actually answers — `connectors_common/poc3.py`, a real
   authenticated read of the ingested corpus. That is what finally writes the
   cache, which is what makes CACHED reachable at all.
2. Fault injection now drives the whole chain rather than only the traffic light.
   AMBER means "cannot get fresh data" → live is blocked and the cache serves.
   RED means "this source is down and not to be trusted" → the cache is refused
   too, because replaying an outage-era payload as if it were current is the
   specific dishonesty the fallback story exists to avoid; the simulator takes
   over and says so.

So one control walks all three tiers: GREEN → LIVE, AMBER → CACHED, RED →
SYNTHETIC. Without a live upstream configured, tier one simply never succeeds and
the connector behaves exactly as it did before — SYNTHETIC throughout, honestly.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Generic, Optional, TypeVar

from .health import Degradation, HealthCard, IntegrationMode

T = TypeVar("T")

#: What the health card says produced a synthetic payload.
SIMULATOR = "built-in simulator"


def _joined(reason: str, live_error: Optional[str]) -> str:
    """The tier's own explanation, plus why the tier above it could not serve."""
    return f"{reason} Live tier: {live_error}" if live_error else reason


class SourceUnavailable(Exception):
    """Raised by a tier when it cannot serve."""


class FallbackTier(str, Enum):
    LIVE = "LIVE"
    CACHED = "CACHED"
    SYNTHETIC = "SYNTHETIC"


@dataclass
class _CacheEntry(Generic[T]):
    value: T
    stored_at: float
    #: The upstream that produced this payload, carried so a CACHED poll can name
    #: it. A replay of ULIP's data must still say it came from ULIP's upstream.
    upstream: Optional[str] = None


class FallbackChain(Generic[T]):
    """Three-tier fallback with a cache + staleness budget.

    Usage:
        chain = FallbackChain(health, cache_staleness_s=3600)
        result = chain.run(live=fn_live, synthetic=fn_synthetic)
    """

    def __init__(self, health: HealthCard, cache_staleness_s: float = 3600.0):
        self.health = health
        self.cache_staleness_s = cache_staleness_s
        self._cache: Optional[_CacheEntry[T]] = None
        self._clock = time.monotonic

    def cache_age_s(self) -> Optional[float]:
        """How old the cached payload is, or None when there is no cache."""
        return None if self._cache is None else self._clock() - self._cache.stored_at

    def _cache_fresh(self) -> bool:
        age = self.cache_age_s()
        return age is not None and age <= self.cache_staleness_s

    def run(
        self,
        live: Optional[Callable[[], T]],
        synthetic: Callable[[], T],
        prefer: FallbackTier = FallbackTier.LIVE,
        upstream_label: Optional[Callable[[], Optional[str]]] = None,
    ) -> tuple[T, FallbackTier]:
        """Serve the best tier available and record on the card which one it was.

        `upstream_label` is read AFTER a successful live call, not before: a
        connector may try several upstreams in turn (its own production API, then
        the replay reader) and only knows which one answered once one has.
        """
        forced = self.health.forced
        # Why the live tier could not serve, carried down the chain. Losing this
        # was a real defect: the synthetic branch used to overwrite `note` with a
        # generic line, so an operator saw "generating from the simulator" and
        # nothing about whether the source needed a token, was unreachable, or had
        # rejected the credentials. The tier is the symptom; this is the cause.
        live_error: Optional[str] = None
        # AMBER = degraded: no fresh read, fall to the cache.
        # RED   = down/untrusted: refuse the cache too — see the module note.
        live_blocked = forced in (Degradation.AMBER, Degradation.RED)
        cache_blocked = forced == Degradation.RED

        if prefer == FallbackTier.LIVE and live is not None and not live_blocked:
            try:
                value = live()
                label = upstream_label() if upstream_label else None
                self._cache = _CacheEntry(value, self._clock(), label)
                self.health.record_success(IntegrationMode.LIVE, upstream=label)
                self.health.note = f"Live read from {label}." if label else None
                return value, FallbackTier.LIVE
            except SourceUnavailable as exc:
                self.health.record_error()
                live_error = str(exc)

        # cached tier — last-known-good, with its TRUE age on the card. The age is
        # the point: an operator has to be able to see how stale the number they
        # are looking at is, not merely that it is stale.
        if not cache_blocked and self._cache_fresh() and self._cache is not None:
            age = int(self.cache_age_s() or 0)
            self.health.record_success(IntegrationMode.CACHED, upstream=self._cache.upstream)
            self.health.note = _joined(
                f"Serving last-known-good from {self._cache.upstream or 'the previous live read'}, "
                f"{age}s old (budget {int(self.cache_staleness_s)}s).",
                live_error,
            )
            return self._cache.value, FallbackTier.CACHED

        # synthetic tier (always available — schema-accurate simulator)
        value = synthetic()
        self.health.record_success(IntegrationMode.SYNTHETIC, upstream=SIMULATOR)
        if cache_blocked and self._cache is not None:
            reason = ("Source marked down — cached payload refused rather than replayed as "
                      "current; generating from the simulator.")
        elif self._cache is None:
            reason = "No live upstream has answered yet; generating from the simulator."
        else:
            age = int(self.cache_age_s() or 0)
            reason = (f"Cache stale ({age}s > budget {int(self.cache_staleness_s)}s); "
                      "generating from the simulator.")
        self.health.note = _joined(reason, live_error)
        return value, FallbackTier.SYNTHETIC
