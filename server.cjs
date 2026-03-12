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

  const sampleQueriesObj = {
    'push-notification-api': '{\n  getAllNotifications(tenant: bleacherReport, limit: 3) {\n    id\n    title\n    text\n    createdAt\n    spoiler\n    alertCategories\n    destinations { tagUUID contentModuleId }\n    attachments { mediaType mediaUrl }\n    analytics { genres gamecastType }\n  }\n}',
    'stats-api': '{\n  getGamesByGameDate(\n    startDate: "2026-03-01"\n    endDate: "2026-03-02"\n    timezone: 1\n  ) {\n    id\n    name\n    gameDate { iso8501 }\n    score { away home }\n    home { name abbreviation logo }\n    away { name abbreviation logo }\n    status\n    sport { league sport }\n  }\n}',
    'cms-api': '{\n  getArticleByCmsId(\n    cmsId: "test-article-001"\n    tenant: bleacherReport\n  ) {\n    uuid\n    cmsId\n    schemaVersion\n    tenant\n    contentType\n    created\n    isPublished\n  }\n}',
    'ads-api': '{ __schema { mutationType { fields { name description } } } }',
    'content-modules-api': '{\n  contentModules {\n    id\n  }\n}',
    'data-service-api': '{\n  trendingArticles(topN: 5) {\n    type\n    contentID\n    rank\n  }\n}',
    'episode-api': '{\n  getScheduleByFeeds(\n    feed: CDFH_CL\n    count: 5\n  ) {\n    dateFrom\n    dateTo\n    feeds {\n      code\n      link\n      logo\n      description\n    }\n  }\n}',
    'hydration-station-api': '{\n  getTweetsByIds(ids: ["1234567890"]) {\n    id\n    type\n  }\n}',
    'livelike-api': '# LiveLike schema has interface compatibility issues\\n# Use introspection to explore:\\n{ __schema { types { name kind } } }',
    'reference-stream-api': '{\n  getReferenceStreamByName(\n    referenceStreamName: "trending"\n    limit: 5\n  ) {\n    id\n    title\n    description\n    thumbnailUrl\n    permalink\n    url\n    type\n  }\n}',
    'social-processor-api': '{\n  getMediaId(id: "social-post-001")\n}',
    'sports-search-api': '{\n  popularSearches(\n    tenant: bleacherReport\n    first: 5\n  ) {\n    results {\n      term\n    }\n  }\n}',
    'tag-api': '{\n  getTagById(\n    id: "tag-001"\n    tenant: bleacherReport\n  ) {\n    id\n    name\n    permalink\n    type\n    abbreviation\n  }\n}',
    'user-api': '{\n  findTagByMatchTerm(\n    term: "sports"\n    tenant: bleacherReport\n  ) {\n    id\n    name\n    permalink\n  }\n}',
    'schema': '{\n  getScores(timezone: -5) {\n    leagues {\n      id\n      name\n    }\n  }\n}',
  };
  const sampleQueriesJson = JSON.stringify(sampleQueriesObj);

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
  .rest-endpoint{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:.5rem 1rem;margin:.4rem 0;font-size:.9rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .method{padding:2px 8px;border-radius:3px;font-weight:700;font-size:.75rem;min-width:45px;text-align:center}
  .get{background:#1f6feb;color:#fff}.post{background:#238636;color:#fff}
  .rest-endpoint button{margin-left:auto}
  .playground{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1.2rem;margin-top:1.5rem;display:none}
  .playground.visible{display:block}
  .playground h3{color:#c9d1d9;margin-bottom:.8rem;font-size:1rem;display:flex;align-items:center;gap:.5rem}
  .playground h3 .close{margin-left:auto;background:#21262d;padding:2px 8px;font-size:.75rem;cursor:pointer;border-radius:3px}
  .playground h3 .close:hover{background:#30363d}
  .pg-row{display:flex;gap:1rem;margin-bottom:.8rem;flex-wrap:wrap}
  .pg-col{flex:1;min-width:300px}
  .pg-col label{display:block;color:#8b949e;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem}
  textarea{width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:"SF Mono",Menlo,monospace;font-size:.85rem;padding:.8rem;resize:vertical}
  .pg-query{min-height:120px}
  .pg-vars{min-height:80px}
  .pg-actions{display:flex;gap:.5rem;align-items:center;margin-bottom:.8rem}
  .pg-actions button.run{background:#238636;padding:6px 20px;font-size:.9rem;font-weight:600}
  .pg-actions button.run:hover{background:#2ea043}
  .pg-actions span{color:#8b949e;font-size:.8rem}
  .pg-result{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.8rem;font-family:"SF Mono",Menlo,monospace;font-size:.85rem;color:#7ee787;max-height:400px;overflow:auto;white-space:pre-wrap;min-height:60px}
  .pg-result.error{color:#f85149}
  .pg-status{display:inline-block;padding:1px 6px;border-radius:3px;font-size:.75rem;font-weight:600;margin-left:.5rem}
  .pg-status.s2{background:#238636;color:#fff}.pg-status.s4{background:#da3633;color:#fff}.pg-status.s5{background:#da3633;color:#fff}
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
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/push_notifications</code><span style="color:#8b949e;font-size:.8rem">List notifications</span><button onclick="tryRest('GET','/v3/bleacherReport/push_notifications')">Try it</button></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/push_notifications/:id</code><span style="color:#8b949e;font-size:.8rem">Get by ID</span><button onclick="tryRest('GET','/v3/bleacherReport/push_notifications/12345')">Try it</button></div>
  <div class="rest-endpoint"><span class="method post">POST</span><code>/v3/push_notifications</code><span style="color:#8b949e;font-size:.8rem">Create notification</span><button onclick="tryRest('POST','/v3/push_notifications',{tenant:'bleacherReport',title:'Test Alert',text:'Hello from mock server'})">Try it</button></div>
  <div class="rest-endpoint"><span class="method post">POST</span><code>/v3/:tenant/users/:userId/device</code><span style="color:#8b949e;font-size:.8rem">Register device</span><button onclick="tryRest('POST','/v3/bleacherReport/users/user-001/device',{device:{device_token:'test-token',platform:'iOS iPhone'}})">Try it</button></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/tags/:tagUUID/subscriptions/count</code><span style="color:#8b949e;font-size:.8rem">Follower count</span><button onclick="tryRest('GET','/v3/bleacherReport/tags/tag-001/subscriptions/count')">Try it</button></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/tags/:tagUUID/subscriptions</code><span style="color:#8b949e;font-size:.8rem">Subscribers</span><button onclick="tryRest('GET','/v3/bleacherReport/tags/tag-001/subscriptions')">Try it</button></div>
  <div class="rest-endpoint"><span class="method get">GET</span><code>/v3/:tenant/user/:userId/tags</code><span style="color:#8b949e;font-size:.8rem">User tags</span><button onclick="tryRest('GET','/v3/bleacherReport/user/user-001/tags')">Try it</button></div>
  <div class="rest-endpoint"><span class="method post">POST</span><code>/v3/alert_buzz/ranks</code><span style="color:#8b949e;font-size:.8rem">Alert ranks</span><button onclick="tryRest('POST','/v3/alert_buzz/ranks',{alertRanks:[{pushNotificationId:'123',rank:5}]})">Try it</button></div>
</div>

<h2>REST Endpoints (StatMilk)</h2>
<div class="rest-section">
  <div class="rest-endpoint"><span class="method get">GET</span><code>/statmilk/*</code><span style="color:#8b949e;font-size:.8rem">StatMilk data</span><button onclick="tryRest('GET','/statmilk/test')">Try it</button></div>
</div>

<div id="playground" class="playground">
  <h3>
    <span id="pg-title">Playground</span>
    <button class="close" onclick="closePg()">Close</button>
  </h3>
  <div class="pg-row">
    <div class="pg-col">
      <label>Query</label>
      <textarea id="pg-query" class="pg-query" spellcheck="false"></textarea>
    </div>
    <div class="pg-col">
      <label>Variables (JSON)</label>
      <textarea id="pg-vars" class="pg-vars" spellcheck="false">{}</textarea>
    </div>
  </div>
  <div class="pg-actions">
    <button class="run" id="pg-run" onclick="runQuery()">Run Query</button>
    <span id="pg-timing"></span>
  </div>
  <label style="color:#8b949e;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem;display:block">Response</label>
  <div id="pg-result" class="pg-result">Click "Run Query" to see the response</div>
</div>

<div class="footer">
  <a href="/health">Health Check</a> &middot;
  <a href="https://github.com/nausheenzaidi-bit/wmsports-mock-server">GitHub</a> &middot;
  Powered by @graphql-tools/mock + Express
</div>

<script>
let currentService = '';
let currentMode = 'graphql';

const sampleQueries = ${sampleQueriesJson};

function tryGraphQL(service) {
  currentService = service;
  currentMode = 'graphql';
  const pg = document.getElementById('playground');
  pg.classList.add('visible');
  document.getElementById('pg-title').innerHTML = 'GraphQL: <strong>' + service + '</strong>';
  document.getElementById('pg-query').value = sampleQueries[service] || '{ __schema { queryType { fields { name description } } } }';
  document.getElementById('pg-vars').value = '{}';
  document.getElementById('pg-result').textContent = 'Click "Run Query" to see the response';
  document.getElementById('pg-result').className = 'pg-result';
  document.getElementById('pg-timing').textContent = '';
  document.getElementById('pg-run').textContent = 'Run Query';
  const qEl = document.getElementById('pg-query');
  qEl.parentElement.querySelector('label').textContent = 'Query';
  qEl.readOnly = false;
  qEl.style.opacity = '1';
  document.getElementById('pg-vars').parentElement.style.display = '';
  pg.scrollIntoView({behavior:'smooth'});
}

function tryRest(method, path, body) {
  currentMode = 'rest';
  const pg = document.getElementById('playground');
  pg.classList.add('visible');
  document.getElementById('pg-title').innerHTML = 'REST: <strong>' + method + ' ' + path + '</strong>';

  const queryEl = document.getElementById('pg-query');
  const queryLabel = queryEl.parentElement.querySelector('label');
  if (method === 'GET') {
    queryLabel.textContent = 'URL';
    queryEl.value = path;
    queryEl.readOnly = true;
    queryEl.style.opacity = '0.7';
  } else {
    queryLabel.textContent = 'Request Body (JSON)';
    queryEl.value = body ? JSON.stringify(body, null, 2) : '{}';
    queryEl.readOnly = false;
    queryEl.style.opacity = '1';
  }

  document.getElementById('pg-vars').parentElement.style.display = 'none';
  document.getElementById('pg-run').textContent = 'Send Request';
  document.getElementById('pg-result').textContent = 'Click "Send Request" to execute';
  document.getElementById('pg-result').className = 'pg-result';
  document.getElementById('pg-timing').textContent = '';
  currentService = JSON.stringify({method, path});
  pg.scrollIntoView({behavior:'smooth'});
}

async function sendRestRequest() {
  const {method, path} = JSON.parse(currentService);
  const el = document.getElementById('pg-result');
  el.textContent = 'Sending...';
  el.className = 'pg-result';
  const start = performance.now();
  try {
    const opts = {method, headers:{'Content-Type':'application/json'}};
    if (method !== 'GET') {
      const bodyText = document.getElementById('pg-query').value;
      try { opts.body = JSON.stringify(JSON.parse(bodyText)); } catch(_) {}
    }
    const r = await fetch(path, opts);
    const ms = Math.round(performance.now() - start);
    const data = await r.json();
    const statusClass = r.status < 300 ? 's2' : r.status < 500 ? 's4' : 's5';
    document.getElementById('pg-timing').innerHTML = '<span class="pg-status ' + statusClass + '">' + r.status + '</span> ' + ms + 'ms';
    el.textContent = JSON.stringify(data, null, 2);
  } catch(e) {
    el.textContent = 'Error: ' + e.message;
    el.className = 'pg-result error';
  }
}

async function runQuery() {
  if (currentMode === 'rest') {
    return sendRestRequest();
  }

  const query = document.getElementById('pg-query').value;
  let variables = {};
  try { variables = JSON.parse(document.getElementById('pg-vars').value); } catch(_) {}
  const el = document.getElementById('pg-result');
  el.textContent = 'Loading...';
  el.className = 'pg-result';

  const start = performance.now();
  try {
    const r = await fetch('/graphql/' + currentService, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({query, variables})
    });
    const ms = Math.round(performance.now() - start);
    const data = await r.json();
    const statusClass = r.status < 300 ? 's2' : 's4';
    document.getElementById('pg-timing').innerHTML = '<span class="pg-status ' + statusClass + '">' + r.status + '</span> ' + ms + 'ms';
    el.textContent = JSON.stringify(data, null, 2);
    if (data.errors) el.className = 'pg-result error';
  } catch(e) {
    el.textContent = 'Error: ' + e.message;
    el.className = 'pg-result error';
  }
}

function closePg() {
  document.getElementById('playground').classList.remove('visible');
}

document.getElementById('pg-query').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
});
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
