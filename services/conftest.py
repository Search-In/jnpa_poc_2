"""Pytest bootstrap: make `_common` (shared connector framework) importable as a
top-level package from any connector/test, mirroring the runtime PYTHONPATH set
in docker-compose (PYTHONPATH=/app/services/connectors).
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for sub in ("connectors", "ai"):
    p = os.path.join(_HERE, sub)
    if p not in sys.path:
        sys.path.insert(0, p)
