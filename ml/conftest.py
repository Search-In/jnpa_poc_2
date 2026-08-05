"""
pytest bootstrap.

The seven ``uc2_m*`` modules, the adapter, the pipeline and the service live in
separate folders under ``src/`` but import each other as flat module names. This
puts those folders on ``sys.path`` before collection so the tests keep working
with plain ``import uc2_m1_container_dwell`` / ``import uc2_corpus``.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "pipeline"))

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()
