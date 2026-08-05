# JNPA UC-II AI/ML model service — the seven WS2 models behind one HTTP surface.
# Tender ref GeM/2026/B/7297343.
#
# Two-stage on purpose. The build stage runs every model's own self-test and the
# fan-out's, so THE IMAGE FAILS TO BUILD IF THE MODELS DISAGREE WITH THEMSELVES.
# A model whose published claims no longer hold is a worse outcome than no
# deploy: it serves numbers an operator will act on, and nothing downstream can
# tell that it drifted.

# ---------------------------------------------------------------------------
# Stage 1 — verify
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS verify

WORKDIR /build

COPY requirements-service.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements-dev.txt

COPY . .

# The corpus is deliberately NOT in the image (see data/corpus/README.md): it is
# 43 MB of read-only source documents that no request path reads. The models
# degrade visibly without it and badge `degraded: true`, which is exactly what
# the checks below tolerate — while still failing on any NON-corpus regression.
ENV PYTHONPATH=/build/src/pipeline:/build/src/uc2_models:/build/src/service

# Every module's self-test: the seven models, the translation layer and the
# fan-out. The fan-out's carries the glossary gate, so a field added without a
# definition fails the build here rather than reaching an operator as an
# unexplained number.
#
# Run through selftest_gate.py rather than each module's own `--selftest` CLI.
# A bare CLI run is red in this image for a reason that is intended: the corpus
# is excluded, and 12 checks across six models can only pass with it. The gate
# exempts EXACTLY those, by matching each module's own failure text, PRINTS what
# it exempted, and still fails the build on anything else. tests/ imports the
# same module, so the build and the test suite cannot disagree about what
# "passing" means here.
RUN python tools/selftest_gate.py

# The contract tests a module cannot write about itself.
RUN python -m pytest -q

# The app must actually import — a router that fails to mount is a 404 at
# runtime, which is a much worse place to find out.
RUN python -c "import api_uc2; \
    assert len(api_uc2.MOUNTED) == len(api_uc2.MODULE_SPECS), api_uc2.IMPORT_FAILURES; \
    assert not api_uc2.MOUNT_FAILURES, api_uc2.MOUNT_FAILURES; \
    print('mounted', len(api_uc2.MOUNTED), 'modules')"

# ---------------------------------------------------------------------------
# Stage 2 — serve
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS serve

WORKDIR /app

# Runtime-only dependency subset. Every omission names the fallback it triggers
# — see requirements-service.txt.
COPY requirements-service.txt ./
RUN pip install --no-cache-dir -r requirements-service.txt

COPY run.py ./
COPY src ./src
COPY data ./data
COPY out ./out
COPY trained_models ./trained_models

ENV PYTHONPATH=/app/src/pipeline:/app/src/uc2_models:/app/src/service \
    PYTHONUNBUFFERED=1 \
    JNPA_HOST=0.0.0.0 \
    JNPA_PORT=8200

# 8200, not the delivery's 8000: POC-3's Cargo API holds 8000 in this stack.
# Set explicitly rather than left to a default, so nothing silently collides.
EXPOSE 8200

# No published port in compose and no auth on this service: it is reachable only
# through nginx's /ml-api on the private network. See apps/web/nginx.conf.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8200/health', timeout=8)"

CMD ["python", "run.py", "serve-uc2"]
