"""Shared connector framework for JNPA UC2 (prompt §6).

Every connector = real contract client + PoC simulator + fallback chain +
Health Card. This package provides the reusable machinery so each connector
file only declares its source-specific client + simulator + mapping.
"""
from .health import HealthCard, Degradation, IntegrationMode
from .fallback import FallbackChain, FallbackTier, SourceUnavailable
from .cloudevents import CloudEvent, cargo_event_envelope, TOPICS
from .base import BaseConnector, ConnectorConfig

__all__ = [
    "HealthCard",
    "Degradation",
    "IntegrationMode",
    "FallbackChain",
    "FallbackTier",
    "SourceUnavailable",
    "CloudEvent",
    "cargo_event_envelope",
    "TOPICS",
    "BaseConnector",
    "ConnectorConfig",
]
