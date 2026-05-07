# Mock Server Infrastructure — Deployment Guide

This guide is for **DevOps / Platform** and **engineers** consuming the mock. It covers two deployment models for the **WM Sports Mock Server**:

1. **[ECS deployment (current production path)](#production-ecs-deployment)** — managed via the central `warnermediacode/reusable-workflows` GitHub Actions, auto-deployed on push to `main`.
2. **[EC2 + Docker Compose deployment (legacy / bare-metal)](#legacy-ec2--docker-compose-deployment)** — kept for reference and standalone scenarios.

The repo root [`docker-compose.yml`](../docker-compose.yml) is the **source of truth for the local-dev / EC2 layout**. The ECS task definition (managed by DevOps in `warnermediacode/reusable-workflows`) is the source of truth for production.

The dashboard (Node/Express, port **4010**) proxies GraphQL/REST to **Microcks**, runs the `/ai/*` flows, exposes `GET /health`, and (in production) is fronted by an **internal ALB**.

---

## Production: ECS Deployment

### Architecture

```
                ┌────────────────────────────────────────┐
push → main ──→ │  GitHub Actions (warnermediacode/      │
                │  reusable-workflows)                   │
                │  • versions.yml → version tag          │
                │  • build-retag-deploy.yml (dev)        │
                │  • sports-build-and-deploy.yml (stage) │
                └─────┬──────────────────────────────────┘
                      │ assumes IAM role  sports-mock-server-GHA  (via OIDC)
                      │ docker build → push to ECR
                      │ register new ECS task def revision
                      │ update ECS service
                      ▼
       ┌──────────────────────────────────────────────────┐
       │  ECR  152471664880.dkr.ecr.us-east-1.amazonaws   │
       │       .com/sports-mock-server  (UE1, UE2, UW2)   │
       └──────────────────────────────────────────────────┘
                      │ image pull
                      ▼
       ┌──────────────────────────────────────────────────┐
       │  ECS service  sports-mock-server-app             │
       │  cluster      us-east-1-dev-cluster (and stage)  │
       │  task def     sports-mock-server-app-dev         │
       │  port         4010                               │
       └─────┬────────────────────────────────────────────┘
             │
             ▼
       ┌──────────────────────────────────────────────────┐
       │  Internal ALB  us-east-1-dev-private             │
       │  Target group  dev-sports-mock-server (HTTP/4010)│
       │  Health check  GET /health → 200                 │
       └─────┬────────────────────────────────────────────┘
             │
             ▼
       Consumers: Fed-Services ECS apps (same VPC), corp VPN users,
                  CI runners (via VPN egress / VPC peering)
```

### What's Provisioned

| Component | Value | Notes |
|---|---|---|
| **ECR repository** | `152471664880.dkr.ecr.us-east-1.amazonaws.com/sports-mock-server` | Replicated to UE1, UE2, UW2 |
| **IAM role for GitHub OIDC** | `sports-mock-server-GHA` | Trust scoped to `warnermediacode/wmsports-mock-server` on `main` |
| **ECS cluster (dev)** | `us-east-1-dev-cluster` | Shared cluster, 40+ services |
| **ECS service** | `sports-mock-server-app` | REPLICA strategy, port 4010 |
| **Task definition** | `sports-mock-server-app-dev:N` | Revision N is bumped on every deploy |
| **Capacity provider** | `us-east-1-dev-capacity-provider` | Shared |
| **Internal ALB** | `us-east-1-dev-private` | Private-subnet ALB |
| **ALB DNS (raw)** | `internal-us-east-1-dev-private-300008180.us-east-1.elb.amazonaws.com` | Use the friendly Route53 alias if available |
| **Target group** | `dev-sports-mock-server` → `4010` | Health check path: `/health` |
| **Stage environment** | Same shape in `us-east-1-stage-cluster` | Auto-promoted after dev (see workflow) |

DevOps tickets backing this provisioning: **STDEVOPS-4355** (Mock Server) and **STDEVOPS-4354** (Contract Testing).

### CI/CD Pipeline (auto-deploy on push to `main`)

[`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml) defines the pipeline. It composes three reusable workflows from `warnermediacode/reusable-workflows`:

| Job | Reusable workflow | Purpose |
|---|---|---|
| `version` | `versions.yml@main` | Generates a version tag from the commit |
| `dev-app` | `build-retag-deploy.yml@main` (`ENV=dev`) | Build the Docker image, push to ECR, register a new task def revision, update the dev ECS service, wait for steady state |
| `stage-app` | `sports-build-and-deploy.yml@main` (`ENV=stage`) | Promote the dev image tag to stage; deploy to the stage ECS service. Runs only after `dev-app` succeeds. |

`AWS_ASSUME_ROLE_NONPROD` is configured as a GitHub variable (org or repo level) and points at `sports-mock-server-GHA`.

**Trigger**: push to `main` only. PRs do **not** deploy.

### Manual Deploy (dev only)

[`.github/workflows/deploy-to-dev.yml`](../.github/workflows/deploy-to-dev.yml) is a `workflow_dispatch`-triggered version of the dev step. Use it to redeploy the same `main` HEAD without a code push (e.g., to retry after a transient ECS failure or to pick up a config-only change in the central workflow).

### Image Build

The `Dockerfile` at the repo root is built by the reusable workflow. The image:

- Bakes the Git-tracked `artifacts/` into `/app/artifacts-seed/`.
- Runs [`entrypoint.sh`](../entrypoint.sh) on container start, which seeds `/app/artifacts/` from the baked-in baseline **only when the volume is empty**.
- Exposes port `4010`.

For ECS, the writable `/app/artifacts` mount should be backed by either:
- An **EFS** mount target shared across all tasks in the service (preferred — survives task replacement and supports >1 task), or
- A `tmpfs` / ephemeral volume if you don't need AI-generated artifacts to persist across task restarts.

> **TODO (DevOps)**: confirm which storage option the task definition uses today. AI-generated artifacts (`POST /ai/setup`) only persist if the mount is durable.

### Secrets Management

Secrets must **never** be plaintext in the task definition. The dashboard reads these at boot:

| Variable | Source | Purpose |
|---|---|---|
| `GROQ_API_KEY` | AWS Secrets Manager (or SSM Parameter Store) | Powers `/ai/*` LLM routes |
| `MICROCKS_KEYCLOAK_TOKEN_URL` | Task def env (non-secret) | OAuth token endpoint for shared Microcks |
| `MICROCKS_CLIENT_ID` | Task def env (non-secret) | Service account client ID (e.g. `wmsports-svc-user`) |
| `MICROCKS_CLIENT_SECRET` | AWS Secrets Manager | Keycloak client secret |
| `MICROCKS_URL` | Task def env (non-secret) | e.g. `https://microcks-sandbox-dev.gqa.discomax.com` |
| `MICROCKS_SERVICE_PREFIX` | Task def env (non-secret) | `wmsports-` (namespace isolation in shared catalog) |
| `STATE_FILE_PATH` | Task def env (non-secret) | Set to a path on the persistent mount to keep workspace state across task restarts |

In the ECS task definition, secrets are referenced via the `secrets` block:

```json
"secrets": [
  { "name": "GROQ_API_KEY",          "valueFrom": "arn:aws:secretsmanager:us-east-1:152471664880:secret:wmsports/mock-server/groq-api-key" },
  { "name": "MICROCKS_CLIENT_SECRET","valueFrom": "arn:aws:secretsmanager:us-east-1:152471664880:secret:wmsports/mock-server/microcks-client-secret" }
]
```

> **TODO (DevOps)**: confirm the Secrets Manager ARNs in use and ensure the task **execution** role has `secretsmanager:GetSecretValue` on them.

### Accessing the Dashboard

- **From other services in the same VPC** (Fed-Services ECS, etc.): hit the internal ALB DNS directly. Their service security group must allow egress to the ALB SG.
- **From corp VPN users / developers**: the ALB security group must allow inbound from the relevant prefix list (e.g. `pl-0a57d9874bec3590b` for `global-vpn-earth`). If your VPN gateway egresses outside that range, request the right prefix list be added.
- **From CI runners (GitHub Actions hosted runners)**: typically not allowlisted — use VPN-routed self-hosted runners or a dedicated CI prefix list. Discuss with DevOps before opening this surface.

> **TODO (DevOps)**: confirm the friendly Route53 alias (e.g. `mock-server.dev.sports.discomax.com`) for the dev and stage ALBs so consumers don't hardcode the raw ALB DNS.

### Operations

#### View logs

CloudWatch Logs group for the service (default convention): `/ecs/sports-mock-server-app-dev`. Stream by task ID. Confirm the actual log group from the task definition's `logConfiguration` block.

#### Trigger a redeploy without a code change

```
gh workflow run deploy-to-dev.yml -R warnermediacode/wmsports-mock-server
```

(or run the workflow from the GitHub UI under the **Actions** tab).

#### Rollback

ECS rollback is best handled by re-deploying a known-good image tag:

1. Find the previous successful image tag in ECR (the GitHub Actions workflow tags with the version output of `versions.yml`).
2. Update the ECS task definition to reference that older tag (revision in the AWS Console, or via the deploy workflow with a pinned tag).
3. Update the service to the new revision.

If the deployment circuit breaker is enabled on the service, ECS auto-rolls back any deployment whose tasks fail the ALB health check.

> **TODO (DevOps)**: confirm whether the deployment circuit breaker (`deploymentCircuitBreaker.enable=true`, `rollback=true`) is set on the service.

#### Scale

Update the service's `desiredCount` in the AWS Console or via Terraform. Two tasks across two AZs is a safe HA baseline once the artifact mount is shared (EFS) — running >1 task with a per-task volume will desync AI-generated artifacts.

### Troubleshooting

| Issue | Where to look |
|---|---|
| New deploy stuck in `PROVISIONING` | ECS service events; usually a missing IAM permission or unhealthy ALB target |
| `/health` returns `microcks: disconnected` | Verify `MICROCKS_URL` and the Keycloak client secret in Secrets Manager; check egress from the ECS subnets to GQA Microcks |
| AI routes fail | Check `GROQ_API_KEY` is mounted (CloudWatch logs `Auth: ✗ AI provider key missing`) and outbound HTTPS to `api.groq.com` |
| Consumer can't reach ALB | Their SG must allow egress to the ALB SG; ALB SG must allow inbound from their SG / VPN prefix list |
| Workspace data lost on task restart | The mount is ephemeral — switch to EFS or set `STATE_FILE_PATH` on a durable volume |

---

## Legacy: EC2 + Docker Compose Deployment

> **STATUS: legacy.** The current production path is the [ECS deployment above](#production-ecs-deployment). This section is kept for reference, local-VM evaluation, or standalone bare-metal scenarios where ECS isn't an option. Don't follow this for production unless you have a specific reason — the ECS path is what DevOps supports.

### Infrastructure Requirements

#### Recommended: Single EC2 Instance

| Spec | Value |
|------|-------|
| **Instance type** | `t3.medium` (2 vCPU, 4 GB RAM) |
| **OS** | Amazon Linux 2023 or Ubuntu 22.04 LTS |
| **Root volume** | 20 GB `gp3` EBS for OS + Docker images |
| **Data volume** | Separate **EBS `gp3`** (10–20 GB), mounted at `/mnt/artifacts`, holding the writable artifacts directory (see [Persistent storage](#persistent-storage)) |
| **Software** | Docker Engine 24+, Docker Compose v2 |
| **Estimated cost** | ~$35–45/mo on-demand (instance + 30 GB total EBS) |

A `t3.small` (2 vCPU, 2 GB) is marginal once **Microcks** and the **Node** dashboard run together with AI flows. **`t3.medium`** is the recommended default for team usage and CI traffic.

#### Networking & Security Group

| Rule | Port | Source | Purpose |
|------|------|--------|---------|
| Inbound TCP | **4010** | VPC CIDR / trusted CI or developer IPs | Mock dashboard + API (`/graphql/*`, `/rest/*`, `/ai/*`) |
| Inbound TCP | **8585** | VPC CIDR / admin or CI (only if calling Microcks directly) | Microcks API + UI (host **8585** → container **8080**) |
| Inbound TCP | **22** | Admin IP range | SSH (maintenance); prefer SSM Session Manager |
| Outbound | All | `0.0.0.0/0` | Docker image pulls, OS updates, **LLM HTTPS** if AI is enabled |

> **No broad public exposure required.** Deploy in a **private subnet** with VPN or internal ALB; allow inbound **4010** (and **8585** if needed) only from trusted networks and CI egress IPs.

**LLM egress:** `/ai/*` routes call **external** inference APIs (Groq by default). If policy forbids that, use an approved internal endpoint or do not configure API keys.

#### Production hardening (checklist)

| Item | Action |
|------|--------|
| **Secrets** | Inject `GROQ_API_KEY` (and any future Microcks Keycloak credentials) from **AWS Secrets Manager** / SSM Parameter Store at deploy time, not plaintext in git. |
| **Microcks** | Pin image digest or tag (avoid uncontrolled `:latest` drift in strict environments). |
| **Reboots** | Containers restart after host reboot via a **systemd** unit / `@reboot` script that runs `docker compose up -d` from the install directory. |
| **TLS** | Terminate HTTPS at an **ALB** or corporate proxy; containers can stay HTTP behind it. |
| **Backups** | Schedule **EBS snapshots** of the artifacts volume (and Microcks volume if you add one) on a daily/weekly cadence. |

### What Gets Deployed

Three Docker services on one machine ([`docker-compose.yml`](../docker-compose.yml)):

| Container | Image / build | Port | CPU* | RAM* | Purpose |
|-----------|---------------|------|------|------|---------|
| **dashboard** | `build: .` (Node 20) | **4010** | ~0.25 vCPU | ~256–512 MB | GraphQL/REST proxy, AI agent (`/ai/*`), explorer UI, `GET /health` |
| **microcks** | `quay.io/microcks/microcks-uber:latest` | **8585** | ~0.5 vCPU | ~512 MB–1 GB | Mock engine, spec-backed examples |
| **import** | `microcks-uber` (one-shot) | — | — | — | Imports `artifacts/` into Microcks on startup; exits when done |

\*Approximate steady-state; Microcks spikes during import. **Total** is typically **well within a `t3.medium`**.

A shared Docker named volume `artifacts` is mounted into all three containers. The dashboard mounts it **read-write** (so AI-generated specs persist); microcks and the importer mount it **read-only**.

### Persistent Storage

The mock server has two pieces of state worth preserving across container restarts and instance replacements:

#### 1. `artifacts/` directory (REQUIRED for production)

Holds:
- The Git-tracked baseline specs (GraphQL SDL, OpenAPI JSON/YAML, AsyncAPI YAML, Postman collections).
- Runtime-generated specs from `POST /ai/setup` (these never reach Git).

The dashboard image bakes the Git baseline into `/app/artifacts-seed/` and the entrypoint copies it into `/app/artifacts/` **only when the volume is empty**. After first boot, runtime-generated artifacts persist on the volume and survive container restarts.

**Production setup (EBS-backed bind mount):**

1. Provision and attach an EBS `gp3` volume (10–20 GB) to the EC2 instance.
2. Format and mount it once:
   ```bash
   sudo mkfs.ext4 /dev/nvme1n1            # use the actual device name from `lsblk`
   sudo mkdir -p /mnt/artifacts
   sudo mount /dev/nvme1n1 /mnt/artifacts
   echo '/dev/nvme1n1 /mnt/artifacts ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
   sudo chown -R 1000:1000 /mnt/artifacts   # match the node user inside the image
   ```
3. Create a `docker-compose.prod.yml` override pinning the named volume to that path:
   ```yaml
   volumes:
     artifacts:
       driver: local
       driver_opts:
         type: none
         device: /mnt/artifacts
         o: bind
   ```
4. Bring up the stack with the override:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```

On first boot the dashboard's entrypoint will detect `/mnt/artifacts` is empty and seed it from the image's baseline. Every subsequent restart leaves the volume alone, so AI-generated services persist.

**Disaster recovery:** snapshot the EBS volume daily. If the instance dies, attach the volume (or restore from a snapshot) to the replacement and bring the stack up — no re-import needed.

#### 2. Workspace state file (OPTIONAL)

Workspaces, scenarios, and overrides live in memory by default. To survive dashboard restarts, set:

```yaml
# in docker-compose.prod.yml override
services:
  dashboard:
    environment:
      - STATE_FILE_PATH=/app/artifacts/state.json
```

Reuse the artifacts EBS volume — both files are part of the same lifecycle. If you skip this, restarting the dashboard wipes workspace data; Microcks itself is unaffected.

#### 3. Microcks data (OPTIONAL — re-import covers this)

The `microcks-uber` image bundles its own embedded storage. After a Microcks container restart, the **import** sidecar re-runs and reloads everything from `/app/artifacts/`, so an explicit Microcks volume is not required. If you want to skip the re-import warmup, mount a named volume on the Microcks container and snapshot it independently.

### Deployment Steps

#### 1. Provision the EC2 Instance

Create a `t3.medium` in your private subnet, attach the security group above, attach a separate EBS `gp3` volume for `/mnt/artifacts`, and (optional) attach an IAM instance profile for Secrets Manager access.

#### 2. Install Docker

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

For **Ubuntu 22.04**, follow [Docker's official install guide](https://docs.docker.com/engine/install/ubuntu/).

#### 3. Mount the artifacts EBS volume

See [Persistent storage › 1. `artifacts/` directory](#1-artifacts-directory-required-for-production).

#### 4. Clone This Repo and Configure

```bash
git clone https://github.com/<org>/wmsports-mock-server.git
cd wmsports-mock-server
```

Create a `.env` file (or inject via Secrets Manager) with the AI API key:

```bash
GROQ_API_KEY=...
```

Reference it from the dashboard service via `env_file: .env` in your override file, or extend `environment:` with `GROQ_API_KEY: ${GROQ_API_KEY}`.

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | For `/ai/*` | Groq API key (or set `AI_PROVIDER=together`/`ollama` and the matching key) |
| `MICROCKS_URL` | Set in compose | `http://microcks:8080` on the Docker network |
| `PORT` | Optional | Default **4010** |
| `ARTIFACTS_DIR` | Set in compose | Default `/app/artifacts` — change only if you remap the mount inside the container |
| `STATE_FILE_PATH` | Optional | Set to a path on the artifacts volume (e.g. `/app/artifacts/state.json`) to persist workspaces across restarts |
| `MICROCKS_SERVICE_PREFIX` | Optional | Default `wmsports-`; namespace isolation in a shared Microcks catalog |
| `AI_PROVIDER`, `AI_MODEL` | Optional | Override LLM provider/model defaults |

#### 5. Start the Services

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The startup sequence is:

1. **microcks** boots and passes its healthcheck.
2. **dashboard** boots; its entrypoint seeds `/app/artifacts` from the baked-in baseline if empty, then starts the Node server. Healthcheck waits for `GET /health` to return 200.
3. **import** runs once after dashboard is healthy, scans `/app/artifacts/`, and bulk-uploads everything into Microcks. Exits when done.

#### 6. Verify Health

```bash
docker compose ps
docker compose logs -f import      # confirm artifacts loaded successfully

curl -s http://localhost:4010/health        # dashboard
curl -s http://localhost:8585/api/services  # Microcks catalog
```

`/health` returns JSON describing Microcks reachability and service counts; `/api/services` lists all imported services.

#### 7. Clients and CI

Point tests and tools at the mock **base URL**:

- `http://<internal-host>:4010/graphql/<ServiceName>`
- `http://<internal-host>:4010/rest/<ServiceName>/<Version>/<path>`

Send a stable **`X-User`** header per developer/CI lane for AI scenario isolation. Send **`X-Workspace`** to scope AI-generated services to a workspace (see workspace docs in the README).

### Operations (EC2)

#### View Logs

```bash
docker compose logs -f
docker compose logs -f dashboard
docker compose logs -f microcks
```

#### Restart Services

```bash
docker compose restart
docker compose restart dashboard
```

#### Update Images / App

```bash
git pull
docker compose build --no-cache dashboard
docker compose pull microcks
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The dashboard's seed step is idempotent: an existing artifacts volume is left untouched on redeploy, so AI-generated services and workspace state survive image rebuilds.

#### Re-importing Artifacts to Microcks

After Microcks restarts (or if you suspect drift):

```bash
docker compose run --rm import
```

This rescans the shared volume and re-uploads every spec.

#### Backing Up Artifacts

The artifacts volume holds runtime-generated specs that are not in Git. Snapshot the EBS volume on a schedule:

```bash
# Example: daily snapshot via AWS CLI (run from the EC2 host or a CI job)
aws ec2 create-snapshot --volume-id vol-xxxx --description "wmsports-artifacts $(date -I)"
```

Restore by creating a volume from the snapshot and remounting at `/mnt/artifacts`.

### Monitoring (EC2)

#### Health Check Endpoints

| Service | Endpoint | Expected |
|---------|----------|----------|
| Mock dashboard | `GET /health` | JSON with Microcks status / counts |
| Microcks | `GET /api/services` | `200 OK` with the list of services |

Use CloudWatch, Datadog, or similar **HTTP checks** against `http://<host>:4010/health` and `http://<host>:8585/api/services`. Alert on consecutive failures or non-200 responses.

**Load balancer:** if an ALB targets the dashboard, use **`/health`** as the target health path.

#### Disk Usage

Monitor the artifacts EBS volume — AI-generated specs grow it slowly. Container layer growth on the root volume is bounded by `docker image prune`. Set CloudWatch alarms on disk free percentage.

### Scaling Notes (EC2)

| Metric | Typical range |
|--------|----------------|
| GraphQL subgraphs / REST / async surfaces | As defined in repo `README` (hundreds of operations) |
| Mock requests/day | Low vs. production APIs — developer and CI traffic |
| Instance | **`t3.medium`** sufficient for full internal adoption |

Scale up to **`t3.large`** if you enable **self-hosted LLMs**, sustained heavy **AI** traffic, or many parallel imports. For **HA**, use ECS (the production path above) — the EC2 single-instance model has the artifacts volume as a single-writer.

### Troubleshooting (EC2)

| Issue | Fix |
|-------|-----|
| Dashboard up, GraphQL/REST errors | Check `MICROCKS_URL` from inside the dashboard container; verify Microcks is healthy; review the `import` sidecar logs |
| `/health` shows Microcks disconnected | Network, startup order, wrong `MICROCKS_URL` |
| AI routes fail | `GROQ_API_KEY` / `AI_API_KEY`; outbound HTTPS; provider rate limits |
| `/ai/setup` fails with "Failed to persist artifacts" | The artifacts volume is read-only or full; check the bind mount and disk usage |
| Empty Microcks catalog after deploy | `import` sidecar didn't run or exited early — check `docker compose logs import` |
| Workspace/scenario data lost on restart | Set `STATE_FILE_PATH` in the dashboard environment to a path on the persistent volume |
| Port conflict | Adjust host ports in compose |
| OOM | `docker stats`; increase instance size or reduce concurrency |

---

## Alternative Deployment: Render.com

The repo also includes [`render.yaml`](../render.yaml) for a native-Node deployment on Render. That model is intentionally simpler — no Docker, no import sidecar, and Microcks runs as an **external** service referenced by `MICROCKS_URL`. Render is currently used as a staging surface; once ECS deployment is live and stable, the Render config can be removed.

---

## References

- [`README.md`](../README.md) — routes, examples, environment variables
- [`.github/workflows/ci-cd.yml`](../.github/workflows/ci-cd.yml) — production push-to-deploy pipeline
- [`.github/workflows/deploy-to-dev.yml`](../.github/workflows/deploy-to-dev.yml) — manual dev redeploy
- [`Dockerfile`](../Dockerfile) — dashboard image build
- [`entrypoint.sh`](../entrypoint.sh) — first-boot artifact seeding
- [`docker-compose.yml`](../docker-compose.yml) — local-dev / EC2 service composition
- [`import-to-microcks.sh`](../import-to-microcks.sh) — bulk-import logic for the `import` sidecar
- DevOps tickets: [STDEVOPS-4355](https://wbddigital.atlassian.net/browse/STDEVOPS-4355) (Mock Server), [STDEVOPS-4354](https://wbddigital.atlassian.net/browse/STDEVOPS-4354) (Contract Testing)

If Microcks is **already running elsewhere** (e.g., the shared GQA Microcks at `microcks-sandbox-dev.gqa.discomax.com`), point `MICROCKS_URL` at that instance and run only the dashboard. Be aware that the in-repo Microcks namespace prefix (`wmsports-`) shares the catalog politely with other tenants.
