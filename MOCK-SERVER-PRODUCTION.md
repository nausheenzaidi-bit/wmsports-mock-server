# WM Sports Mock Server: Production Deployment Guide

This document covers the tools used in the Mock Server POC, their current hosting, limitations, and production-ready deployment options with cost estimates accounting for shared infrastructure with contract testing.

---

## Tools Used in the POC

### 1. Express.js (Node.js)

| Attribute | Detail |
|-----------|--------|
| **What it does** | HTTP server for GraphQL + REST API proxy, mock generation, dashboard UI |
| **Version** | Node.js 20.x with Express 4.18+ |
| **Language** | JavaScript (CommonJS) |
| **POC Hosting** | Render free tier (auto-sleep after 15 min inactivity) |
| **URL** | https://wmsports-mock-server.onrender.com |
| **License** | MIT |
| **POC Limitations** | Cold-start latency (~30-60s), no uptime SLA, single instance |

**How we use it:**
- Listens on port 4010 for GraphQL/REST requests
- Proxies requests to Microcks mock server
- Serves dashboard UI at root path
- Exposes `/ai/generate` endpoint for mock generation
- Handles LLM retries and Faker fallback internally

---

### 2. Microcks (Shared with Contract Testing)

| Attribute | Detail |
|-----------|--------|
| **What it does** | Schema-driven mock API server. Stores provider specs and serves consistent mock responses |
| **Version** | quay.io/microcks/microcks-uber:latest |
| **POC Hosting** | Docker container on Render (shared with Kartik's contract testing) |
| **URL** | https://microcks-uber-latest.onrender.com |
| **Database** | PostgreSQL (Render managed) |
| **License** | Apache 2.0 |
| **POC Status** | Production-ready, currently shared |

**How we use it:**
- Stores all imported OpenAPI/GraphQL schemas
- Provides consistent mock responses across services
- Acts as centralized mock repository for both mock generation and contract testing
- Pre-validates consumer expectations against schemas

**Shared Infrastructure Benefit:**
- Kartik's contract testing POC already deployed Microcks to Render
- Mock Server leverages the same Microcks instance
- **Significant cost reduction**: No separate Microcks hosting needed
- Eliminates data duplication: Schemas stored once, used by both systems

---

### 3. Groq API (Free LLM)

| Attribute | Detail |
|-----------|--------|
| **What it does** | Generates realistic mock data from schemas using AI |
| **Pricing Model** | Free tier: up to 30 requests/minute, ~3 RPM sustainable |
| **POC Hosting** | Cloud-based, requires API key in environment |
| **License** | Commercial (free tier available) |
| **API Latency** | 1-3 seconds per request |
| **Alternative** | Together AI (paid, same API format) |

**How we use it:**
- Primary mock data generation engine
- Takes schema + prompt → generates realistic JSON
- Retries up to 2x on failure
- Falls back to Faker if both attempts fail

**Cost in Production:**
- Free tier sufficient for POC and small production (~1000s of mock requests/day)
- If scaling beyond free tier: ~$0.30-0.50 per 1M tokens (~$10-15/mo for typical usage)

---

### 4. Faker.js

| Attribute | Detail |
|-----------|--------|
| **What it does** | Generates generic random mock data (fallback) |
| **License** | MIT |
| **Cost** | $0 (npm dependency) |
| **POC Role** | Fallback when LLM fails |

**How we use it:**
- Generates UUIDs, names, timestamps, numbers
- Ensures API never returns empty responses
- Complements LLM with deterministic fallback

---

### 5. GitHub Actions (Optional)

| Attribute | Detail |
|-----------|--------|
| **What it does** | CI/CD pipeline orchestration for mock generation |
| **POC Hosting** | GitHub-hosted runners (ubuntu-latest) |
| **Cost** | Included in GitHub Enterprise (BR already has this) |
| **Integration** | Optional — can run locally or via other CI systems |

---

## Current POC Architecture

```
┌─────────────────────────────────────────────────────┐
│              Render (Free Tier)                      │
│                                                     │
│  ┌──────────────────┐    ┌──────────────────────┐  │
│  │  Express Server   │    │  Microcks (Shared)   │  │
│  │  (Mock Generator) │◄──►│  (Schema Storage)    │  │
│  │  + Groq Retry     │    │                      │  │
│  │  + Faker Fallback │    │  Also used by:       │  │
│  └──────────────────┘    │  - Contract Testing  │  │
│                           │  - Integration Tests │  │
│                           └──────────────────────┘  │
└─────────────────────────────────────────────────────┘
                    │
                    │ HTTPS
                    ▼
        PostgreSQL (Render Managed)
```

### POC Limitations

| Issue | Impact | Solution |
|-------|--------|----------|
| Render free tier cold-start | 30-60s initial load | Move to production-grade hosting |
| Single Express instance | No high availability | Load balancing in production |
| Ephemeral Render setup | Data lost on deployment | Persistent storage + backups |
| Groq free tier limits | ~30 req/min, can throttle | Monitor usage, upgrade if needed |
| No monitoring/alerting | Silent failures possible | Add CloudWatch + Datadog |
| No authentication | Publicly accessible | Add API token layer |

---

## Production Deployment Options

### Important: Cost Disclaimer

All cost estimates below are rough ballpark figures based on AWS public on-demand pricing (us-east-1) for 2026. Actual costs for BR will differ based on:

- BR's Enterprise Discount Program (EDP) or negotiated AWS rates
- Reserved Instances / Savings Plans (can reduce costs 20-60%)
- Region-specific pricing (your actual region may differ)
- Data transfer costs (cross-AZ, internet egress — not included below)
- AWS Support tier costs (not included)

**Recommendation:** Validate these estimates with your Platform/DevOps team or AWS account manager who knows BR's actual contracted rates before making infrastructure decisions.

---

## Side-by-Side Comparison

| Criteria | EC2 (Recommended) | EKS (K8s) | ECS Fargate | Fly.io (Alternative) |
|----------|-----------------|-----------|------------|---------------------|
| **Est. Cost** | ~$20-45/mo* | ~$40-70/mo* (marginal) | ~$80-120/mo* | ~$15-35/mo |
| **Setup Complexity** | Low | High | Medium | Very Low |
| **Operational Overhead** | Low (Docker Compose) | Medium (shared cluster) | Low | Minimal |
| **Shared Microcks** | Yes (same EC2) | Optional (existing cluster) | Separate instance | Yes (same instance) |
| **High Availability** | No (single instance) | Yes (multi-pod) | Yes (multi-task) | Optional |
| **Team Ownership** | Any team | Platform team | Platform team | Any team |
| **Network Control** | Full (VPC) | Full (VPC) | Full (VPC) | Limited |
| **Cold-Start Latency** | None | ~10-30s | ~5-15s | ~30-60s |
| **Best For** | Cost-effective production | Already on EKS | Want managed containers | Fastest deployment |

*On-demand pricing estimates — actual BR costs will vary based on enterprise agreements.

---

## Option 1: AWS EC2 + Docker Compose (Recommended)

### Best for: 
Cost-effective production. The Mock Server workload (~100-300 mock requests/day, ~10 MB data) is lightweight enough that a single small instance handles it comfortably. **Shared Microcks with contract testing further reduces costs.**

### Architecture: Mock Server + Microcks (Shared)

```
┌──────────────────────────────────────┐
│  EC2 Instance (t3.medium)            │
│                                      │
│  ┌──────────────────────────────┐   │
│  │  Docker Compose              │   │
│  │                              │   │
│  │  ┌────────────────────────┐  │   │
│  │  │  Express Mock Server   │  │   │
│  │  │  (port 4010)           │  │   │
│  │  └────────────────────────┘  │   │
│  │                              │   │
│  │  ┌────────────────────────┐  │   │
│  │  │  Microcks              │  │   │
│  │  │  (port 8585)           │  │   │
│  │  │  [Shared with Contract │  │   │
│  │  │   Testing]             │  │   │
│  │  └────────────────────────┘  │   │
│  │                              │   │
│  │  ┌────────────────────────┐  │   │
│  │  │  PostgreSQL + MongoDB  │  │   │
│  │  │  (Docker containers)   │  │   │
│  │  └────────────────────────┘  │   │
│  └──────────────────────────────┘   │
│                                      │
│  EBS Storage: 30GB gp3              │
└──────────────────────────────────────┘
        │
        │ HTTPS (ALB or direct)
        ▼
    Public Endpoint
```

### Pricing Breakdown

| Component | Configuration | Est. Monthly Cost |
|-----------|---------------|-------------------|
| **EC2 Instance** | t3.medium (2 vCPU, 4GB RAM) | $25-30 |
| **EBS Storage** | 30GB gp3 (Express logs + Microcks data) | $2-3 |
| **PostgreSQL** | Docker on same instance (no separate RDS) | $0 |
| **MongoDB** | Docker on same instance (Microcks) | $0 |
| **NAT Gateway** | Optional (for private subnet) | $0-35 |
| **ALB** | Optional (for HA routing) | $0-20 |
| **Backup (S3)** | Daily snapshots (cheapest tier) | $1-2 |
| **Est. Total (Basic)** | **No ALB, single instance** | **~$28-35/mo** |
| **Est. Total (Prod-Ready)** | **With ALB + NAT + backups** | **~$50-70/mo** |

### Docker Compose Configuration

```yaml
version: '3.8'

services:
  mock-server:
    image: node:20-alpine
    working_dir: /app
    ports:
      - "4010:4010"
    volumes:
      - /app/server.cjs:/app/server.cjs
      - /app/artifacts:/app/artifacts
    environment:
      - PORT=4010
      - MICROCKS_URL=http://microcks:8585
      - GROQ_API_KEY=${GROQ_API_KEY}
      - NODE_ENV=production
    depends_on:
      - microcks
    restart: always
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4010/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  microcks:
    image: quay.io/microcks/microcks-uber:latest
    ports:
      - "8585:8585"
    environment:
      - MICROCKS_HTTP_PORT=8585
      - POSTMAN_DOWNLOAD_ENABLE=true
      - ASYNC_MINION_LOG_LEVEL=INFO
      - NETWORK_RESTRICTED=false
    depends_on:
      - postgres
      - mongodb
    restart: always
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8585/api/services"]
      interval: 30s
      timeout: 10s
      retries: 3
    volumes:
      - microcks-data:/microcks

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=microcks
    volumes:
      - postgres-data:/var/lib/postgresql/data
    restart: always

  mongodb:
    image: mongo:6-alpine
    volumes:
      - mongodb-data:/data/db
    restart: always

volumes:
  postgres-data:
  mongodb-data:
  microcks-data:
```

### Benefits

✅ **Extremely cost-effective** (~$28-70/mo for entire stack)  
✅ **Simple to manage** (Docker Compose on single EC2)  
✅ **Shared infrastructure** with contract testing (Microcks on same instance)  
✅ **All data persistent** (volumes survive restarts)  
✅ **Easy to backup** (EBS snapshots or rsync to S3)  
✅ **Sufficient for full BR adoption** (35-40 integration pairs estimated)  

### Considerations

⚠️ **Single point of failure** (no HA) — but mock server is a CI/CD tool, not user-facing. Brief downtime delays deployments, doesn't cause outages.  
⚠️ **Manual OS/Docker updates** — mitigated by using managed AMI with auto-patching  
⚠️ **Data backup responsibility** — automated via AWS Backup or cron to S3  

---

## Option 2: AWS EKS (If BR Already Has Kubernetes)

### Best for: 
Teams already running workloads on EKS who want to keep everything in the cluster. The workload is light enough that it adds minimal **marginal cost** to an existing cluster.

### Setup: Helm Chart on Existing EKS Cluster

```
┌────────────────────────────────────────────┐
│  Existing EKS Cluster (BR Shared)          │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Mock Server Pod (Namespace: mocks) │ │
│  │  - 256MB RAM, 0.25 vCPU              │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  Microcks Pod (Shared with Kartik)  │ │
│  │  - 512MB RAM, 0.5 vCPU               │ │
│  │  - [Same namespace: contract-testing]│ │
│  └──────────────────────────────────────┘ │
│                                            │
│  ┌──────────────────────────────────────┐ │
│  │  PostgreSQL (Separate or RDS)        │ │
│  │  - db.t3.micro if external           │ │
│  └──────────────────────────────────────┘ │
│                                            │
│  Shared: Node pool, networking, monitoring│
└────────────────────────────────────────────┘
```

### Pricing: Marginal Cost on Existing Cluster

| Component | Configuration | Est. Marginal Cost |
|-----------|---------------|-------------------|
| **Mock Server Pod** | 256MB, 0.25 vCPU | ~$2-3 (runs on existing node) |
| **Microcks Pod** | 512MB, 0.5 vCPU | ~$5-8 (runs on existing node) |
| **PostgreSQL** | In-cluster StatefulSet | ~$0 (marginal) |
| **MongoDB** | In-cluster pod (Microcks) | ~$0 (marginal) |
| **RDS Alternative** | db.t3.micro (managed) | ~$15-20 (if not in-cluster) |
| **Est. Total (In-Cluster DB)** | **No external databases** | **~$7-11/mo marginal** |
| **Est. Total (RDS)** | **Managed PostgreSQL only** | **~$20-30/mo marginal** |

**Key:** If BR already has EKS with spare node capacity, adding these pods costs essentially nothing beyond existing EKS fees. Only add RDS if in-cluster PostgreSQL is not an option.

### Benefits

✅ **Leverages existing infrastructure** — no new cluster cost  
✅ **Persistent Microcks for cross-team use** (same as EC2)  
✅ **Horizontal scaling** if needed (just add pod replicas)  
✅ **Integrated monitoring** with existing cluster observability  
✅ **Helm charts available** for easy deployment  

### Considerations

⚠️ **Requires Platform team involvement** for setup  
⚠️ **Kubernetes overhead** (upgrades, RBAC, networking) for a simple workload  
⚠️ **More complex than Docker Compose** for the same result  
✅ **Only choose if EKS already exists** — deploying new EKS just for this is overkill  

---

## Option 3: AWS ECS Fargate (Serverless Containers)

### Best for: 
Teams that want managed containers without Kubernetes overhead. **Not recommended** given EC2 cost-effectiveness and shared Microcks benefit.

### Architecture

```
Fargate Task (Mock Server) + Fargate Task (Microcks) + RDS PostgreSQL + DocumentDB
```

### Pricing Breakdown

| Component | Configuration | Est. Monthly Cost |
|-----------|---------------|-------------------|
| **Fargate Task (Mock Server)** | 0.5 vCPU, 1GB RAM, always-on | $20-25 |
| **Fargate Task (Microcks)** | 1 vCPU, 2GB RAM, always-on | $35-45 |
| **RDS PostgreSQL** | db.t3.micro | $15-20 |
| **DocumentDB (MongoDB)** | db.t3.medium | $30-50 |
| **ALB** | Application Load Balancer | $20-25 |
| **Est. Total** | **Full managed setup** | **~$120-165/mo** |

### Why Not Recommended

❌ **5-6x more expensive** than EC2 ($120-165/mo vs $28-35/mo)  
❌ **Over-engineered** for the workload  
❌ **No benefit** if shared Microcks reduces complexity  
✅ **Only consider if** organizational mandate for Fargate  

---

## Option 4: Fly.io (Alternative Cloud Platform)

### Best for: 
Fastest deployment, global edge caching, smallest DevOps footprint. Emerging platform with good pricing for lightweight workloads.

### Architecture

```
Fly.io Machines (Auto-scaling)
├── Mock Server (2 instances for HA)
├── Microcks (1-2 instances)
└── PostgreSQL + MongoDB (Fly Postgres / volumes)
```

### Pricing Breakdown

| Component | Configuration | Est. Monthly Cost |
|-----------|---------------|-------------------|
| **Mock Server Machines** | 2x shared-cpu-2x (HA) | $10-15 |
| **Microcks Machine** | 1x shared-cpu-4x | $8-12 |
| **Fly Postgres** | shared-cpu, 10GB volume | $5-8 |
| **Data volumes** | 30GB total | $3-5 |
| **Bandwidth** | Included first 160GB/mo | $0 |
| **Est. Total** | **Global deployment** | **~$26-40/mo** |

### Benefits

✅ **Global edge caching** out of box (low latency worldwide)  
✅ **Cheapest option** for truly global deployment  
✅ **Automatic HA** (2+ instances, automatic failover)  
✅ **Minimal DevOps** (Fly manages scaling, updates)  
✅ **Similar price to EC2** but with better features  

### Considerations

⚠️ **Smaller ecosystem** than AWS (less integration)  
⚠️ **Data residency concerns** (check compliance)  
⚠️ **Smaller support community** than AWS  
✅ **Great for** startups, small teams, global distribution  

---

## Option 5: Managed Service (PactFlow-style, Not Recommended)

| Platform | Cost | Issues |
|----------|------|--------|
| **PactFlow** | $99-399+/mo | Overkill; doesn't replace Microcks; complex pricing |
| **Cloudsmith** | $99-299+/mo | For artifact hosting, not mocking |
| **Custom SaaS** | $500+/mo | Not necessary for internal tool |

**Recommendation:** Use open-source Microcks (shared with contract testing) + EC2. Much cheaper, full control, meets all requirements.

---

## Recommended: Option 1 (AWS EC2) + Shared Microcks

### Why This Is the Best Choice

**Cost Efficiency:**
- Base: EC2 t3.medium (~$30/mo) + EBS (~$3/mo) = **~$33/mo**
- Microcks + PostgreSQL + MongoDB: **$0** (runs on same instance)
- Shared with contract testing: **Cost divided between two teams**
- Total for Mock Server: **~$15-20/mo after cost allocation**

**Operational Simplicity:**
- Single Docker Compose file manages everything
- Any team can deploy and maintain (no Platform team dependency)
- Easy to debug (SSH to instance, inspect containers)
- Automatic backups with EBS snapshots

**Scalability:**
- t3.medium comfortably handles:
  - Full BR adoption (~35-40 integration pairs)
  - ~300-450 interactions total
  - ~1000s of mock requests/day
  - ~10-15 MB stored data
- No migration needed until 10x growth

**Reliability:**
- Persistent data (EBS volumes)
- Daily automated backups to S3
- CloudWatch health checks + alerting
- Monitored uptime SLA (99.9% with ALB)

---

## Pricing Summary: All Options

| Option | Cost/Month | Setup Time | Best For | Risk Level |
|--------|-----------|-----------|----------|-----------|
| **EC2 (Basic)** | $28-35 | 1-2 hours | Cost-effective production | Low |
| **EC2 (Prod-Ready with ALB)** | $50-70 | 3-4 hours | High availability needed | Low |
| **EKS (Marginal)** | $40-70 | 1 hour (if cluster exists) | Already using Kubernetes | Medium |
| **ECS Fargate** | $120-165 | 2-3 hours | Want managed containers | High (waste) |
| **Fly.io** | $26-40 | 1 hour | Global distribution needed | Low |
| **Render (Current POC)** | $0-15/mo | Already deployed | Short-term development | High (cold-starts) |

---

## What Changes from POC to Production

| Aspect | POC (Current) | Production |
|--------|---------------|-----------|
| **Hosting** | Render free tier (public) | AWS EC2 or Fly.io (private) |
| **Microcks** | Render (shared with contract testing) | Same instance as Mock Server or EKS pod |
| **Express Server** | Render (auto-sleep) | EC2 always-on or Fly Machines with monitoring |
| **Databases** | Render managed | Docker containers on same instance |
| **Authentication** | None (public) | API tokens via AWS Secrets Manager |
| **Network** | Public internet | Private VPC with ALB or Fly private networking |
| **Data Backup** | None (ephemeral) | Automated daily to S3 |
| **Monitoring** | Manual checks | CloudWatch + Datadog + Slack alerts |
| **Environments** | Single (production-like) | dev, int, stage, prod with separate endpoints |
| **Data Retention** | Manual | Auto-cleanup of old schemas/mocks |
| **Uptime SLA** | None (best-effort) | 99.9% (with ALB + multi-AZ) |
| **Cost** | $0 (free tier) | $15-70/mo depending on option |

---

## Production Migration Steps

### Phase 1: Infrastructure Setup (Week 1)

1. **Create EC2 instance** (or Fly.io account)
   ```bash
   # EC2 example
   aws ec2 run-instances \
     --image-id ami-0c55b159cbfafe1f0 \
     --instance-type t3.medium \
     --key-name my-key \
     --security-groups mock-server-sg
   ```

2. **Install Docker + Docker Compose**
   ```bash
   # On EC2 instance
   curl -fsSL https://get.docker.com -o get-docker.sh
   sudo sh get-docker.sh
   sudo usermod -aG docker ec2-user
   ```

3. **Deploy via Docker Compose**
   ```bash
   git clone https://github.com/bleacherreport/wmsports-mock-server.git
   cd wmsports-mock-server
   docker-compose -f docker-compose.prod.yml up -d
   ```

4. **Verify Microcks + Express running**
   ```bash
   curl http://EC2_IP:4010/health
   curl http://EC2_IP:8585/api/services
   ```

### Phase 2: Networking & Security (Week 1)

1. **Set up private VPC** (optional but recommended)
   - Mock Server in private subnet
   - NAT Gateway for outbound
   - ALB in public subnet for ingress

2. **Configure security groups**
   - Port 4010 (Express) — ALB + GitHub Actions runners only
   - Port 8585 (Microcks) — internal only (EC2 same instance)
   - Port 5432 (PostgreSQL) — internal only
   - Port 27017 (MongoDB) — internal only

3. **Add API authentication** (not required for internal tool, but recommended)
   ```javascript
   // Add to Express middleware
   app.use((req, res, next) => {
     const token = req.headers.authorization?.split('Bearer ')[1];
     if (!token || !validateToken(token)) {
       return res.status(401).json({ error: 'Unauthorized' });
     }
     next();
   });
   ```

### Phase 3: Data & Backup (Week 2)

1. **Enable EBS automated snapshots**
   ```bash
   aws ec2 create-snapshot-schedule \
     --description "Daily mock-server backups" \
     --schedule-expression "cron(0 2 * * ? *)"
   ```

2. **Setup S3 bucket for backups**
   ```bash
   aws s3 mb s3://br-mock-server-backups-us-east-1
   ```

3. **Configure backup script** (runs daily via cron)
   ```bash
   #!/bin/bash
   docker exec postgres pg_dump -U postgres microcks | \
     gzip | \
     aws s3 cp - s3://br-mock-server-backups-us-east-1/db-$(date +%Y-%m-%d).sql.gz
   ```

### Phase 4: Monitoring & Alerting (Week 2)

1. **CloudWatch dashboards**
   - CPU/Memory usage
   - Disk space
   - Network I/O
   - Express request count

2. **Set up alerts**
   ```bash
   aws cloudwatch put-metric-alarm \
     --alarm-name mock-server-high-cpu \
     --alarm-description "Alert if Mock Server CPU > 80%" \
     --threshold 80 \
     --comparison-operator GreaterThanThreshold
   ```

3. **Slack integration** (via SNS)
   - Health check failures
   - Disk space warnings
   - Groq API rate limit hits

### Phase 5: DNS & Load Balancing (Week 3)

1. **Register DNS** (optional)
   ```bash
   # Route53 CNAME to ALB
   mock-server.bleacherreport.com CNAME → alb-12345.us-east-1.elb.amazonaws.com
   ```

2. **Configure ALB**
   - Health check: `http://mock-server:4010/health`
   - Sticky sessions (optional)
   - SSL termination

### Phase 6: Documentation & Handoff (Week 3)

1. **Create runbooks**
   - How to access EC2 instance
   - How to view logs
   - How to restart services
   - How to add new schemas

2. **Update GitHub Actions** (if using CI for deployments)
   ```yaml
   deploy:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v3
       - name: Deploy to Mock Server
         env:
           EC2_IP: ${{ secrets.MOCK_SERVER_EC2_IP }}
           SSH_KEY: ${{ secrets.MOCK_SERVER_SSH_KEY }}
         run: |
           scp -i key.pem server.cjs ec2-user@${EC2_IP}:/app/
           ssh -i key.pem ec2-user@${EC2_IP} 'docker-compose restart mock-server'
   ```

---

## Full-Scale Projection: Based on Actual BR Architecture

### Protocol Breakdown from Architecture Diagram

| Protocol | Services | Nature | Estimate |
|----------|----------|--------|----------|
| **GraphQL (Supergraph ↔ Subgraphs)** | ~11 subgraphs | Dominant protocol | 11-13 pairs, 165-275 interactions |
| **REST (Internal + 3rd-party)** | BMM, CVS, Census, Embedder, etc. | Scattered | 12-14 pairs, 70-110 interactions |
| **Kafka (Confluent Cloud)** | CMS, CMA, PN, etc. | Moderate | 8-10 pairs, 20-40 interactions |
| **RabbitMQ (CloudAMQP)** | PN, Census | Minimal | 2-3 pairs, 10-15 interactions |

### Realistic Scale Estimates

| Metric | POC (Current) | Full Adoption (All Services) |
|--------|---------------|-----------------------------|
| **Consumer-provider pairs** | 15 | ~35-40 |
| **Total interactions** | 147 | ~280-450 |
| **Mock requests/day** | ~100-300 | ~500-2000 |
| **Stored data** | ~2-5 MB | ~10-15 MB |
| **API calls/day** | ~50-100 | ~150-400 |
| **Peak concurrency** | <5 | <20 |
| **Express memory footprint** | ~200MB | ~400-500MB |
| **Microcks memory footprint** | ~400MB | ~800MB-1GB |

### Why EC2 t3.medium Is Sufficient for Full Scale

- **CPU:** 2 vCPU handles ~1000 concurrent requests/sec; mock server averages ~5-10 req/sec
- **Memory:** 4GB easily fits Express (500MB) + Microcks (1GB) + PostgreSQL (500MB) + MongoDB (500MB) + buffer
- **Storage:** 30GB EBS holds years of schema/mock data
- **Network:** 1GB/sec ENI capacity vs ~50MB/sec realistic peak usage

**Conclusion:** EC2 t3.medium with 30GB EBS covers full adoption with 5x headroom. No migration needed until 10x+ scale.

---

## Cost Projection: POC → Full Adoption

| Stage | Services | Pairs | Cost/Month | Notes |
|-------|----------|-------|-----------|-------|
| **POC (Now)** | 4 | 15 | $0 (Render free) | Short-term only |
| **Transition** | 4 | 15 | $15-20 | Move to EC2 basic |
| **Full Adoption** | ~11 | ~35-40 | $15-20 | Same EC2 instance |
| **With HA** | ~11 | ~35-40 | $50-70 | Add ALB + multi-AZ |
| **With RDS** | ~11 | ~35-40 | $30-50 | Replace local PostgreSQL |

**Key Insight:** Cost does NOT scale with services. One t3.medium instance covers POC through full adoption (~11 subgraphs). Upgrade only if BR exceeds 40+ integration pairs (unlikely in next 2-3 years).

---

## Security Checklist

| Concern | Recommendation | Status |
|---------|----------------|--------|
| **Authentication** | API tokens stored in AWS Secrets Manager | □ Todo |
| **Network Access** | Mock Server in private subnet, ALB in public | □ Todo |
| **IAM Roles** | EC2 instance profile with S3 backup permissions | □ Todo |
| **Secrets Management** | Groq API key in AWS Secrets Manager, not .env | □ Todo |
| **Data Encryption** | EBS encryption enabled (AWS default) | □ Todo |
| **SSL/TLS** | ALB terminates HTTPS, internal traffic unencrypted | □ Todo |
| **Backup Encryption** | S3 SSE-S3 encryption for backups | □ Todo |
| **Access Logging** | CloudTrail logging for all AWS API calls | □ Todo |
| **RBAC** | Only Platform/DevOps team SSH access to EC2 | □ Todo |

---

## Monitoring & Observability

### CloudWatch Metrics to Track

```
Mock Server:
- express_requests_total (counter)
- express_request_duration_seconds (histogram)
- express_errors_total (counter)
- groq_api_calls_total (counter)
- groq_api_failures_total (counter)
- faker_fallback_count (counter)
- json_parse_errors (counter)

Microcks:
- microcks_mock_requests_total (counter)
- microcks_spec_validation_errors (counter)
- microcks_uptime_percentage (gauge)

Infrastructure:
- ec2_cpu_utilization (%)
- ec2_memory_utilization (%)
- ec2_disk_utilization (%)
- ec2_network_in/out (bytes)
- rds_cpu_utilization (if separate RDS)
- backup_completion_status (success/failure)
```

### Alerts to Set Up

```
Critical:
- Mock Server down > 5 min → Page on-call
- Microcks down > 5 min → Page on-call
- Disk space < 5GB → Warning
- Groq API rate limit hit → Warning (auto-fallback to Faker)

Warning:
- CPU > 80% for 10 min → Slack notification
- Memory > 3GB of 4GB → Slack notification
- Backup failed → Slack notification
- API response time > 2s → Slack notification
```

---

## Final Recommendation

### Recommended Setup for Production

**Infrastructure:** AWS EC2 t3.medium with Docker Compose  
**Cost:** ~$15-20/mo (after Microcks cost-share with contract testing)  
**High Availability:** Not required (mock server is a CI/CD tool, not user-facing)  
**Deployment Timeline:** 2-3 weeks including security & monitoring  
**Scaling:** Covers full BR adoption (~35-40 integration pairs, ~450 interactions)  

### Cost Allocation with Contract Testing

Since both Mock Server and Contract Testing use Microcks:

```
Microcks + PostgreSQL + MongoDB infrastructure cost: ~$33-40/mo
├── Contract Testing: ~$16-20/mo (50%)
└── Mock Server: ~$16-20/mo (50%)

Plus Mock Server Express server: ~$8-10/mo (not shared)

Total Mock Server: ~$24-30/mo
```

### Deployment Path

1. **Week 1:** Provision EC2 + Docker Compose, test with POC data
2. **Week 2:** Add backups, monitoring, security hardening
3. **Week 3:** DNS setup, load balancer (optional), documentation
4. **Week 4:** Transition from Render to production, monitor for stability

---

## References

- **AWS EC2 Pricing:** https://aws.amazon.com/ec2/pricing/on-demand/
- **Microcks Documentation:** https://microcks.io
- **Fly.io Pricing:** https://fly.io/docs/about/pricing/
- **Docker Compose Reference:** https://docs.docker.com/compose/reference/
- **CloudWatch Monitoring:** https://docs.aws.amazon.com/cloudwatch/

