# Mock Server Infrastructure — Deployment Guide

This guide is for **DevOps / Platform**. It describes how to deploy the **WM Sports Mock Server** on AWS using **one EC2 instance**, **Docker Engine**, and **Docker Compose**. **Microcks** stores GraphQL schemas, Postman collections, and OpenAPI/AsyncAPI artifacts; the **dashboard** (Node/Express, port **4010**) proxies GraphQL/REST, serves the explorer UI, and may call an **external LLM** (e.g. Groq) for `/ai/*` routes.

The repo root [`docker-compose.yml`](../docker-compose.yml) is the **source of truth** for service names, ports, and dependencies.

---

## Infrastructure Requirements

### Recommended: Single EC2 Instance

| Spec | Value |
|------|-------|
| **Instance type** | `t3.medium` (2 vCPU, 4 GB RAM) |
| **OS** | Amazon Linux 2023 or Ubuntu 22.04 LTS |
| **Storage** | 20 GB `gp3` EBS (30 GB if you retain large artifact sets or verbose logs) |
| **Software** | Docker Engine 24+, Docker Compose v2 |
| **Estimated cost** | ~$30–40/mo on-demand (lower with enterprise rates) |

A `t3.small` (2 vCPU, 2 GB) is marginal once **Microcks**, **PostgreSQL**, and the **Node** dashboard run together. **`t3.medium`** is the recommended default for team usage and CI traffic.

### Networking & Security Group

| Rule | Port | Source | Purpose |
|------|------|--------|---------|
| Inbound TCP | **4010** | VPC CIDR / trusted CI or developer IPs | Mock dashboard + API (`/graphql/*`, `/rest/*`, `/ai/*`) |
| Inbound TCP | **8585** | VPC CIDR / admin or CI (if calling Microcks directly) | Microcks API + UI (host **8585** → container **8080**) |
| Inbound TCP | **5432** | VPC CIDR only (recommended) | PostgreSQL for `dashboard` compose service—avoid public exposure |
| Inbound TCP | **22** | Admin IP range | SSH (maintenance); prefer SSM Session Manager |
| Outbound | All | `0.0.0.0/0` | Docker image pulls, OS updates, **LLM HTTPS** if AI is enabled |

> **No broad public exposure required.** Deploy in a **private subnet** with VPN or internal ALB; allow inbound **4010** (and **8585** if needed) only from trusted networks and CI egress IPs.

**LLM egress:** `/ai/*` routes may call **external** inference APIs. If policy forbids that, use an approved internal endpoint or do not configure API keys.

### Production hardening (checklist)

| Item | Action |
|------|--------|
| **Secrets** | Replace compose defaults: `POSTGRES_PASSWORD`, `JWT_SECRET`, and any DB URL in `DATABASE_URL`. Load from **Secrets Manager** / SSM Parameter Store at deploy time, not plaintext in git. |
| **Postgres exposure** | Prefer **not** publishing `5432` on `0.0.0.0/0`; restrict to VPC or remove the host port and keep DB on the Docker network only. |
| **Microcks** | Pin image digest or tag (avoid uncontrolled `:latest` drift in strict environments). |
| **Reboots** | Ensure containers start after host reboot: e.g. `restart: unless-stopped` on long-running services **or** a **systemd** unit / `@reboot` script that runs `docker compose up -d` from the install directory. |
| **TLS** | Terminate HTTPS at an **ALB** or corporate proxy; containers can stay HTTP behind it. |

---

## What Gets Deployed

Four Docker services on one machine ([`docker-compose.yml`](../docker-compose.yml)):

| Container | Image / build | Port | CPU* | RAM* | Purpose |
|-----------|---------------|------|------|------|---------|
| **Dashboard** | `build: .` (Node 20) | **4010** | ~0.25 vCPU | ~256–512 MB | GraphQL/REST proxy, AI agent, explorer UI, `GET /health` |
| **Microcks** | `quay.io/microcks/microcks-uber:latest` | **8585** | ~0.5 vCPU | ~512 MB–1 GB | Mock engine, spec-backed examples |
| **Import** | `microcks-uber` (one-shot) | — | — | — | Imports `artifacts/` into Microcks on startup |
| **PostgreSQL** | `postgres:15-alpine` | **5432** | ~0.25 vCPU | ~256 MB | Database wired in Compose for the dashboard service |

\*Approximate steady-state; Microcks spikes during import. **Total** is typically **well within a `t3.medium`**.

> **Persistence:** Add a **named volume** for Microcks (or EBS-backed path) if you need definitions to survive container recreation without re-import. **`artifacts/`** in Git remains the source of truth for what gets loaded.

---

## Deployment Steps

### 1. Provision the EC2 Instance

```text
# AWS Console or CLI — create a t3.medium in your private subnet
# Attach the security group with the rules above
# Optional: IAM instance profile for S3 backups or Secrets Manager
```

### 2. Install Docker

**Amazon Linux 2023:**

```bash
sudo dnf update -y
sudo dnf install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER

sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

docker --version
docker compose version
```

For **Ubuntu 22.04**, follow [Docker’s official install guide](https://docs.docker.com/engine/install/ubuntu/).

### 3. Clone This Repo and Configure

```bash
git clone https://github.com/<org>/wmsports-mock-server.git
cd wmsports-mock-server
```

Ensure **`GROQ_API_KEY`** (or equivalent per `server.cjs`) reaches the **dashboard** container. The committed Compose file lists `environment` for `PORT`, `MICROCKS_URL`, etc.; add **`env_file: .env`** to the `dashboard` service or extend `environment` with `GROQ_API_KEY: ${GROQ_API_KEY}`.

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | For `/ai/*` | Groq API key (see `server.cjs` for `AI_API_KEY` fallbacks) |
| `MICROCKS_URL` | Usually set in Compose | `http://microcks:8080` on the Docker network |
| `PORT` | Optional | Default **4010** |
| `AI_MODEL` | Optional | Overrides default model in `server.cjs` |

Store secrets in **AWS Secrets Manager** (or your standard); do not commit real `.env` files.

### 4. Start the Services

```bash
docker compose up -d
```

The **import** container exits after loading artifacts; **dashboard**, **microcks**, and **postgres** keep running.

### 5. Verify Health

```bash
docker compose ps

# Mock server (Microcks reachability + service counts)
curl -s http://localhost:4010/health

# Microcks
curl -s http://localhost:8585/api/services

# Dashboard UI — via VPN / jump host
# http://<instance-ip>:4010
```

Expected: `/health` returns JSON; `/api/services` lists services after a successful import (may be non-empty immediately).

### 6. Clients and CI

Point tests and tools at the mock **base URL**:

- `http://<internal-host>:4010/graphql/<ServiceName>`
- `http://<internal-host>:4010/rest/...`

If your deployment uses **per-user** AI isolation, send a stable **`X-User`** header (or use the dashboard’s identity flow).

---

## Operations

### View Logs

```bash
docker compose logs -f
docker compose logs -f dashboard
docker compose logs -f microcks
```

### Restart Services

```bash
docker compose restart
docker compose restart dashboard
```

### Update Images / App

```bash
git pull
docker compose build --no-cache dashboard
docker compose pull microcks
docker compose up -d
```

After changing **`artifacts/`**, re-run the one-shot importer (a plain `docker compose up -d` may **not** re-execute a completed **import** container):

```bash
docker compose run --rm import
```

Alternatively remove the old import container and run `docker compose up -d import`, or use your standard pipeline to POST artifacts to Microcks.

### Backup PostgreSQL (Compose `postgres` service)

```bash
docker compose exec postgres pg_dump -U mockserver mockserver > backup_$(date +%Y%m%d).sql
# Restore example (replace file name):
cat backup_20260309.sql | docker compose exec -T postgres psql -U mockserver mockserver
```

User/database names match [`docker-compose.yml`](../docker-compose.yml) (`mockserver` / `mockserver`). **Production:** set a strong `POSTGRES_PASSWORD` and use it in `pg_dump`/connection strings. For automated backups, use **cron** + `pg_dump` or **RDS** if required.

### Microcks Data

The **uber** image bundles storage; for disaster recovery, prefer **volume snapshots** or **re-import** from Git-tracked **`artifacts/`** (schemas, Postman, OpenAPI, AsyncAPI).

---

## Monitoring

### Health Check Endpoints

| Service | Endpoint | Expected |
|---------|----------|----------|
| Mock dashboard | `GET /health` | JSON with Microcks status / counts |
| Microcks | `GET /api/services` | `200 OK` |

Use CloudWatch, Datadog, or similar **HTTP checks** against **`GET http://<host>:4010/health`** and **`GET http://<host>:8585/api/services`**. Alert on consecutive failures or non-200 responses.

**Load balancer:** If an ALB targets the dashboard, use **`/health`** as the target health path (confirm it returns **HTTP200** in your build).

### Disk Usage

Monitor EBS: artifacts, container layers, and Microcks data grow slowly; bump disk or prune images if usage climbs.

---

## Scaling Notes

| Metric | Typical range |
|--------|----------------|
| GraphQL subgraphs / REST / async surfaces | As defined in repo `README` (hundreds of operations) |
| Mock requests/day | Low vs. production APIs — developer and CI traffic |
| Instance | **`t3.medium`** sufficient for full internal adoption |

Scale up to **`t3.large`** if you enable **self-hosted LLMs**, sustained heavy **AI** traffic, or many parallel imports. For **HA**, use your org’s container platform (EKS/ECS) only if required.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Dashboard up, GraphQL/REST errors | `MICROCKS_URL` from dashboard container; Microcks healthy; **import** logs |
| `/health` shows Microcks disconnected | Network, startup order, wrong `MICROCKS_URL` |
| AI routes fail | `GROQ_API_KEY` / `AI_API_KEY`; outbound HTTPS; provider rate limits |
| Import failures | `artifacts/` paths; `import-to-microcks.sh`; Microcks logs |
| Port conflict | Adjust host ports in Compose |
| OOM | `docker stats`; increase instance size or reduce concurrency |

---

## References

- Root [`README.md`](../README.md) — routes, examples, environment variables  
- [`docker-compose.yml`](../docker-compose.yml) — ports and service definitions  

If Microcks is **already running elsewhere**, point **`MICROCKS_URL`** at that instance and run only the **dashboard** (custom Compose overlay or single-service run)—no second Microcks on the same catalog unless intended.
