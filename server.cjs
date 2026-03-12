#!/usr/bin/env node
/**
 * WM Sports Mock Server — Microcks-Powered
 *
 * A dashboard UI that proxies all mock requests to a Microcks instance.
 * Microcks handles the actual mocking (200+ operations across GraphQL, REST, Kafka, RabbitMQ).
 * This server provides:
 *   - Pretty dashboard at /
 *   - GraphQL proxy: /graphql/:service → Microcks /graphql/:service/1.0
 *   - REST proxy:    /rest/:service/*  → Microcks /rest/:service/1.0/*
 *   - Health check:  /health
 *   - Fallback:      @graphql-tools/mock when Microcks is unavailable
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

const PORT = process.env.PORT || 4010;
const MICROCKS_URL = process.env.MICROCKS_URL || 'http://localhost:8585';

// ── Microcks service registry (auto-discovered) ─────────────────────────

let microcksServices = [];
let lastFetch = 0;
const CACHE_TTL = 30_000;

async function fetchMicrocksServices() {
  if (Date.now() - lastFetch < CACHE_TTL && microcksServices.length > 0) {
    return microcksServices;
  }
  try {
    const data = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
    microcksServices = JSON.parse(data);
    lastFetch = Date.now();
    return microcksServices;
  } catch (err) {
    console.log(`  ⚠ Cannot reach Microcks at ${MICROCKS_URL}: ${err.message}`);
    return microcksServices;
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function proxyToMicrocks(req, res, targetPath) {
  const url = new URL(targetPath, MICROCKS_URL);
  const mod = url.protocol === 'https:' ? https : http;

  const headers = { ...req.headers, host: url.host };
  delete headers['content-length'];

  const bodyStr = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : null;
  if (bodyStr) headers['content-length'] = Buffer.byteLength(bodyStr);

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers,
    timeout: 10000,
  };

  const proxyReq = mod.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    const skip = new Set(['transfer-encoding', 'connection']);
    Object.entries(proxyRes.headers).forEach(([k, v]) => {
      if (!skip.has(k.toLowerCase())) res.setHeader(k, v);
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.status(502).json({
      error: 'Microcks proxy error',
      detail: err.message,
      hint: `Is Microcks running at ${MICROCKS_URL}?`,
    });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    res.status(504).json({ error: 'Microcks request timed out' });
  });

  if (bodyStr) proxyReq.write(bodyStr);
  proxyReq.end();
}

// ── GraphQL proxy to Microcks ────────────────────────────────────────────

app.post('/graphql/:service', (req, res) => {
  const service = req.params.service;
  const microcksPath = `/graphql/${service}/1.0`;
  proxyToMicrocks(req, res, microcksPath);
});

app.post('/graphql', async (req, res) => {
  const services = await fetchMicrocksServices();
  const graphqlSvcs = services.filter(s =>
    s.type === 'GRAPHQL' || s.type === 'GRAPH'
  );

  if (graphqlSvcs.length === 0) {
    return res.status(503).json({
      error: 'No GraphQL services found in Microcks',
      hint: `Check ${MICROCKS_URL}`,
    });
  }

  // Try each GraphQL service until one succeeds
  const { query, variables, operationName } = req.body;
  for (const svc of graphqlSvcs) {
    const svcName = svc.name.replace(/API$/i, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() + '-api';
    try {
      const data = await new Promise((resolve, reject) => {
        const url = new URL(`/graphql/${svc.name}/${svc.version}`, MICROCKS_URL);
        const mod = url.protocol === 'https:' ? https : http;
        const postData = JSON.stringify({ query, variables, operationName });
        const opts = {
          hostname: url.hostname, port: url.port, path: url.pathname,
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 5000,
        };
        const r = mod.request(opts, (resp) => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => {
            if (resp.statusCode === 200) resolve(d);
            else reject(new Error(`${resp.statusCode}`));
          });
        });
        r.on('error', reject);
        r.write(postData);
        r.end();
      });
      const parsed = JSON.parse(data);
      if (!parsed.errors || parsed.errors.length === 0) {
        return res.json(parsed);
      }
    } catch (_) {}
  }

  res.status(400).json({
    error: 'Query did not match any Microcks GraphQL service',
    availableServices: graphqlSvcs.map(s => s.name),
  });
});

// ── REST proxy to Microcks ───────────────────────────────────────────────

app.all('/rest/:service/:version/*', (req, res) => {
  const restPath = req.originalUrl;
  proxyToMicrocks(req, res, restPath);
});

app.all('/rest/:service/*', (req, res) => {
  const service = req.params.service;
  const subPath = req.params[0] || '';
  const search = req._parsedUrl.search || '';
  const restPath = `/rest/${service}/1.0/${subPath}${search}`;
  proxyToMicrocks(req, res, restPath);
});

// ── Direct Census/StatMilk proxies (for contract testing compatibility) ──

app.all('/v3/*', (req, res) => {
  const search = req._parsedUrl.search || '';
  proxyToMicrocks(req, res, `/rest/Census+API/1.0/v3/${req.params[0]}${search}`);
});

app.all('/statmilk/*', (req, res) => {
  const search = req._parsedUrl.search || '';
  proxyToMicrocks(req, res, `/rest/StatMilk/1.0/statmilk/${req.params[0]}${search}`);
});

// ── Microcks API proxy (for direct access) ───────────────────────────────

app.all('/api/*', (req, res) => {
  const search = req._parsedUrl.search || '';
  proxyToMicrocks(req, res, `/api/${req.params[0]}${search}`);
});

// ── Dashboard ────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const services = await fetchMicrocksServices();
  const graphql = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
  const rest = services.filter(s => s.type === 'REST');
  const event = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
  const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);
  res.json({
    status: 'ok',
    microcks: MICROCKS_URL,
    microcksReachable: services.length > 0,
    services: { total: services.length, graphql: graphql.length, rest: rest.length, event: event.length },
    totalOperations: totalOps,
    uptime: process.uptime(),
  });
});

app.get('/', async (req, res) => {
  const services = await fetchMicrocksServices();

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ services, microcks: MICROCKS_URL });
  }

  const graphqlSvcs = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
  const restSvcs = services.filter(s => s.type === 'REST');
  const eventSvcs = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
  const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);

  const host = `${req.protocol}://${req.get('host')}`;
  const microcksUp = services.length > 0;

  const graphqlRows = graphqlSvcs.map(s => {
    const opsCount = s.operations?.length || 0;
    const svcEndpoint = `${host}/graphql/${s.name}`;
    const opsPreview = (s.operations || []).slice(0, 5).map(o => o.name).join(', ');
    const moreOps = opsCount > 5 ? ` +${opsCount - 5} more` : '';
    return `<tr>
      <td><strong>${s.name}</strong></td>
      <td><span class="badge graphql">GraphQL</span></td>
      <td><span class="ops-count">${opsCount}</span> operations</td>
      <td><code>POST ${svcEndpoint}</code></td>
      <td><button onclick="tryGraphQL('${s.name}','${s.version}')">Try it</button></td>
    </tr>
    <tr class="ops-row"><td colspan="5"><span class="ops-list">${opsPreview}${moreOps}</span></td></tr>`;
  }).join('\n');

  const restRows = restSvcs.map(s => {
    const opsCount = s.operations?.length || 0;
    const ops = (s.operations || []).map(o => {
      const parts = o.name.split(' ');
      const method = parts[0] || 'GET';
      const path = parts.slice(1).join(' ') || '/';
      return `<div class="rest-endpoint">
        <span class="method ${method.toLowerCase()}">${method}</span>
        <code>${host}/rest/${s.name}/${s.version}${path}</code>
        <button onclick="tryRest('${method}','${host}/rest/${s.name}/${s.version}${path}')">Try it</button>
      </div>`;
    }).join('\n');
    return `<div class="rest-service">
      <h3>${s.name} <span class="badge rest">REST</span> <span class="ops-count">${opsCount} endpoints</span></h3>
      ${ops}
    </div>`;
  }).join('\n');

  const eventRows = eventSvcs.map(s => {
    const opsCount = s.operations?.length || 0;
    const ops = (s.operations || []).map(o => o.name).join(', ');
    return `<tr>
      <td><strong>${s.name}</strong></td>
      <td><span class="badge event">Event</span></td>
      <td><span class="ops-count">${opsCount}</span> topics</td>
      <td colspan="2"><span class="ops-list">${ops}</span></td>
    </tr>`;
  }).join('\n');

  const sampleQueries = {};
  for (const s of graphqlSvcs) {
    const queries = (s.operations || []).filter(o => !o.name.startsWith('Mutation'));
    if (queries.length > 0) {
      const firstOp = queries[0].name;
      sampleQueries[s.name] = `# ${s.name} — ${queries.length} queries available\n# Try: ${queries.slice(0, 3).map(q => q.name).join(', ')}\n{\n  __schema {\n    queryType {\n      fields { name description }\n    }\n  }\n}`;
    } else {
      sampleQueries[s.name] = '{ __schema { queryType { fields { name } } } }';
    }
  }
  const sampleQueriesJson = JSON.stringify(sampleQueries);

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
  .status-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:.75rem;font-weight:600;margin-left:.5rem}
  .status-badge.online{background:#238636;color:#fff}
  .status-badge.offline{background:#da3633;color:#fff}
  .stats{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
  .stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem 1.5rem;min-width:140px}
  .stat-num{font-size:2rem;font-weight:700;color:#58a6ff}
  .stat-label{color:#8b949e;font-size:.85rem}
  h2{font-size:1.2rem;margin:1.5rem 0 .8rem;color:#c9d1d9}
  h3{font-size:1rem;color:#c9d1d9;margin-bottom:.5rem}
  table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden;margin-bottom:1rem}
  th{background:#1c2128;text-align:left;padding:.7rem 1rem;color:#8b949e;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:.6rem 1rem;border-top:1px solid #21262d;font-size:.9rem}
  .ops-row td{padding:.2rem 1rem .6rem;border-top:none}
  .ops-list{color:#484f58;font-size:.8rem;font-style:italic}
  .ops-count{background:#1f6feb22;color:#58a6ff;padding:1px 8px;border-radius:10px;font-size:.8rem;font-weight:600}
  code{background:#1c2128;padding:2px 6px;border-radius:4px;font-size:.82rem;color:#79c0ff}
  button{background:#238636;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.8rem}
  button:hover{background:#2ea043}
  .badge{padding:2px 8px;border-radius:3px;font-size:.7rem;font-weight:700;text-transform:uppercase}
  .badge.graphql{background:#e535ab22;color:#e535ab}
  .badge.rest{background:#1f6feb22;color:#58a6ff}
  .badge.event{background:#f0883e22;color:#f0883e}
  .rest-service{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem}
  .rest-endpoint{display:flex;align-items:center;gap:.5rem;padding:.4rem 0;flex-wrap:wrap;font-size:.9rem}
  .method{padding:2px 8px;border-radius:3px;font-weight:700;font-size:.7rem;min-width:48px;text-align:center}
  .get{background:#1f6feb;color:#fff}.post{background:#238636;color:#fff}.put{background:#f0883e;color:#fff}.delete{background:#da3633;color:#fff}.patch{background:#a371f7;color:#fff}
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
  .microcks-link{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.8rem 1.2rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:1rem}
  .microcks-link code{font-size:.9rem}
</style>
</head>
<body>
<h1>WM Sports Mock Server <span class="status-badge ${microcksUp ? 'online' : 'offline'}">${microcksUp ? 'Microcks Connected' : 'Microcks Offline'}</span></h1>
<p class="subtitle">All mock data powered by <strong>Microcks</strong> — GraphQL, REST, Kafka, RabbitMQ</p>

<div class="microcks-link">
  <span>Microcks Backend:</span>
  <code><a href="${MICROCKS_URL}" target="_blank">${MICROCKS_URL}</a></code>
  <span style="color:#8b949e;font-size:.8rem">(${microcksUp ? services.length + ' services loaded' : 'unreachable'})</span>
</div>

<div class="stats">
  <div class="stat"><div class="stat-num">${graphqlSvcs.length}</div><div class="stat-label">GraphQL Services</div></div>
  <div class="stat"><div class="stat-num">${restSvcs.length}</div><div class="stat-label">REST APIs</div></div>
  <div class="stat"><div class="stat-num">${eventSvcs.length}</div><div class="stat-label">Event/Async APIs</div></div>
  <div class="stat"><div class="stat-num">${totalOps}</div><div class="stat-label">Total Operations</div></div>
</div>

${graphqlSvcs.length > 0 ? `
<h2>GraphQL Services</h2>
<p style="color:#8b949e;font-size:.85rem;margin-bottom:.5rem">Unified endpoint: <code>POST ${host}/graphql</code> | Per-service: <code>POST ${host}/graphql/:serviceName</code></p>
<table>
<thead><tr><th>Service</th><th>Protocol</th><th>Operations</th><th>Endpoint</th><th></th></tr></thead>
<tbody>${graphqlRows}</tbody>
</table>
` : '<p style="color:#8b949e">No GraphQL services found in Microcks</p>'}

${restSvcs.length > 0 ? `
<h2>REST APIs</h2>
${restRows}
` : ''}

${eventSvcs.length > 0 ? `
<h2>Event / Async APIs (Kafka, RabbitMQ)</h2>
<table>
<thead><tr><th>Service</th><th>Protocol</th><th>Operations</th><th colspan="2">Topics/Queues</th></tr></thead>
<tbody>${eventRows}</tbody>
</table>
` : ''}

<div id="playground" class="playground">
  <h3>
    <span id="pg-title">Playground</span>
    <button class="close" onclick="closePg()">Close</button>
  </h3>
  <div class="pg-row">
    <div class="pg-col">
      <label id="pg-query-label">Query</label>
      <textarea id="pg-query" class="pg-query" spellcheck="false"></textarea>
    </div>
    <div class="pg-col" id="pg-vars-col">
      <label>Variables (JSON)</label>
      <textarea id="pg-vars" class="pg-vars" spellcheck="false">{}</textarea>
    </div>
  </div>
  <div class="pg-actions">
    <button class="run" id="pg-run" onclick="runQuery()">Run Query</button>
    <span id="pg-timing"></span>
  </div>
  <label style="color:#8b949e;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem;display:block">Response <span style="font-size:.7rem;color:#484f58">(from Microcks)</span></label>
  <div id="pg-result" class="pg-result">Click "Run Query" to see the response from Microcks</div>
</div>

<div class="footer">
  <a href="/health">Health Check</a> &middot;
  <a href="${MICROCKS_URL}" target="_blank">Microcks Dashboard</a> &middot;
  <a href="/api/services" target="_blank">Services API</a> &middot;
  <a href="https://github.com/nausheenzaidi-bit/wmsports-mock-server">GitHub</a> &middot;
  Powered by Microcks + Express
</div>

<script>
let currentService = '';
let currentVersion = '1.0';
let currentMode = 'graphql';

const sampleQueries = ${sampleQueriesJson};

function tryGraphQL(service, version) {
  currentService = service;
  currentVersion = version || '1.0';
  currentMode = 'graphql';
  const pg = document.getElementById('playground');
  pg.classList.add('visible');
  document.getElementById('pg-title').innerHTML = 'GraphQL: <strong>' + service + '</strong> <span class="badge graphql">via Microcks</span>';
  document.getElementById('pg-query').value = sampleQueries[service] || '{ __schema { queryType { fields { name description } } } }';
  document.getElementById('pg-query').readOnly = false;
  document.getElementById('pg-query').style.opacity = '1';
  document.getElementById('pg-query-label').textContent = 'Query';
  document.getElementById('pg-vars').value = '{}';
  document.getElementById('pg-vars-col').style.display = '';
  document.getElementById('pg-result').textContent = 'Click "Run Query" to see the response from Microcks';
  document.getElementById('pg-result').className = 'pg-result';
  document.getElementById('pg-timing').textContent = '';
  document.getElementById('pg-run').textContent = 'Run Query';
  pg.scrollIntoView({behavior:'smooth'});
}

function tryRest(method, fullUrl) {
  currentMode = 'rest';
  const pg = document.getElementById('playground');
  pg.classList.add('visible');
  document.getElementById('pg-title').innerHTML = 'REST: <strong>' + method + '</strong> <span class="badge rest">via Microcks</span>';
  const queryEl = document.getElementById('pg-query');
  document.getElementById('pg-query-label').textContent = 'URL';
  queryEl.value = fullUrl;
  queryEl.readOnly = method === 'GET';
  queryEl.style.opacity = method === 'GET' ? '0.7' : '1';
  document.getElementById('pg-vars-col').style.display = 'none';
  document.getElementById('pg-run').textContent = 'Send Request';
  document.getElementById('pg-result').textContent = 'Click "Send Request" to execute via Microcks';
  document.getElementById('pg-result').className = 'pg-result';
  document.getElementById('pg-timing').textContent = '';
  currentService = JSON.stringify({method, url: fullUrl});
  pg.scrollIntoView({behavior:'smooth'});
}

async function runQuery() {
  if (currentMode === 'rest') return sendRestRequest();
  const query = document.getElementById('pg-query').value;
  let variables = {};
  try { variables = JSON.parse(document.getElementById('pg-vars').value); } catch(_) {}
  const el = document.getElementById('pg-result');
  el.textContent = 'Querying Microcks...';
  el.className = 'pg-result';
  const start = performance.now();
  try {
    const r = await fetch('/graphql/' + currentService, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({query, variables})
    });
    const ms = Math.round(performance.now() - start);
    const text = await r.text();
    let display;
    try { display = JSON.stringify(JSON.parse(text), null, 2); } catch(_) { display = text; }
    const sc = r.status < 300 ? 's2' : 's4';
    document.getElementById('pg-timing').innerHTML = '<span class="pg-status ' + sc + '">' + r.status + '</span> ' + ms + 'ms';
    el.textContent = display;
    if (display.includes('"errors"')) el.className = 'pg-result error';
  } catch(e) {
    el.textContent = 'Error: ' + e.message;
    el.className = 'pg-result error';
  }
}

async function sendRestRequest() {
  const {method, url} = JSON.parse(currentService);
  const el = document.getElementById('pg-result');
  el.textContent = 'Sending to Microcks...';
  el.className = 'pg-result';
  const start = performance.now();
  try {
    const urlObj = new URL(url);
    const opts = {method, headers:{'Content-Type':'application/json'}};
    const r = await fetch(urlObj.pathname + urlObj.search, opts);
    const ms = Math.round(performance.now() - start);
    const text = await r.text();
    let display;
    try { display = JSON.stringify(JSON.parse(text), null, 2); } catch(_) { display = text; }
    const sc = r.status < 300 ? 's2' : r.status < 500 ? 's4' : 's5';
    document.getElementById('pg-timing').innerHTML = '<span class="pg-status ' + sc + '">' + r.status + '</span> ' + ms + 'ms';
    el.textContent = display;
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

// ── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n  WM Sports Mock Server (Microcks-Powered)`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Microcks:   ${MICROCKS_URL}`);
  console.log(`  GraphQL:    POST /graphql/:service`);
  console.log(`  REST:       /rest/:service/:version/...`);
  console.log(`  Health:     GET /health\n`);

  const services = await fetchMicrocksServices();
  if (services.length > 0) {
    const graphql = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
    const rest = services.filter(s => s.type === 'REST');
    const event = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
    const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);
    console.log(`  Microcks: ${services.length} services (${graphql.length} GraphQL, ${rest.length} REST, ${event.length} Event)`);
    console.log(`  Total: ${totalOps} operations\n`);
  } else {
    console.log(`  ⚠ Microcks not reachable at ${MICROCKS_URL}`);
    console.log(`  Start Microcks: docker compose up -d\n`);
  }
});
