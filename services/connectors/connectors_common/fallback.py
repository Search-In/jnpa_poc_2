"""Fallback chain (prompt §6, bid §8.4.3): live → cached → synthetic.

The chain tries each tier in order; on failure it falls through and updates the
Health Card so the dashboard shows the active mode. A cached tier honours a
staleness budget (e.g. ULIP 60 min) beyond which it is skipped.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Generic, Optional, TypeVar

from .health import Degradation, HealthCard, IntegrationMode

T = TypeVar("T")


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

    def _cache_fresh(self) -> bool:
        if self._cache is None:
            return False
        return (self._clock() - self._cache.stored_at) <= self.cache_staleness_s

    def run(
        self,
        live: Optional[Callable[[], T]],
        synthetic: Callable[[], T],
        prefer: FallbackTier = FallbackTier.LIVE,
    ) -> tuple[T, FallbackTier]:
        # If a fault is pinned RED, skip live entirely (demo fault injection).
        live_blocked = self.health.forced == Degradation.RED

        if prefer == FallbackTier.LIVE and live is not None and not live_blocked:
            try:
                value = live()
                self._cache = _CacheEntry(value, self._clock())
                self.health.record_success(IntegrationMode.LIVE)
                return value, FallbackTier.LIVE
            except SourceUnavailable:
                self.health.record_error()

        # cached tier
        if self._cache_fresh() and self._cache is not None:
            self.health.record_success(IntegrationMode.CACHED)
            return self._cache.value, FallbackTier.CACHED

        # synthetic tier (always available — schema-accurate simulator)
        value = synthetic()
        self.health.record_success(IntegrationMode.SYNTHETIC)
        return value, FallbackTier.SYNTHETIC
