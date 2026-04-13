# Mock Server Infrastructure — Deployment Guide

This document describes how to deploy the **WM Sports Mock Server** stack on AWS using the same patterns as the Contract Testing infrastructure guide: **one EC2 instance**, **Docker Engine**, and **Docker Compose**.

The mock server proxies GraphQL and REST traffic to **Microcks**, serves the **dashboard** (port `4010`), and optionally uses an **external LLM** (Groq, etc.) for AI-driven failure scenarios.

---

## Infrastructure Requirements

### Recommended: Single EC2 Instance

| Spec | Value |
|------|-------|
| **Instance type** | `t3.medium` (2 vCPU, 4 GB RAM) |
| **OS** | Amazon Linux 2023 or Ubuntu 22.04 LTS |
| **Storage** | **30 GB** `gp3` EBS (Microcks + artifacts + logs; 20 GB minimum for light use) |
| **Software** | Docker Engine 24+, Docker Compose v2 |
| **Estimated cost** | ~$30–40/mo on-demand (lower with enterprise rates) |

A `t3.small` (2 vCPU, 2 GB) can work for **low traffic / demos** but is tight once Microcks, PostgreSQL, and the Node process are all running. **`t3.medium` is the recommended default** for team usage and CI hitting the mock concurrently.

### Networking & Security Group

Adjust sources to match your VPC, VPN, and CI runners (e.g. GitHub Actions egress IPs).

| Rule | Port | Source | Purpose |
|------|------|--------|---------|
| Inbound TCP | **4010** | VPC CIDR / trusted CI IPs | Mock server (dashboard + API) |
| Inbound TCP | **8585** | VPC CIDR / admin networks | Microcks UI & API (host maps **8585 → 8080** in container) |
| Inbound TCP | **5432** | VPC CIDR only (recommended) | PostgreSQL (only if you keep the port published; see below) |
| Inbound TCP | 22 | Admin IP range | SSH (maintenance); prefer SSM Session Manager if your org allows |
| Outbound | All | `0.0.0.0/0` | Docker pulls, LLM API (if used), OS updates |

> **Prefer no public internet on the mock or Microcks.** Deploy in a **private subnet** with access via VPN, internal ALB, or CI connectivity into the VPC.

**LLM egress:** If you enable the AI features, the application may call **external** inference APIs (e.g. Groq). If policy forbids that, use an **internal** model endpoint or disable AI routes—coordinate with Security.

---

## What Gets Deployed

Per the repo’s root [`docker-compose.yml`](../docker-compose.yml), **four Compose services** run on one host:

| Service | Image / build | Host port | Purpose |
|---------|----------------|-----------|---------|
| **dashboard** | `build: .` (Node20) | **4010** | Express app: UI, `/graphql/*`, `/rest/*`, `/ai/*`, `GET /health` |
| **microcks** | `quay.io/microcks/microcks-uber:latest` | **8585** → 8080 | Mock engine (schemas + examples imported from `artifacts/`) |
| **import** | Same Microcks image (one-shot) | — | Waits for Microcks healthy, then uploads artifacts |
| **postgres** | `postgres:15-alpine` | **5432** (default in file) | Database defined for Compose; verify whether your branch uses it for app persistence |

Total footprint is typically **well within a `t3.medium`** for the expected mock/CI traffic described in program docs.

> **Production hardening:** Consider **not** publishing PostgreSQL to the public internet—restrict `5432` to the Docker network only (remove the host port mapping) unless operators need host access.

> **Microcks persistence:** For production, add a **named volume** (or EBS-backed path) for Microcks data if you need mock definitions to survive container recreation without re-import. The repo mounts `./artifacts` read-only for imports; runtime state still benefits from durable Microcks storage.

---

## Relationship to Contract Testing

Contract Testing’s guide deploys **Pact Broker + PostgreSQL + Microcks + MongoDB** as separate containers.

This mock server repo uses the **Microcks “uber”** image and a **single Compose file** tuned for **mocking only**. You can:

- Run **two instances** (mock vs contract testing), or  
- **Consolidate** onto one host **only if** you deliberately merge Compose stacks and resolve port/password conflicts—treat that as a Platform decision.

If Microcks is **shared**, align **import jobs**, **credentials**, and **backup** ownership between teams.

---

## Deployment Steps

### 1. Provision the EC2 Instance

Create a `t3.medium` (or larger) in a **private subnet**, attach the security group above, and (optionally) an IAM instance profile for S3 backups or Secrets Manager access.

### 2. Install Docker

Use the same Docker + Compose plugin installation steps as the Contract Testing deployment guide (Amazon Linux 2023 `dnf` install, or [Docker’s Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/)).

Verify:

```bash
docker --version
docker compose version
```

### 3. Clone the repo and configure

```bash
git clone <your-fork-or-upstream-url> wmsports-mock-server
cd wmsports-mock-server
```

Create a **`.env`** next to `docker-compose.yml`. To pass variables into the **dashboard** container, either:

- Add `env_file: .env` under the `dashboard` service in `docker-compose.yml`, or  
- Add explicit `environment` entries (e.g. `GROQ_API_KEY: ${GROQ_API_KEY}`) so Compose injects secrets at runtime.

Minimum variables for the running app:

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | For AI features | Groq API key (or set `AI_API_KEY` if your build supports it—see `server.cjs`) |
| `MICROCKS_URL` | Optional in Compose | Defaults to `http://microcks:8080` **inside** the stack; override only if Microcks is external |
| `PORT` | Optional | Default **4010** |
| `AI_MODEL` | Optional | Default from `server.cjs` (e.g. Groq model id) |

Example `.env` fragment:

```bash
GROQ_API_KEY=<from-secrets-manager>
# Optional overrides:
# PORT=4010
# AI_MODEL=llama-3.3-70b-versatile
```

Store secrets in **AWS Secrets Manager** (or your standard) and inject at deploy time—avoid committing `.env`.

### 4. Start the stack

```bash
docker compose up -d
```

The **import** service exits after loading artifacts; **dashboard**, **microcks**, and **postgres** stay up.

### 5. Verify health

```bash
docker compose ps

# Mock server aggregate health (Microcks reachability + counts)
curl -s http://localhost:4010/health

# Microcks API
curl -s http://localhost:8585/api/services

# Dashboard (use VPN / jump host as appropriate)
# Open http://<instance-ip>:4010
```

Expected: `/health` returns JSON with service metadata; `/api/services` lists imported services after a successful import.

### 6. CI / client configuration

Point tests and tools at the **internal base URL** of the mock server, for example:

- `http://<internal-dns-or-alb>:4010/graphql/<ServiceName>`
- `http://<internal-dns-or-alb>:4010/rest/...`

If the server uses **per-user isolation** for AI scenarios and overrides, callers should send a stable **`X-User`** header (or use the dashboard cookie flow). Coordinate header values with the team owning the mock.

---

## Operations

### Logs

```bash
docker compose logs -f
docker compose logs -f dashboard
docker compose logs -f microcks
```

### Restart

```bash
docker compose restart
docker compose restart dashboard
```

### Update images / app

```bash
git pull
docker compose build --no-cache dashboard
docker compose pull microcks
docker compose up -d
```

Re-run imports if you change artifacts and need Microcks refreshed (bring stack up so **import** runs again, or trigger your pipeline’s import step).

### Backups

| Data | Suggestion |
|------|------------|
| **Artifacts** (schemas, Postman, OpenAPI) | Source of truth is **Git**; tag releases. |
| **Microcks** | Optional volume snapshots or Microcks backup procedures if definitions diverge from Git. |
| **PostgreSQL** in this Compose file | If you rely on it for future features, use `pg_dump` / RDS-style snapshots as in the Contract Testing guide. |

---

## Monitoring

| Check | Endpoint | Notes |
|-------|----------|--------|
| Mock server | `GET /health` | Use for load balancer / CloudWatch HTTP health checks |
| Microcks | `GET /api/services` | Returns `200`; empty list is valid before first import |

Alert on consecutive failures, high CPU/memory, and disk usage on EBS.

---

## Scaling Notes

This is a **developer / CI** tool, not a customer-facing production API. A single **`t3.medium`** is appropriate for full program adoption of mocks at the traffic levels described in internal sizing docs. Scale up if you add **self-hosted LLMs**, heavy concurrent AI generation, or many large artifacts.

For **high availability**, move to an existing **EKS/ECS** platform with health checks and multiple tasks—only if the organization requires it.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| Dashboard up, GraphQL/REST errors | `MICROCKS_URL` reachable from **dashboard** container; Microcks healthy; import logs |
| `/health` shows Microcks disconnected | Network between containers; Microcks not ready; wrong `MICROCKS_URL` |
| AI endpoints fail | `GROQ_API_KEY` / `AI_API_KEY` set; outbound HTTPS allowed; rate limits |
| Import failures | `artifacts/` mounted; file names/patterns match `import-to-microcks.sh`; Microcks logs |
| Out of memory | `docker stats`; bump instance to `t3.large` or reduce concurrent AI usage |

---

## References

- Root [`README.md`](../README.md) — usage, routes, environment variables  
- [`docker-compose.yml`](../docker-compose.yml) — authoritative service list and ports  
- Contract Testing deployment guide (sibling repo) — Pact Broker + Microcks layout for comparison  
