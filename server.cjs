#!/usr/bin/env node
/**
 * WM Sports Unified Mock Server
 *
 * Serves mock data for ALL team services from a single URL:
 *   /graphql/:service     → @graphql-tools/mock (schema-driven, variable-aware)
 *   /rest/...             → Proxy to Microcks (OpenAPI-driven)
 *   /                     → Dashboard listing all available services
 *
 * GraphQL schemas are loaded from ./artifacts/*.graphql
 * REST/Async specs are served by the Microcks sidecar container.
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildSchema, graphql, print } = require('graphql');
const { addMocksToSchema } = require('@graphql-tools/mock');
const { makeExecutableSchema } = require('@graphql-tools/schema');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 4010;
const MICROCKS_URL = process.env.MICROCKS_URL || 'http://localhost:8585';
const ARTIFACTS_DIR = path.resolve(__dirname, 'artifacts');

// ── Load all GraphQL schemas ──────────────────────────────────────────────

const graphqlServices = {};
const schemaFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.graphql'));

for (const file of schemaFiles) {
  const raw = fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8');
  const serviceName = file
    .replace(/-schema\.graphql$/, '')
    .replace(/\.graphql$/, '');

  // Strip federation directives that @graphql-tools can't parse
  const cleaned = raw
    .replace(/extend schema[\s\S]*?(?=\n\n|\nscalar|\nenum|\ntype|\ninput|\ndirective)/m, '')
    .replace(/@link\([^)]*\)/g, '')
    .replace(/@key\([^)]*\)/g, '')
    .replace(/@shareable/g, '')
    .replace(/@requires\([^)]*\)/g, '')
    .replace(/@external/g, '')
    .replace(/@inaccessible/g, '')
    .replace(/@cacheControl\([^)]*\)/g, '')
    .replace(/directive @cacheControl[\s\S]*?(?:UNION|ARGUMENT_DEFINITION)\s*/m, '')
    .replace(/enum CacheControlScope \{[^}]*\}\s*/m, '');

  try {
    const schema = makeExecutableSchema({ typeDefs: cleaned });
    const mockedSchema = addMocksToSchema({
      schema,
      mocks: buildServiceMocks(serviceName),
      preserveResolvers: false,
    });
    graphqlServices[serviceName] = { schema: mockedSchema, file };
    console.log(`  ✓ Loaded GraphQL: ${serviceName} (${file})`);
  } catch (err) {
    console.log(`  ✗ Failed to load ${file}: ${err.message.split('\n')[0]}`);
  }
}

function buildServiceMocks(serviceName) {
  const base = {
    ID: () => `mock-${serviceName}-${Math.floor(Math.random() * 100000)}`,
    String: () => `mock-${serviceName}-string`,
    Int: () => Math.floor(Math.random() * 1000),
    Float: () => Math.round(Math.random() * 100 * 100) / 100,
    Boolean: () => Math.random() > 0.5,
    DateTime: () => new Date().toISOString(),
  };

  const serviceSpecific = {
    'push-notification-api': {
      ...base,
      PushNotification: () => ({
        id: String(Math.floor(Math.random() * 100000)),
        createdAt: new Date().toISOString(),
        title: 'Mock: Breaking News Alert',
        text: 'This is a mock push notification from the unified mock server',
        url: 'https://bleacherreport.com/articles/mock-12345',
        spoiler: false,
        showAlertCard: true,
        createdBy: 'mock-editor-001',
      }),
      Device: () => ({
        id: Math.floor(Math.random() * 1000),
        token: 'mock-fcm-token-xyz',
        type: 'IPHONE',
        appVersion: '5.0.0',
        osVersion: '17.0',
      }),
    },
    'stats-api': {
      ...base,
      String: () => {
        const samples = ['Lakers', 'Warriors', 'Celtics', 'Heat', 'Nuggets'];
        return samples[Math.floor(Math.random() * samples.length)];
      },
    },
    'cms-api': {
      ...base,
      String: () => 'mock-cms-content',
    },
  };

  return serviceSpecific[serviceName] || base;
}

// ── GraphQL endpoint per service ──────────────────────────────────────────

app.post('/graphql/:service', async (req, res) => {
  const serviceName = req.params.service;
  const entry = graphqlServices[serviceName];
  if (!entry) {
    return res.status(404).json({
      error: `Unknown service: ${serviceName}`,
      available: Object.keys(graphqlServices),
    });
  }

  const { query, variables, operationName } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Missing query in request body' });
  }

  try {
    const result = await graphql({
      schema: entry.schema,
      source: query,
      variableValues: variables,
      operationName,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ errors: [{ message: err.message }] });
  }
});

// ── Unified /graphql endpoint (tries all schemas) ──────────────────────────

app.post('/graphql', async (req, res) => {
  const { query, variables, operationName } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Missing query in request body' });
  }

  for (const [name, entry] of Object.entries(graphqlServices)) {
    try {
      const result = await graphql({
        schema: entry.schema,
        source: query,
        variableValues: variables,
        operationName,
      });
      if (!result.errors || result.errors.length === 0) {
        return res.json(result);
      }
    } catch (_) {}
  }

  res.status(400).json({
    error: 'Query did not match any loaded schema',
    availableServices: Object.keys(graphqlServices),
    hint: 'Use /graphql/:service for a specific subgraph',
  });
});

// ── Built-in REST mocks (no Microcks needed) ─────────────────────────────

const { setupRestRoutes } = require('./rest-mocks.cjs');
setupRestRoutes(app);

// ── REST proxy to Microcks (when available) ──────────────────────────────

app.all('/rest/*', (req, res) => {
  const targetPath = '/rest/' + req.params[0] + (req._parsedUrl.search || '');
  const url = new URL(targetPath, MICROCKS_URL);

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.host },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    Object.entries(proxyRes.headers).forEach(([k, v]) => res.setHeader(k, v));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.status(502).json({
      error: 'Microcks proxy error',
      detail: err.message,
      hint: `Is Microcks running at ${MICROCKS_URL}?`,
    });
  });

  if (req.body && Object.keys(req.body).length > 0) {
    proxyReq.write(JSON.stringify(req.body));
  }
  proxyReq.end();
});

// ── Dashboard ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const graphqlList = Object.entries(graphqlServices).map(([name, entry]) => ({
    service: name,
    endpoint: `/graphql/${name}`,
    schema: entry.file,
  }));

  res.json({
    name: 'WM Sports Unified Mock Server',
    description: 'All team services mocked from a single URL',
    graphql: {
      unified: '/graphql',
      perService: graphqlList,
      totalServices: graphqlList.length,
    },
    rest: {
      builtIn: {
        census: {
          listNotifications: 'GET /v3/:tenant/push_notifications',
          getById: 'GET /v3/:tenant/push_notifications/:id',
          create: 'POST /v3/push_notifications',
          registerDevice: 'POST /v3/:tenant/users/:userId/device',
          followerCount: 'GET /v3/:tenant/tags/:tagUUID/subscriptions/count',
          subscribers: 'GET /v3/:tenant/tags/:tagUUID/subscriptions',
          userTags: 'GET /v3/:tenant/user/:userId/tags',
          alertRanks: 'POST /v3/alert_buzz/ranks',
        },
        statmilk: 'GET /statmilk/*',
      },
      microcksProxy: '/rest/* (proxied to Microcks when available)',
    },
    health: '/health',
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    graphqlServices: Object.keys(graphqlServices).length,
    microcksProxy: MICROCKS_URL,
    uptime: process.uptime(),
  });
});

// ── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════════════════════════╗`);
  console.log(`  ║  WM Sports Unified Mock Server                            ║`);
  console.log(`  ╠═══════════════════════════════════════════════════════════╣`);
  console.log(`  ║  GraphQL: ${Object.keys(graphqlServices).length} subgraphs loaded                        ║`);
  console.log(`  ║  REST:    Proxied to Microcks at ${MICROCKS_URL.substring(0, 25).padEnd(25)}║`);
  console.log(`  ║  URL:     http://localhost:${PORT}                            ║`);
  console.log(`  ╚═══════════════════════════════════════════════════════════╝\n`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /                         → Dashboard`);
  console.log(`    POST /graphql                  → Unified (auto-routes to matching schema)`);
  console.log(`    POST /graphql/:service         → Specific subgraph`);
  console.log(`    *    /rest/...                  → Microcks proxy (Census, StatMilk)\n`);
});
