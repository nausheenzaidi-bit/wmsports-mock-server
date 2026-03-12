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
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    const graphqlList = Object.entries(graphqlServices).map(([name, entry]) => ({
      service: name, endpoint: `/graphql/${name}`, schema: entry.file,
    }));
    return res.json({ graphql: graphqlList, rest: 'Census + StatMilk', health: '/health' });
  }

  const host = `${req.protocol}://${req.get('host')}`;
  const rows = Object.entries(graphqlServices).map(([name]) =>
    `<tr>
      <td><strong>${name}</strong></td>
      <td>GraphQL</td>
      <td><code>POST ${host}/graphql/${name}</code></td>
      <td><button onclick="tryGraphQL('${name}')">Try it</button></td>
    </tr>`
  ).join('\n');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WM Sports Mock Server</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f1117;color:#e1e4e8;padding:2rem}
  h1{font-size:1.8rem;margin-bottom:.3rem;color:#fff}
  .subtitle{color:#8b949e;margin-bottom:2rem;font-size:.95rem}
  .stats{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
  .stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem 1.5rem;min-width:150px}
  .stat-num{font-size:2rem;font-weight:700;color:#58a6ff}
  .stat-label{color:#8b949e;font-size:.85rem}
  h2{font-size:1.2rem;margin:1.5rem 0 .8rem;color:#c9d1d9}
  table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
  th{background:#1c2128;text-align:left;padding:.7rem 1rem;color:#8b949e;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.6rem 1rem;border-top:1px solid #21262d;font-size:.9rem}
  code{background:#1c2128;padding:2px 6px;border-radius:4px;font-size:.85rem;color:#79c0ff}
  button{background:#238636;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.8rem}
  button:hover{background:#2ea043}
  .rest-section{margin-top:1rem}
  .rest-endpoint{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:.5rem 1rem;margin:.4rem 0;font-size:.9rem;display:flex;align-items:center;gap:.5rem}
  .method{padding:2px 8px;border-radius:3px;font-weight:700;font-size:.75rem;min-width:45px;text-align:center}
  .get{background:#1f6feb;color:#fff}.post{background:#238636;color:#fff}
  #result{background:#1c2128;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-top:1rem;white-space:pre-wrap;font-family:monospace;font-size:.85rem;max-height:400px;overflow:auto;display:none;color:#7ee787}
  .footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #21262d;color:#484f58;font-size:.8rem}
  a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>WM Sports Unified Mock Server</h1>
<p class="subtitle">All team services mocked from a single URL — GraphQL + REST</p>

<div class="stats">
  <div class="stat"><div class="stat-num">${Object.keys(graphqlServices).length}</div><div class="stat-label">GraphQL Subgraphs</div></div>
  <div class="stat"><div class="stat-num">10</div><div class="stat-label">REST Endpoints</div></div>
  <div class="stat"><div class="stat-num">38</div><div class="stat-label">Artifacts Loaded</div></div>
</div>

<h2>GraphQL Services</h2>
<p style="color:#8b949e;font-size:.85rem;margin-bottom:.5rem">Unified endpoint: <code>POST ${host}/graphql</code> (auto-routes to matching schema)</p>
<table>
<thead><tr><th>Service</th><th>Protocol</th><th>Endpoint</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>

<h2>REST Endpoints (Census API)</h2>
<div class="rest-section">
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/push_notifications</code><span style="color:#8b949e;font-size:.8rem">List notifications</span></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/push_notifications/:id</code><span style="color:#8b949e;font-size:.8rem">Get by ID</span></div>
  <div class="rest-endpoint"><span class="method post">POST</span><code>/v3/push_notifications</code><span style="color:#8b949e;font-size:.8rem">Create notification</span></div>
  <div class="rest-endpoint"><span class="method post">POST</span><code>/v3/:tenant/users/:userId/device</code><span style="color:#8b949e;font-size:.8rem">Register device</span></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/tags/:tagUUID/subscriptions/count</code><span style="color:#8b949e;font-size:.8rem">Follower count</span></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/tags/:tagUUID/subscriptions</code><span style="color:#8b949e;font-size:.8rem">Subscribers</span></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/user/:userId/tags</code><span style="color:#8b949e;font-size:.8rem">User tags</span></div>
  <div class="rest-endpoint"><span class="method post">POST</span><code>/v3/alert_buzz/ranks</code><span style="color:#8b949e;font-size:.8rem">Alert ranks</span></div>
</div>

<h2>REST Endpoints (StatMilk)</h2>
<div class="rest-section">
  <div class="rest-endpoint"><span class="method get">GET</span><code>/statmilk/*</code><span style="color:#8b949e;font-size:.8rem">StatMilk data</span></div>
</div>

<div id="result"></div>

<div class="footer">
  <a href="/health">Health Check</a> &middot;
  <a href="https://github.com/nausheenzaidi-bit/wmsports-mock-server">GitHub</a> &middot;
  Powered by @graphql-tools/mock + Express
</div>

<script>
async function tryGraphQL(service) {
  const el = document.getElementById('result');
  el.style.display = 'block';
  el.textContent = 'Loading...';
  try {
    const r = await fetch('/graphql/' + service, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({query:'{ __schema { queryType { name } mutationType { name } types { name kind } } }'})
    });
    const data = await r.json();
    const types = (data.data?.__schema?.types || []).filter(t => !t.name.startsWith('__'));
    el.textContent = service + ' — ' + types.length + ' types\\n\\nQueries: ' +
      (data.data?.__schema?.queryType?.name || 'none') +
      '\\nMutations: ' + (data.data?.__schema?.mutationType?.name || 'none') +
      '\\n\\nTypes:\\n' + types.map(t => '  ' + t.kind.padEnd(12) + t.name).join('\\n');
  } catch(e) { el.textContent = 'Error: ' + e.message; }
}
</script>
</body>
</html>`);
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
