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

  // Build structured service data for the client-side explorer
  const svcData = {};
  for (const s of graphqlSvcs) {
    const queries = (s.operations || []).filter(o => o.method === 'QUERY');
    const mutations = (s.operations || []).filter(o => o.method === 'MUTATION');
    svcData[s.name] = {
      version: s.version,
      queries: queries.map(o => ({ name: o.name, output: o.outputName || '' })),
      mutations: mutations.map(o => ({ name: o.name, output: o.outputName || '' })),
    };
  }
  const svcDataJson = JSON.stringify(svcData);

  const restRows = restSvcs.map(s => {
    const ops = (s.operations || []).map(o => {
      const parts = o.name.split(' ');
      const method = parts[0] || 'GET';
      const opPath = parts.slice(1).join(' ') || '/';
      return `<div class="rest-ep"><span class="method ${method.toLowerCase()}">${method}</span><code>${host}/rest/${s.name}/${s.version}${opPath}</code><button onclick="tryRest('${method}','${host}/rest/${s.name}/${s.version}${opPath}')">Try</button></div>`;
    }).join('\n');
    return `<div class="rest-svc"><h3>${s.name} <span class="badge rest">REST</span> <span class="ops-count">${s.operations?.length || 0}</span></h3>${ops}</div>`;
  }).join('\n');

  const eventRows = eventSvcs.map(s => {
    const ops = (s.operations || []).map(o => o.name).join(', ');
    return `<tr><td><strong>${s.name}</strong></td><td><span class="badge event">Event</span></td><td><span class="ops-count">${s.operations?.length || 0}</span></td><td>${ops}</td></tr>`;
  }).join('\n');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WM Sports Mock Server</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0d1117;color:#e1e4e8}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.header h1{font-size:1.3rem;color:#fff}
.status-badge{padding:3px 10px;border-radius:12px;font-size:.7rem;font-weight:600}
.status-badge.online{background:#238636;color:#fff}
.status-badge.offline{background:#da3633;color:#fff}
.stats-bar{display:flex;gap:1.5rem;margin-left:auto;font-size:.8rem;color:#8b949e}
.stats-bar strong{color:#58a6ff}
.layout{display:flex;height:calc(100vh - 56px)}
.sidebar{width:280px;min-width:280px;background:#0d1117;border-right:1px solid #21262d;overflow-y:auto;display:flex;flex-direction:column}
.sidebar-section{padding:.5rem 0}
.sidebar-section h3{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#484f58;padding:.4rem 1rem;user-select:none}
.svc-btn{display:flex;align-items:center;gap:.5rem;padding:.45rem 1rem;cursor:pointer;font-size:.85rem;color:#c9d1d9;border:none;background:none;width:100%;text-align:left}
.svc-btn:hover{background:#161b22}
.svc-btn.active{background:#1f6feb22;color:#58a6ff;border-left:2px solid #58a6ff}
.svc-btn .cnt{margin-left:auto;font-size:.7rem;color:#484f58;background:#21262d;padding:1px 6px;border-radius:8px}
.badge{padding:1px 6px;border-radius:3px;font-size:.6rem;font-weight:700;text-transform:uppercase}
.badge.graphql{background:#e535ab22;color:#e535ab}
.badge.rest{background:#1f6feb22;color:#58a6ff}
.badge.event{background:#f0883e22;color:#f0883e}
.badge.query{background:#23863622;color:#7ee787}.badge.mutation{background:#da363322;color:#f85149}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.explorer{display:none;flex:1;overflow:hidden}
.explorer.active{display:flex}
.explorer .ops-panel{width:260px;min-width:220px;background:#0d1117;border-right:1px solid #21262d;overflow-y:auto;padding:.5rem 0}
.ops-panel h4{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#484f58;padding:.5rem .8rem .3rem;margin-top:.3rem}
.op-btn{display:flex;align-items:center;gap:.4rem;padding:.35rem .8rem;cursor:pointer;font-size:.82rem;color:#c9d1d9;border:none;background:none;width:100%;text-align:left}
.op-btn:hover{background:#161b22}
.op-btn.active{background:#1f6feb15;color:#58a6ff}
.op-btn .ret{margin-left:auto;color:#484f58;font-size:.72rem;font-family:"SF Mono",Menlo,monospace;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.editor-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.editor-header{background:#161b22;border-bottom:1px solid #21262d;padding:.5rem 1rem;display:flex;align-items:center;gap:.5rem;font-size:.85rem}
.editor-header strong{color:#fff}
.editor-header .run-btn{margin-left:auto;background:#238636;color:#fff;border:none;padding:5px 16px;border-radius:4px;cursor:pointer;font-size:.85rem;font-weight:600}
.editor-header .run-btn:hover{background:#2ea043}
.editor-header .timing{color:#8b949e;font-size:.8rem;margin-right:.5rem}
.editor-body{display:flex;flex:1;overflow:hidden}
.editor-left{flex:1;display:flex;flex-direction:column;border-right:1px solid #21262d}
.editor-left label,.editor-right label{display:block;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:#484f58;padding:.4rem .8rem;background:#0d1117;border-bottom:1px solid #21262d}
.editor-left textarea{flex:1;width:100%;background:#0d1117;border:none;color:#c9d1d9;font-family:"SF Mono",Menlo,monospace;font-size:.85rem;padding:.8rem;resize:none;outline:none}
.editor-right{flex:1;display:flex;flex-direction:column;overflow:hidden}
.editor-right pre{flex:1;margin:0;padding:.8rem;font-family:"SF Mono",Menlo,monospace;font-size:.82rem;color:#7ee787;overflow:auto;white-space:pre-wrap;background:#0d1117}
.editor-right pre.error{color:#f85149}
.pg-status{padding:1px 6px;border-radius:3px;font-size:.72rem;font-weight:600;margin-right:.3rem}
.pg-status.s2{background:#238636;color:#fff}.pg-status.s4{background:#da3633;color:#fff}.pg-status.s5{background:#da3633;color:#fff}
.welcome{padding:3rem;color:#484f58;font-size:1rem;text-align:center;margin:auto}
.welcome h2{color:#c9d1d9;margin-bottom:.5rem;font-size:1.2rem}
.rest-section,.event-section{display:none;padding:1.5rem;overflow-y:auto;flex:1}
.rest-section.active,.event-section.active{display:block}
.rest-svc{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem}
.rest-svc h3{font-size:.95rem;margin-bottom:.5rem;color:#c9d1d9}
.rest-ep{display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.85rem;flex-wrap:wrap}
.rest-ep button{margin-left:auto;background:#238636;color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:.75rem}
.rest-ep button:hover{background:#2ea043}
.method{padding:2px 6px;border-radius:3px;font-weight:700;font-size:.65rem;min-width:40px;text-align:center}
.get{background:#1f6feb;color:#fff}.post{background:#238636;color:#fff}.put{background:#f0883e;color:#fff}.delete{background:#da3633;color:#fff}
code{background:#1c2128;padding:1px 5px;border-radius:3px;font-size:.8rem;color:#79c0ff}
.ops-count{background:#1f6feb22;color:#58a6ff;padding:1px 6px;border-radius:8px;font-size:.72rem;font-weight:600}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
th{background:#1c2128;text-align:left;padding:.5rem .8rem;color:#8b949e;font-size:.75rem;text-transform:uppercase}
td{padding:.5rem .8rem;border-top:1px solid #21262d;font-size:.85rem}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.footer-bar{background:#161b22;border-top:1px solid #21262d;padding:.4rem 1rem;font-size:.72rem;color:#484f58;display:flex;gap:1rem;align-items:center}
</style>
</head>
<body>
<div class="header">
  <h1>WM Sports Mock Server</h1>
  <span class="status-badge ${microcksUp ? 'online' : 'offline'}">${microcksUp ? 'Microcks Connected' : 'Offline'}</span>
  <div class="stats-bar">
    <span><strong>${graphqlSvcs.length}</strong> GraphQL</span>
    <span><strong>${restSvcs.length}</strong> REST</span>
    <span><strong>${eventSvcs.length}</strong> Event</span>
    <span><strong>${totalOps}</strong> ops</span>
  </div>
</div>
<div class="layout">
  <div class="sidebar">
    <div class="sidebar-section">
      <h3>GraphQL Services</h3>
      ${graphqlSvcs.map(s => {
        const qc = (s.operations||[]).filter(o=>o.method==='QUERY').length;
        const mc = (s.operations||[]).filter(o=>o.method==='MUTATION').length;
        return `<button class="svc-btn" data-svc="${s.name}" data-type="graphql" onclick="selectService('${s.name}')">${s.name}<span class="cnt">${qc}Q${mc?'/'+mc+'M':''}</span></button>`;
      }).join('\n')}
    </div>
    <div class="sidebar-section">
      <h3>REST APIs</h3>
      ${restSvcs.map(s => `<button class="svc-btn" data-type="rest" onclick="showRest()">${s.name}<span class="cnt">${s.operations?.length||0}</span></button>`).join('\n')}
    </div>
    <div class="sidebar-section">
      <h3>Event / Async</h3>
      ${eventSvcs.map(s => `<button class="svc-btn" data-type="event" onclick="showEvents()">${s.name}<span class="cnt">${s.operations?.length||0}</span></button>`).join('\n')}
    </div>
  </div>
  <div class="main">
    <div id="welcome" class="welcome" style="display:flex;flex-direction:column">
      <h2>Select a service from the sidebar</h2>
      <p>Click any GraphQL service to explore its queries and mutations, or click REST/Event to browse endpoints.</p>
    </div>

    <div id="explorer" class="explorer">
      <div class="ops-panel" id="ops-panel"></div>
      <div class="editor-area">
        <div class="editor-header">
          <span class="badge graphql">GraphQL</span>
          <strong id="editor-svc"></strong>
          <span class="timing" id="editor-timing"></span>
          <button class="run-btn" onclick="runQuery()">Run</button>
        </div>
        <div class="editor-body">
          <div class="editor-left">
            <label>Operation</label>
            <textarea id="editor-query" spellcheck="false" placeholder="Select a query from the left panel..."></textarea>
          </div>
          <div class="editor-right">
            <label>Response <span style="font-size:.6rem;color:#30363d">(from Microcks)</span></label>
            <pre id="editor-result">Select a query and click Run</pre>
          </div>
        </div>
      </div>
    </div>

    <div id="rest-view" class="rest-section">
      <h2 style="color:#c9d1d9;margin-bottom:1rem">REST APIs</h2>
      ${restRows}
    </div>

    <div id="event-view" class="event-section">
      <h2 style="color:#c9d1d9;margin-bottom:1rem">Event / Async APIs</h2>
      <table>
        <thead><tr><th>Service</th><th>Protocol</th><th>Operations</th><th>Topics/Queues</th></tr></thead>
        <tbody>${eventRows}</tbody>
      </table>
    </div>
  </div>
</div>
<div class="footer-bar">
  <a href="/health">Health</a>
  <a href="${MICROCKS_URL}" target="_blank">Microcks</a>
  <a href="/api/services" target="_blank">API</a>
  <a href="https://github.com/nausheenzaidi-bit/wmsports-mock-server">GitHub</a>
  <span style="margin-left:auto">Powered by Microcks + Express</span>
</div>

<script>
const SVC_DATA = ${svcDataJson};
let currentService = '';

function hideAll() {
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('explorer').classList.remove('active');
  document.getElementById('rest-view').classList.remove('active');
  document.getElementById('event-view').classList.remove('active');
  document.querySelectorAll('.svc-btn').forEach(b => b.classList.remove('active'));
}

function selectService(name) {
  hideAll();
  const data = SVC_DATA[name];
  if (!data) return;
  currentService = name;

  document.querySelector('.svc-btn[data-svc="'+name+'"]').classList.add('active');
  document.getElementById('explorer').classList.add('active');
  document.getElementById('editor-svc').textContent = name;
  document.getElementById('editor-result').textContent = 'Select a query and click Run';
  document.getElementById('editor-result').className = '';
  document.getElementById('editor-timing').innerHTML = '';

  const panel = document.getElementById('ops-panel');
  let html = '';
  if (data.queries.length) {
    html += '<h4>Queries (' + data.queries.length + ')</h4>';
    data.queries.forEach(q => {
      const ret = cleanRetType(q.output);
      html += '<button class="op-btn" onclick="selectOp(\\x27'+q.name+'\\x27,\\x27QUERY\\x27)"><span class="badge query">Q</span>'+q.name+'<span class="ret" title="'+ret+'">'+ret+'</span></button>';
    });
  }
  if (data.mutations.length) {
    html += '<h4>Mutations (' + data.mutations.length + ')</h4>';
    data.mutations.forEach(m => {
      const ret = cleanRetType(m.output);
      html += '<button class="op-btn" onclick="selectOp(\\x27'+m.name+'\\x27,\\x27MUTATION\\x27)"><span class="badge mutation">M</span>'+m.name+'<span class="ret" title="'+ret+'">'+ret+'</span></button>';
    });
  }
  panel.innerHTML = html;
}

function cleanRetType(s) {
  if (!s) return '';
  return s
    .replace(/NonNullType[{]type=TypeName[{]name='(\\w+)'[}][}]/g, '$1!')
    .replace(/TypeName[{]name='(\\w+)'[}]/g, '$1')
    .replace(/ListType[{]type=/g, '[')
    .replace(/NonNullType[{]type=/g, '')
    .replace(/[}]/g, '')
    .replace(/\\[([^\\]]+)/g, '[$1]');
}

const schemaCache = {};

async function fetchSchema(svc) {
  if (schemaCache[svc]) return schemaCache[svc];
  try {
    const r = await fetch('/graphql/' + svc, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({query: '{ __schema { types { name kind fields { name args { name type { name kind ofType { name kind ofType { name } } } } type { name kind ofType { name kind ofType { name kind } } } } } queryType { name } mutationType { name } } }'})
    });
    const d = await r.json();
    if (d.data) { schemaCache[svc] = d.data.__schema; return d.data.__schema; }
  } catch(_) {}
  return null;
}

function findType(schema, typeName) {
  if (!schema || !typeName) return null;
  const clean = typeName.replace(/[\\[\\]!]/g, '');
  return schema.types.find(t => t.name === clean);
}

function getReturnTypeName(schema, opName, method) {
  if (!schema) return null;
  const rootName = method === 'MUTATION' ? (schema.mutationType||{}).name : (schema.queryType||{}).name;
  const root = schema.types.find(t => t.name === rootName);
  if (!root || !root.fields) return null;
  const field = root.fields.find(f => f.name === opName);
  if (!field) return null;
  let t = field.type;
  while (t.ofType) t = t.ofType;
  return t.name;
}

function buildFieldsQuery(schema, typeName) {
  const t = findType(schema, typeName);
  if (!t || !t.fields || t.fields.length === 0) return null;
  const scalars = [];
  const allNames = [];
  for (const f of t.fields.slice(0, 25)) {
    allNames.push(f.name);
    let inner = f.type;
    while (inner.ofType) inner = inner.ofType;
    if (inner.kind === 'SCALAR' || inner.kind === 'ENUM') {
      scalars.push(f.name);
    }
  }
  if (scalars.length > 0) return scalars.join(' ');
  return allNames.length > 0 ? allNames.slice(0, 10).join(' ') : null;
}

function getArgStr(schema, opName, method) {
  const rootName = method === 'MUTATION' ? (schema.mutationType||{}).name : (schema.queryType||{}).name;
  const root = schema.types.find(t => t.name === rootName);
  if (!root || !root.fields) return '';
  const field = root.fields.find(f => f.name === opName);
  if (!field || !field.args || field.args.length === 0) return '';
  const parts = field.args.map(a => {
    let t = a.type;
    let required = false;
    if (t.kind === 'NON_NULL') { required = true; t = t.ofType || t; }
    let typeName = t.name || (t.ofType && t.ofType.name) || 'String';
    const defaults = {
      'String': '"example"', 'Int': '1', 'Float': '1.0', 'Boolean': 'true', 'ID': '"id-001"',
      'Tenant': 'bleacherReport', 'DateTime': '"2026-03-01T00:00:00Z"', 'Date': '"2026-03-01"',
    };
    const val = defaults[typeName] || '"example"';
    return a.name + ': ' + val;
  });
  return '(' + parts.join(', ') + ')';
}

async function selectOp(name, type) {
  document.querySelectorAll('.op-btn').forEach(b => b.classList.remove('active'));
  if (event && event.currentTarget) event.currentTarget.classList.add('active');

  const editor = document.getElementById('editor-query');
  const result = document.getElementById('editor-result');
  result.textContent = 'Loading schema for ' + currentService + '...';
  result.className = '';
  document.getElementById('editor-timing').innerHTML = '';

  const schema = await fetchSchema(currentService);
  const prefix = type === 'MUTATION' ? 'mutation ' : '';

  let fieldsStr = null;
  try {
    const probe = await fetch('/graphql/' + currentService, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({query: prefix + '{ ' + name + ' }'})
    });
    const pd = await probe.json();
    const val = pd && pd.data ? pd.data[name] : null;
    if (val) {
      const obj = Array.isArray(val) ? val[0] : val;
      if (obj && typeof obj === 'object') {
        const scalars = Object.entries(obj)
          .filter(([k,v]) => v === null || typeof v !== 'object')
          .map(([k]) => k);
        fieldsStr = scalars.length > 0 ? scalars.slice(0, 20).join(' ') : null;
      }
    }
  } catch(_) {}

  if (!fieldsStr && schema) {
    const retType = getReturnTypeName(schema, name, type);
    fieldsStr = retType ? buildFieldsQuery(schema, retType) : null;
  }

  if (fieldsStr) {
    editor.value = prefix + '{\\n  ' + name + ' {\\n    ' + fieldsStr.split(' ').join('\\n    ') + '\\n  }\\n}';
    result.textContent = 'Query ready — click Run or Cmd+Enter. Add arguments manually if needed.';
  } else {
    editor.value = prefix + '{\\n  ' + name + '\\n}';
    result.textContent = 'No fields discovered — edit query manually. Click Run to execute.';
  }
}

function showRest() {
  hideAll();
  document.getElementById('rest-view').classList.add('active');
  document.querySelectorAll('.svc-btn[data-type="rest"]').forEach(b => b.classList.add('active'));
}

function showEvents() {
  hideAll();
  document.getElementById('event-view').classList.add('active');
  document.querySelectorAll('.svc-btn[data-type="event"]').forEach(b => b.classList.add('active'));
}

function tryRest(method, fullUrl) {
  hideAll();
  document.getElementById('explorer').classList.add('active');
  currentService = '__rest__';
  document.getElementById('editor-svc').textContent = method + ' ' + new URL(fullUrl).pathname;
  document.getElementById('ops-panel').innerHTML = '<div style="padding:1rem;color:#484f58;font-size:.8rem">REST endpoint selected.<br>Click Run to send request.</div>';
  document.getElementById('editor-query').value = fullUrl;
  document.getElementById('editor-result').textContent = 'Click Run to send the request';
  document.getElementById('editor-result').className = '';
  document.getElementById('editor-timing').innerHTML = '';
  window.__restCtx = {method, url: fullUrl};
}

async function runQuery() {
  const el = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  el.textContent = 'Loading...';
  el.className = '';
  const start = performance.now();

  if (currentService === '__rest__') {
    const {method, url} = window.__restCtx;
    try {
      const urlObj = new URL(url);
      const r = await fetch(urlObj.pathname + urlObj.search, {method, headers:{'Content-Type':'application/json','x-api-key':'mock'}});
      const ms = Math.round(performance.now() - start);
      const text = await r.text();
      let display; try { display = JSON.stringify(JSON.parse(text),null,2); } catch(_) { display = text; }
      const sc = r.status < 300 ? 's2' : 's4';
      timingEl.innerHTML = '<span class="pg-status '+sc+'">'+r.status+'</span> '+ms+'ms';
      el.textContent = display;
      if (r.status >= 400) el.className = 'error';
    } catch(e) { el.textContent = 'Error: '+e.message; el.className = 'error'; }
    return;
  }

  const query = document.getElementById('editor-query').value;
  try {
    const r = await fetch('/graphql/' + currentService, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({query})
    });
    const ms = Math.round(performance.now() - start);
    const text = await r.text();
    let display; try { display = JSON.stringify(JSON.parse(text),null,2); } catch(_) { display = text; }
    const sc = r.status < 300 ? 's2' : 's4';
    timingEl.innerHTML = '<span class="pg-status '+sc+'">'+r.status+'</span> '+ms+'ms';
    el.textContent = display;
    if (display.includes('"errors"')) el.className = 'error';
  } catch(e) { el.textContent = 'Error: '+e.message; el.className = 'error'; }
}

document.getElementById('editor-query').addEventListener('keydown', e => {
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
