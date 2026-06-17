#!/usr/bin/env bash
# ============================================================================
# JNPA UC2 — EC2 user-data bootstrap (Amazon Linux 2023).
# Paste this into the "User data" field when launching the instance, OR run it
# by hand over SSH. It installs Docker + Compose, fetches the repo, writes a
# starter .env, and brings the stack up on port 80.
#
# Two ways to get the code onto the box (pick one — see the EDIT markers below):
#   A) git clone from your repo  (set REPO_URL)
#   B) you scp/rsync the repo to /opt/jnpa-uc2 yourself, then run this
#
# Re-running is safe: it pulls latest and `up -d --build` reconciles.
# ============================================================================
set -euo pipefail

APP_DIR=/opt/jnpa-uc2
# ---- EDIT: set to your git remote, or leave empty if you scp the code in -----
REPO_URL="${REPO_URL:-}"
REPO_BRANCH="${REPO_BRANCH:-main}"

log() { echo "[bootstrap] $*"; }

# --- 1. Docker engine + compose plugin --------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing docker"
  dnf install -y docker git
  systemctl enable --now docker
  usermod -aG docker ec2-user || true
fi

if ! docker compose version >/dev/null 2>&1; then
  log "installing docker compose plugin"
  mkdir -p /usr/local/lib/docker/cli-plugins
  ARCH="$(uname -m)"; case "$ARCH" in aarch64) CARCH=aarch64;; *) CARCH=x86_64;; esac
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${CARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# --- 2. Get the code --------------------------------------------------------
if [ -n "$REPO_URL" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    log "updating existing checkout"
    git -C "$APP_DIR" fetch --depth 1 origin "$REPO_BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$REPO_BRANCH"
  else
    log "cloning $REPO_URL"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  fi
else
  log "REPO_URL empty — expecting code already at $APP_DIR (scp/rsync)"
  [ -f "$APP_DIR/docker-compose.aws.yml" ] || { log "ERROR: $APP_DIR not populated"; exit 1; }
fi

cd "$APP_DIR"

# --- 3. Starter .env (only if missing — never clobbers your secrets) --------
if [ ! -f .env ]; then
  log "creating .env from .env.aws.example (FILL IN SECRETS, then re-run up)"
  cp .env.aws.example .env
  # auto-generate a strong JWT secret so the first boot isn't insecure
  SECRET="$(openssl rand -hex 32)"
  sed -i "s|^JWT_DEV_SECRET=.*|JWT_DEV_SECRET=${SECRET}|" .env
fi

# --- 4. Build + launch ------------------------------------------------------
log "building and starting the stack"
docker compose -f docker-compose.yml -f docker-compose.aws.yml up -d --build

log "done — dashboard on http://<EC2_PUBLIC_IP>/  (give containers ~1-2 min)"
docker compose -f docker-compose.yml -f docker-compose.aws.yml ps
