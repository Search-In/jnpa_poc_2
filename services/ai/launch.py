"""AI service launcher (docker entrypoint). Model directories use hyphens
(`dwell-predictor`) which aren't importable as Python packages, so we load the
model file by path and serve its `app` (or build one for the anomaly detector)
with uvicorn. AI_MODEL selects the directory.
"""
import importlib.util
import os
import sys

import uvicorn

MODEL = os.environ.get("AI_MODEL", "dwell-predictor")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # so `_common` imports resolve

path = os.path.join(HERE, MODEL, "model.py")
spec = importlib.util.spec_from_file_location(MODEL.replace("-", "_") + "_model", path)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

app = mod.app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("AI_PORT", "8200")))
