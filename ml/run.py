#!/usr/bin/env python
"""
JNPA UC-II model service — single entry point.

    python run.py uc2                 run all seven UC-2 models, write sample I/O
    python run.py uc2 -m m3           run one UC-2 model
    python run.py uc2 --export        also export the joblib model bundles
    python run.py corpus              inventory the UC-II cargo-handling corpus
    python run.py serve-uc2           start the UC-II FastAPI service on :8200

Everything after the sub-command is passed through unchanged.

WHY THIS IS UC-II ONLY
----------------------
The WS2 delivery ships UC-I and UC-II side by side. Only the UC-II half is
vendored here: this is the UC-2 cargo-handling PoC, and the eight ``uc1_m*``
modules answer vessel-traffic questions no screen in this repo asks. The
delivery's ``models`` / ``predict`` / ``train`` / ``dsr`` / ``serve``
sub-commands drove those modules and are therefore absent rather than left in
place to fail on import.

PORT
----
:8200, not the delivery's :8000 — the POC-3 shared Cargo API already holds
8000 in this repo and `apps/web` proxies `/poc3` at it. Set it explicitly with
``JNPA_PORT`` in dev, in compose and in nginx; two services silently fighting
over a port is a debugging session nobody should have to repeat.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "pipeline"))

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()

COMMANDS = {
    "uc2": ("run_uc2", "run all seven UC-2 models, write sample request/response files"),
    "corpus": ("uc2_corpus", "inventory the UC-II cargo-handling corpus"),
}

# sub-command -> (uvicorn target, default port)
SERVERS = {
    "serve-uc2": ("api_uc2:app", 8200, "UC-II cargo handling"),
}


def _usage() -> int:
    print(__doc__.strip())
    print("\nsub-commands:")
    for name, (_, help_text) in COMMANDS.items():
        print(f"  {name:<11}{help_text}")
    for name, (_, port, label) in SERVERS.items():
        print(f"  {name:<11}start the {label} FastAPI service on :{port}")
    return 2


def main(argv: list) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        return _usage()

    cmd, rest = argv[0], argv[1:]

    if cmd in SERVERS:
        import uvicorn  # imported here so the other commands do not need FastAPI

        target, default_port, _label = SERVERS[cmd]
        host = os.environ.get("JNPA_HOST", "127.0.0.1")
        port = int(os.environ.get("JNPA_PORT", str(default_port)))
        uvicorn.run(target, host=host, port=port, reload="--reload" in rest)
        return 0

    if cmd not in COMMANDS:
        print(f"unknown sub-command {cmd!r}\n")
        return _usage()

    module_name = COMMANDS[cmd][0]
    module = __import__(module_name)
    return int(module.main(rest) or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
