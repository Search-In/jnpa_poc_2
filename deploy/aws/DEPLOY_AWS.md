# Deploying JNPA UC2 on AWS — single EC2 (cheapest demo)

This is the **manual, AWS-side runbook**. All the application config (web image +
nginx, the AWS compose overlay, the bootstrap script) already lives in the repo —
this doc covers only what you do in the AWS console / CLI.

**What you get:** one EC2 instance running the whole stack via `docker compose`,
with nginx serving the dashboard on port 80 and reverse-proxying `/gateway` to the
gateway container. Spin it up for a demo, stop it after.

```
Internet ──▶ EC2 :80 (nginx in `web` container)
                ├─ serves the React/ArcGIS dashboard (apps/web/dist)
                └─ proxies /gateway/* ─▶ gateway:8080
            docker compose network (internal, not exposed):
                gateway · 6 connectors · 4 AI services
                redpanda · postgres(PostGIS) · minio
```

---

## What's already in the repo (no action needed)

| File | Purpose |
|---|---|
| `apps/web/Dockerfile` | builds the dashboard, serves it via nginx |
| `apps/web/nginx.conf` | static serving + `/gateway` reverse-proxy |
| `docker-compose.aws.yml` | overlay: adds `web`, hides internal ports, `restart: unless-stopped`, secrets from `.env` |
| `.env.aws.example` | template for the EC2 `.env` |
| `deploy/aws/user-data.sh` | EC2 bootstrap (installs Docker, fetches code, brings the stack up) |
| `deploy/aws/manage.sh` | `up` / `down` / `logs` / `update` wrapper |

---

## Step 0 — Prerequisites (one time)

- An AWS account + a region (e.g. `ap-south-1` Mumbai — closest to JNPA).
- An **EC2 key pair** for SSH (`AWS Console → EC2 → Key Pairs → Create`). Download the `.pem`.
- A way to get the code onto the box. Pick one:
  - **A — Git:** push this repo somewhere the box can clone (GitHub/CodeCommit). For a private repo you'll need a deploy key or token on the box.
  - **B — Copy:** `scp`/`rsync` the working tree up after the box is running (works with zero git setup — see Step 4B).

---

## Step 1 — Pick the instance size

The stack is **16 containers** (gateway, 6 connectors, 4 scikit-learn AI services,
Redpanda ~1 GB, Postgres/PostGIS, MinIO, nginx). It is RAM-bound, not CPU-bound.

| Instance | vCPU / RAM | Cost (ap-south-1, on-demand) | Verdict |
|---|---|---|---|
| `t3.small` | 2 / 2 GB | ~$15/mo | ❌ too small — Redpanda + AI will OOM |
| **`t3.medium`** | 2 / 4 GB | **~$30/mo** | ✅ **recommended** for the full live-gateway stack |
| `t3.large` | 2 / 8 GB | ~$60/mo | comfortable headroom; use if AI services get heavy |

> If you set `WEB_DATA_MODE=mock` (dashboard runs the simulator 100% in-browser),
> you can drop the gateway/connectors/AI containers entirely and a `t3.small`
> is plenty — but the full-round-trip demo is more convincing, so default to
> `t3.medium`.

**EBS:** default 8 GB gp3 is tight (Docker images ~3–4 GB). Bump the root volume to
**20 GB gp3** at launch.

You stop the instance between demos to pay only for storage (~$1.60/mo for 20 GB).

---

## Step 2 — Security Group

Create a security group (`jnpa-uc2-demo`) with **inbound**:

| Type | Port | Source | Why |
|---|---|---|---|
| HTTP | 80 | `0.0.0.0/0` (or your office IP) | the dashboard |
| SSH | 22 | **your IP only** | admin |
| HTTPS | 443 | `0.0.0.0/0` | only if you add TLS (Step 7) |

Leave outbound as default (all). Nothing else needs to be open — Postgres,
Redpanda, MinIO, and the gateway stay on the internal Docker network.

---

## Step 3 — Launch the instance

`EC2 → Launch instance`:

1. **Name:** `jnpa-uc2-demo`
2. **AMI:** Amazon Linux 2023 (x86_64). (The bootstrap also handles `arm64`/Graviton — a `t4g.medium` is ~20% cheaper if you prefer ARM.)
3. **Type:** `t3.medium` (per Step 1)
4. **Key pair:** the one from Step 0
5. **Network:** attach the `jnpa-uc2-demo` security group
6. **Storage:** root volume → **20 GB gp3**
7. **Advanced → User data:** paste the contents of [`user-data.sh`](user-data.sh).
   - If using **Git (option A)**, edit the top of the script first: set
     `REPO_URL="https://github.com/<you>/<repo>.git"` (and `REPO_BRANCH` if not `main`).
   - If using **copy (option B)**, leave `REPO_URL` empty and skip ahead — you'll
     run the bootstrap by hand in Step 4B.

Launch.

---

## Step 4 — Get the stack running

### 4A — Git path (you set REPO_URL in user-data)

User-data runs automatically on first boot. It installs Docker, clones the repo to
`/opt/jnpa-uc2`, writes a starter `.env` (auto-generating a strong `JWT_DEV_SECRET`),
and runs `up -d --build`. The first build pulls base images and compiles the web
bundle — give it **3–6 minutes**.

Check progress:

```bash
ssh -i your-key.pem ec2-user@<EC2_PUBLIC_IP>
sudo cat /var/log/cloud-init-output.log   # bootstrap log
cd /opt/jnpa-uc2 && ./deploy/aws/manage.sh ps
```

### 4B — Copy path (no git on the box)

```bash
# from your laptop, in the repo root:
rsync -az --exclude node_modules --exclude .venv --exclude '.git' \
  -e "ssh -i your-key.pem" ./ ec2-user@<EC2_PUBLIC_IP>:/opt/jnpa-uc2/

ssh -i your-key.pem ec2-user@<EC2_PUBLIC_IP>
cd /opt/jnpa-uc2
sudo bash deploy/aws/user-data.sh      # installs Docker, writes .env, brings stack up
```

---

## Step 5 — Configure secrets (do this before sharing the URL)

The bootstrap copies `.env.aws.example → .env` and auto-fills a random
`JWT_DEV_SECRET`. **Review and harden** the rest:

```bash
cd /opt/jnpa-uc2
sudo nano .env          # set POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, confirm WEB_DATA_MODE
./deploy/aws/manage.sh up   # re-applies .env (rebuilds only what changed)
```

| Var | Default | Action |
|---|---|---|
| `JWT_DEV_SECRET` | auto-generated | leave as-is (already strong) |
| `WEB_DATA_MODE` | `live` | `live` = dashboard calls the gateway; `mock` = in-browser sim |
| `DATA_MODE` | `mock` | keep `mock` for the PoC (gateway serves deterministic data); flip to `live` only after connector onboarding |
| `POSTGRES_PASSWORD` | `change-me-postgres` | set a real value |
| `MINIO_ROOT_PASSWORD` | `change-me-minio` | set a real value |

> Live-data credentials (ULIP, ICEGATE, TOS, ArcGIS…) only matter once
> `DATA_MODE=live`. Until then the connectors run against the in-repo simulators —
> see the root [`.env.example`](../../.env.example) and
> [`README.md`](../../README.md#live-data-onboarding-keltronjnpa-only).

---

## Step 6 — Verify

```bash
# on the box
./deploy/aws/manage.sh ps          # all services Up / healthy
curl -s localhost/gateway/health   # → {"ok":true,"mode":"mock"} — gateway answers through nginx
```

Then open **`http://<EC2_PUBLIC_IP>/`** in a browser. You should see the DTCCC
cargo dashboard. If `WEB_DATA_MODE=live`, the KPI strip / panels are served by the
gateway (watch `./deploy/aws/manage.sh logs`).

---

## Step 7 — (Optional) HTTPS + a real hostname

The `web` container listens on plain `:80`. For a shareable HTTPS link, easiest paths:

- **Caddy in front** (auto Let's Encrypt): point a DNS A-record at the EIP, run a
  Caddy container reverse-proxying `:443 → web:80`. ~10 lines of Caddyfile.
- **CloudFront** in front of the instance (origin = the public DNS, HTTP) — gives
  HTTPS + a `*.cloudfront.net` name with no DNS of your own.
- **ALB** with an ACM cert if you want a managed LB (adds ~$16/mo).

For an internal tender demo, plain HTTP to the public IP (SG locked to your office
range) is usually enough.

**Elastic IP:** allocate one and associate it so the URL survives a stop/start
(`EC2 → Elastic IPs → Allocate → Associate`). ~free while attached to a running
instance; small charge if allocated but unused.

---

## Day-2 operations

```bash
cd /opt/jnpa-uc2
./deploy/aws/manage.sh logs       # follow gateway + web logs
./deploy/aws/manage.sh update     # git pull + rebuild changed images (git path)
./deploy/aws/manage.sh restart    # bounce all services
./deploy/aws/manage.sh down       # stop containers, keep DB/minio volumes
./deploy/aws/manage.sh nuke       # down + delete volumes (wipes DB/minio)
```

**Pause between demos (save money):** `EC2 → Stop instance`. With an Elastic IP the
URL is preserved; `restart: unless-stopped` brings every container back on
`Start`. You pay only for EBS (~$1.60/mo) while stopped.

**Tear down completely:** `manage.sh nuke` → `EC2 → Terminate instance` → release
the Elastic IP → delete the security group.

---

## Cost summary (ap-south-1, on-demand)

| Item | Running 24×7 | Demo-only (stopped between) |
|---|---|---|
| t3.medium | ~$30/mo | ~$0.05/hr while on |
| 20 GB gp3 EBS | ~$1.60/mo | ~$1.60/mo (charged while stopped too) |
| Elastic IP | free (attached) | small charge if instance stopped |
| **Typical** | **~$32/mo** | **~$3–8/mo** if used a few hours/week |

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `up` fails: `required variable JWT_DEV_SECRET is missing` | `.env` not present — run the bootstrap, or `cp .env.aws.example .env`. |
| Dashboard loads but panels are empty (live mode) | gateway not reachable. `manage.sh logs`; confirm `web` `depends_on: gateway` and nginx `/gateway/` proxy. |
| `502` on `/gateway/...` | gateway container not up yet (cold start) — wait ~30s, or check `manage.sh ps`. |
| First build very slow / killed | RAM pressure on `t3.small`. Use `t3.medium`, or build with `WEB_DATA_MODE=mock` and skip the backend containers. |
| `no space left on device` | EBS too small — grow the root volume to 20 GB (`EC2 → Volumes → Modify`) then `sudo growpart`/`xfs_growfs`. |
| Web build OOMs on a tiny box | the Vite bundle is large; build on `t3.medium`+ or pre-build the `web` image elsewhere and `docker save`/`load` it. |
```
