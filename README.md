# WM Sports Unified Mock Server

Single deployable mock server for **all** WM Sports team services — 15 GraphQL subgraphs + Census REST + StatMilk REST.

## Quick Start

```bash
npm install
npm start
# → http://localhost:4010
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard — lists all services |
| `GET /health` | Health check |
| `POST /graphql` | Unified GraphQL (auto-routes to matching schema) |
| `POST /graphql/:service` | Specific subgraph |
| `GET/POST /v3/...` | Census REST API |
| `GET /statmilk/*` | StatMilk REST API |
| `* /rest/*` | Microcks proxy (when running with Docker) |

## Available GraphQL Subgraphs

| Service | Endpoint |
|---------|----------|
| AdsAPI | `/graphql/ads-api` |
| CmsAPI | `/graphql/cms-api` |
| ContentModulesAPI | `/graphql/content-modules-api` |
| DataServiceAPI | `/graphql/data-service-api` |
| EpisodeAPI | `/graphql/episode-api` |
| HydrationStationAPI | `/graphql/hydration-station-api` |
| LivelikeAPI | `/graphql/livelike-api` |
| PushNotificationAPI | `/graphql/push-notification-api` |
| ReferenceStreamAPI | `/graphql/reference-stream-api` |
| SocialProcessorAPI | `/graphql/social-processor-api` |
| SportsSearchAPI | `/graphql/sports-search-api` |
| StatsAPI | `/graphql/stats-api` |
| TagAPI | `/graphql/tag-api` |
| UserAPI | `/graphql/user-api` |

## Example Usage

```bash
# GraphQL — Push Notifications
curl -X POST http://localhost:4010/graphql/push-notification-api \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getAllNotifications(tenant: bleacherReport) { id title text } }"}'

# GraphQL — Stats API
curl -X POST http://localhost:4010/graphql/stats-api \
  -H "Content-Type: application/json" \
  -d '{"query":"{ getGamesByGameDate(startDate:\"2026-01-01\",endDate:\"2026-01-02\",timezone:1) { id name score { away home } } }"}'

# REST — Census
curl http://localhost:4010/v3/bleacherReport/push_notifications

# REST — Create notification
curl -X POST http://localhost:4010/v3/push_notifications \
  -H "Content-Type: application/json" \
  -d '{"tenant":"bleacherReport","title":"Test","text":"Hello"}'
```

## Docker (with Microcks for full REST/AsyncAPI support)

```bash
docker compose up
# Mock server → http://localhost:4010
# Microcks UI → http://localhost:8585
```

## Deploy to Render

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → New → Web Service
3. Connect repo, set Root Directory to `.`
4. Build: `npm install --production` | Start: `node server.cjs`
5. Add env var `PORT=4010`

Or use the `render.yaml` blueprint for one-click deploy.

## Architecture

- **GraphQL**: `@graphql-tools/mock` — schema-driven, returns realistic typed data
- **REST**: Built-in Express routes for Census + StatMilk (no external deps)
- **Microcks proxy**: Optional `/rest/*` proxy to Microcks for Postman-collection-driven responses
- **Artifacts**: All schemas, OpenAPI specs, AsyncAPI specs, and Postman collections in `artifacts/`
