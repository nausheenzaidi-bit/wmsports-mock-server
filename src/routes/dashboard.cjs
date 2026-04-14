const express = require('express');
const router = express.Router();
const { MICROCKS_URL } = require('../config.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');

router.get('/', async (req, res) => {
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

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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
.user-badge{display:flex;align-items:center;gap:.35rem;padding:3px 10px;border-radius:12px;background:#1f2937;border:1px solid #30363d;cursor:pointer;transition:border-color .15s}
.user-badge:hover{border-color:#58a6ff}
.user-badge strong{color:#58a6ff}
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
.pg-status.s2{background:#238636;color:#fff}.pg-status.s206{background:#d29922;color:#fff}.pg-status.s4{background:#da3633;color:#fff}.pg-status.s5{background:#da3633;color:#fff}.pg-status.ai{background:#8957e5;color:#fff}
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
.svc-btn{display:flex;align-items:center;justify-content:space-between}
.svc-btn .svc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}
.svc-btn .svc-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}
.regen-icon{display:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;font-size:12px;color:#8b949e;cursor:pointer;transition:all .15s}
.svc-btn:hover .regen-icon{display:inline-block}
.regen-icon:hover{background:#23863644;color:#3fb950}
.regen-icon.spinning{display:inline-block;animation:spin .8s linear infinite;color:#3fb950}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
#setup-dropzone.drag-active{border-color:#3fb950 !important;background:#23863611 !important}
.regen-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center}
.regen-modal{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.5rem;width:460px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.4)}
</style>
</head>
<body>
<div class="header">
  <h1>WM Sports Mock Server</h1>
  <span class="status-badge ${microcksUp ? 'online' : 'offline'}">${microcksUp ? 'Microcks Connected' : 'Offline'}</span>
  <div class="user-badge" id="user-badge" onclick="changeUser()" title="Click to change user">
    <span style="font-size:.7rem;opacity:.6">User:</span>
    <strong id="user-display" style="font-size:.78rem"></strong>
  </div>
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
        return `<button class="svc-btn" data-svc="${s.name}" data-type="graphql" onclick="selectService('${s.name}')"><span class="svc-name">${s.name}</span><span class="svc-actions"><span class="regen-icon" title="Re-generate mock data" onclick="event.stopPropagation();regenService('${s.name}','graphql')">↻</span><span class="cnt">${qc}Q${mc?'/'+mc+'M':''}</span></span></button>`;
      }).join('\n')}
    </div>
    <div class="sidebar-section">
      <h3>REST APIs</h3>
      ${restSvcs.map(s => `<button class="svc-btn" data-type="rest" onclick="showRest()"><span class="svc-name">${s.name}</span><span class="svc-actions"><span class="regen-icon" title="Re-generate mock data" onclick="event.stopPropagation();regenService('${s.name}','rest')">↻</span><span class="cnt">${s.operations?.length||0}</span></span></button>`).join('\n')}
    </div>
    <div class="sidebar-section">
      <h3>Event / Async</h3>
      ${eventSvcs.map(s => `<button class="svc-btn" data-type="event" onclick="showEvents()">${s.name}<span class="cnt">${s.operations?.length||0}</span></button>`).join('\n')}
    </div>
    <div class="sidebar-section" style="border-top:1px solid #30363d;margin-top:auto">
      <button class="svc-btn" data-type="routes" onclick="showRoutes()" style="color:#58a6ff;font-weight:600">
        Mock API Routes
        <span class="cnt" style="background:#1f6feb22;color:#58a6ff">URLs</span>
      </button>
      <button class="svc-btn" data-type="setup" onclick="showSetup()" style="color:#3fb950;font-weight:600">
        ⚙ AI Setup
        <span class="cnt" style="background:#23863622;color:#3fb950">New</span>
      </button>
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
          <span class="badge graphql" id="editor-type-badge">GraphQL</span>
          <strong id="editor-svc"></strong>
          <span class="timing" id="editor-timing"></span>
          <div style="display:flex;gap:.4rem;align-items:center;margin-left:auto">
            <select id="inline-ai-scenario" style="background:#21262d;color:#a371f7;border:1px solid #8957e544;border-radius:4px;padding:3px 6px;font-size:.72rem;cursor:pointer;display:none">
              <option value="">AI Scenario...</option>
              <option value="wrong-types">Wrong Types</option>
              <option value="missing-fields">Missing Fields</option>
              <option value="null-values">Null Values</option>
              <option value="empty-arrays">Empty Arrays</option>
              <option value="malformed-dates">Malformed Dates</option>
              <option value="deprecated-fields">Deprecated Fields</option>
              <option value="extra-fields">Extra Unknown Fields</option>
              <option value="encoding-issues">Encoding/Special Chars</option>
              <option value="boundary-values">Boundary Values</option>
              <option value="partial-response">Partial/Truncated</option>
              <option value="mixed-good-bad">Mixed Good & Bad</option>
            </select>
            <input id="inline-ai-prompt" placeholder="or describe..." style="background:#21262d;color:#c9d1d9;border:1px solid #8957e544;border-radius:4px;padding:3px 6px;font-size:.72rem;width:180px;display:none">
            <label id="inline-ai-global-wrap" style="display:none;align-items:center;gap:3px;font-size:.68rem;color:#d29922;cursor:pointer" title="Apply scenario globally (affects all users)">
              <input type="checkbox" id="inline-ai-global" style="accent-color:#d29922;width:12px;height:12px">
              <span>Global</span>
            </label>
            <button id="inline-ai-btn" onclick="inlineAIInject()" style="background:#8957e5;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:.72rem;font-weight:600;display:none">Apply Scenario</button>
            <button id="inline-ai-clear" onclick="inlineAIClear()" style="background:#da363322;color:#f85149;border:1px solid #da363344;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:.72rem;display:none">Clear</button>
            <button class="run-btn" onclick="runQuery()">Run</button>
          </div>
        </div>
        <div class="editor-body">
          <div class="editor-left">
            <label>Operation</label>
            <textarea id="editor-query" spellcheck="false" placeholder="Select a query from the left panel..."></textarea>
          </div>
          <div class="editor-right">
            <label>Response <span id="response-source" style="font-size:.6rem;color:#30363d">(from Microcks)</span></label>
            <pre id="editor-result">Select a query and click Run</pre>
            <div id="validation-panel" style="display:none;background:#1c1208;border-top:1px solid #533d11;padding:.5rem .8rem;max-height:180px;overflow-y:auto">
              <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem">
                <span style="color:#d29922;font-weight:600;font-size:.75rem">⚠ Schema Violations</span>
                <span id="validation-count" style="background:#d2992233;color:#d29922;padding:1px 6px;border-radius:8px;font-size:.68rem;font-weight:600"></span>
              </div>
              <div id="validation-list" style="font-family:'SF Mono',Menlo,monospace;font-size:.75rem"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="rest-view" class="rest-section">
      <h2 style="color:#c9d1d9;margin-bottom:1rem">REST APIs</h2>
      ${restRows}
    </div>

    <div id="event-view" class="event-section">
      <h2 style="color:#c9d1d9;margin-bottom:1rem">Event / Async APIs <span class="badge event">Messages</span></h2>
      <p style="color:#8b949e;font-size:.85rem;margin-bottom:1rem">View message schemas and examples from AsyncAPI specs. Generate AI test data for Kafka/RabbitMQ payloads.</p>

      <div style="display:flex;gap:1rem;margin-bottom:1rem;flex-wrap:wrap">
        <div style="flex:1;min-width:320px">
          <div style="display:flex;gap:.5rem;margin-bottom:.8rem;align-items:center">
            <select id="async-spec-select" onchange="loadAsyncChannels()" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 10px;font-size:.82rem;flex:1">
              <option value="">Select a spec...</option>
            </select>
            <select id="async-channel-select" onchange="loadAsyncExample()" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:6px 10px;font-size:.82rem;flex:1">
              <option value="">Select a channel...</option>
            </select>
          </div>

          <div id="async-channel-info" style="display:none;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:.8rem">
            <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">
              <span id="async-protocol-badge" class="badge event">KAFKA</span>
              <span id="async-direction-badge" class="badge" style="background:#8957e522;color:#a371f7">SUBSCRIBE</span>
              <strong id="async-channel-name" style="color:#c9d1d9;font-size:.9rem"></strong>
            </div>
            <p id="async-channel-desc" style="color:#8b949e;font-size:.82rem;margin-bottom:.4rem"></p>
            <div style="display:flex;gap:1rem;font-size:.75rem;color:#484f58">
              <span>Message: <strong id="async-msg-name" style="color:#79c0ff"></strong></span>
              <span>Operation: <strong id="async-op-id" style="color:#79c0ff"></strong></span>
              <span>Content-Type: <strong id="async-content-type" style="color:#79c0ff"></strong></span>
            </div>
          </div>

          <div id="async-ai-controls" style="display:none;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:.8rem;margin-bottom:.8rem">
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
              <select id="async-ai-scenario" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:5px 8px;font-size:.8rem">
                <option value="">Select scenario...</option>
                <option value="wrong-types">Wrong Types</option>
                <option value="missing-fields">Missing Fields</option>
                <option value="null-values">Null Values</option>
                <option value="empty-arrays">Empty Values</option>
                <option value="extra-fields">Extra Fields</option>
                <option value="malformed-dates">Malformed Dates</option>
                <option value="boundary-values">Boundary Values</option>
                <option value="encoding-issues">Encoding Issues</option>
                <option value="partial-response">Partial Data</option>
                <option value="mixed-good-bad">Mixed Good & Bad</option>
              </select>
              <input id="async-ai-prompt" placeholder="or describe..." style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:5px 8px;font-size:.8rem;flex:1;min-width:150px">
              <button onclick="generateAsyncAI()" style="background:#238636;color:#fff;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:.82rem;font-weight:600">Generate</button>
            </div>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:1rem;flex-wrap:wrap">
        <div style="flex:1;min-width:400px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.3rem">
            <label style="font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:#484f58">Example Payload</label>
            <div id="async-example-tabs" style="display:none;gap:.3rem"></div>
          </div>
          <div style="position:relative">
            <pre id="async-example-payload" style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:.8rem;font-family:'SF Mono',Menlo,monospace;font-size:.82rem;color:#7ee787;min-height:200px;max-height:500px;overflow:auto;white-space:pre-wrap">Select a spec and channel to view examples</pre>
            <button id="async-copy-btn" onclick="copyAsyncPayload()" style="display:none;position:absolute;top:8px;right:8px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:.72rem">Copy</button>
          </div>
        </div>
        <div style="flex:1;min-width:400px">
          <label style="font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:#484f58;display:block;margin-bottom:.3rem">AI Generated / Schema Validation</label>
          <pre id="async-ai-result" style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:.8rem;font-family:'SF Mono',Menlo,monospace;font-size:.82rem;color:#c9d1d9;min-height:200px;max-height:400px;overflow:auto;white-space:pre-wrap">Generate AI data to see results here</pre>
          <div id="async-validation-panel" style="display:none;background:#1c1d0f;border:1px solid #533d11;border-radius:6px;padding:.6rem;margin-top:.5rem;max-height:200px;overflow-y:auto">
            <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem">
              <span style="color:#d29922;font-weight:600;font-size:.8rem">&#9888; Schema Violations</span>
              <span id="async-validation-count" style="background:#533d11;color:#d29922;padding:1px 6px;border-radius:8px;font-size:.7rem"></span>
            </div>
            <div id="async-validation-list" style="font-size:.78rem;font-family:'SF Mono',Menlo,monospace"></div>
          </div>
        </div>
      </div>

      <div style="margin-top:1.5rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">All Channels Overview</h3>
        <table>
          <thead><tr><th>Service</th><th>Protocol</th><th>Operations</th><th>Topics/Queues</th></tr></thead>
          <tbody>${eventRows}</tbody>
        </table>
      </div>
    </div>

    <div id="routes-view" class="rest-section">
      <h2 style="color:#c9d1d9;margin-bottom:.5rem">Mock API Routes <span class="badge" style="background:#1f6feb22;color:#58a6ff">Microcks</span></h2>
      <p style="color:#8b949e;font-size:.85rem;margin-bottom:1rem">These are the live mock endpoints. Hit them directly from any client (curl, Postman, tests).</p>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">GraphQL Endpoints</h3>
        <p style="color:#8b949e;font-size:.78rem;margin-bottom:.5rem">POST to these URLs with <code>{"query": "{ operationName { fields } }"}</code></p>
        <table><thead><tr><th>Service</th><th>Mock URL (via dashboard)</th><th>Direct Microcks URL</th><th>Operations</th></tr></thead><tbody>
        ${graphqlSvcs.map(s => {
          const oc = (s.operations||[]).length;
          return `<tr><td style="font-weight:600">${s.name}</td><td><code>/graphql/${s.name}</code></td><td><code style="color:#79c0ff">${MICROCKS_URL}/graphql/${s.name}/${s.version}</code></td><td>${oc}</td></tr>`;
        }).join('')}
        </tbody></table>
      </div>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">REST Endpoints</h3>
        ${restSvcs.map(s => {
          const ops = (s.operations||[]);
          return `<div style="margin-bottom:.8rem"><strong style="color:#c9d1d9">${s.name}</strong> <span style="color:#484f58;font-size:.75rem">${ops.length} operations</span>` +
            ops.map(o => {
              const parts = o.name.split(' ');
              const method = parts[0] || 'GET';
              const path = parts.slice(1).join(' ') || o.name;
              const mc = method.toLowerCase();
              return `<div style="margin:.2rem 0 .2rem 1rem;font-size:.82rem"><span class="badge ${mc}" style="font-size:.65rem;padding:1px 4px">${method}</span> <code>${MICROCKS_URL}/rest/${s.name}/${s.version}${path}</code></div>`;
            }).join('') + '</div>';
        }).join('')}
      </div>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">Event / Async Endpoints</h3>
        ${eventSvcs.map(s => `<div style="margin-bottom:.3rem"><strong style="color:#c9d1d9">${s.name}</strong> <span style="color:#484f58;font-size:.75rem">${(s.operations||[]).map(o=>o.name).join(', ')}</span></div>`).join('')}
      </div>
    </div>

    <div id="setup-view" class="rest-section">
      <h2 style="color:#c9d1d9;margin-bottom:.5rem">AI-Driven Mock Setup <span class="badge" style="background:#23863622;color:#3fb950">Auto</span></h2>
      <p style="color:#8b949e;font-size:.85rem;margin-bottom:1.5rem">Upload or drop a schema file — AI generates all mock data and deploys it to Microcks instantly.</p>

      <!-- Drag-and-drop zone -->
      <div id="setup-dropzone" style="background:#161b22;border:2px dashed #30363d;border-radius:8px;padding:2rem;margin-bottom:1rem;text-align:center;cursor:pointer;transition:all .2s"
        ondragover="event.preventDefault();this.style.borderColor='#3fb950';this.style.background='#23863611'"
        ondragleave="this.style.borderColor='#30363d';this.style.background='#161b22'"
        ondrop="handleFileDrop(event)"
        onclick="document.getElementById('setup-file-input').click()">
        <div style="font-size:2rem;margin-bottom:.5rem;opacity:.5">📂</div>
        <div style="color:#c9d1d9;font-size:.85rem;font-weight:600;margin-bottom:.25rem">Drop a schema file here or click to browse</div>
        <div style="color:#484f58;font-size:.75rem">.graphql, .gql, .json, .yaml, .yml, .txt</div>
        <div id="setup-file-name" style="display:none;color:#3fb950;font-size:.78rem;margin-top:.5rem;font-weight:600"></div>
        <input type="file" id="setup-file-input" accept=".graphql,.gql,.json,.yaml,.yml,.txt" style="display:none" onchange="handleFileSelect(this)">
      </div>

      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:1rem">
        <div style="flex:1;height:1px;background:#30363d"></div>
        <span style="color:#484f58;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em">or paste directly</span>
        <div style="flex:1;height:1px;background:#30363d"></div>
      </div>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <h3 style="color:#3fb950;font-size:.85rem">Schema</h3>
          <span style="color:#484f58;font-size:.72rem">Plain types, JSON, GraphQL SDL, or OpenAPI 3.x</span>
        </div>
        <textarea id="setup-schema" placeholder="Paste a schema here, or use the drop zone above&#10;&#10;1. Plain types:  name: string, age: int&#10;2. JSON types:   { &quot;name&quot;: &quot;string&quot; }&#10;3. GraphQL SDL:  type Query { ... }&#10;4. OpenAPI 3.x JSON/YAML" style="width:100%;height:180px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:monospace;font-size:.78rem;padding:.5rem;resize:vertical"></textarea>
      </div>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <div style="display:flex;gap:1rem;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <label style="color:#8b949e;font-size:.78rem;display:block;margin-bottom:.35rem">Prompt / Instructions <span style="color:#484f58">(optional)</span></label>
            <input id="setup-prompt" type="text" placeholder="e.g. Generate mock data for 10 games with realistic NFL scores and team names" style="width:100%;padding:.5rem;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.85rem">
          </div>
          <div>
            <label style="color:#8b949e;font-size:.78rem;display:block;margin-bottom:.35rem">Service Name <span style="color:#484f58">(optional)</span></label>
            <input id="setup-service-name" type="text" placeholder="e.g. SportsAPI" style="width:180px;padding:.5rem;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.85rem">
          </div>
          <button onclick="runSetup()" id="setup-deploy-btn" style="background:#238636;color:#fff;border:none;padding:.55rem 1.5rem;border-radius:6px;cursor:pointer;font-size:.85rem;font-weight:600;white-space:nowrap">Generate &amp; Deploy</button>
        </div>
      </div>

      <div id="setup-progress" style="display:none;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <h4 style="color:#c9d1d9;font-size:.85rem;margin-bottom:.5rem">Progress</h4>
        <div id="setup-steps" style="font-family:monospace;font-size:.78rem;color:#8b949e"></div>
      </div>

      <div id="setup-result" style="display:none;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem">
        <h4 style="color:#3fb950;font-size:.85rem;margin-bottom:.5rem">✓ Mock API Deployed</h4>
        <div id="setup-result-content" style="font-size:.82rem;color:#c9d1d9"></div>
      </div>
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
// ── User identity (cookie + URL param) ─────────────────────────────────
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function setCookie(name, value) {
  document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax';
}

let mockUser = new URLSearchParams(window.location.search).get('user')
  || getCookie('mock_user')
  || '';

if (!mockUser) {
  mockUser = prompt('Enter your username (for multi-user isolation):') || 'anonymous';
  setCookie('mock_user', mockUser);
} else if (!getCookie('mock_user')) {
  setCookie('mock_user', mockUser);
}

function changeUser() {
  const name = prompt('Change username:', mockUser);
  if (name && name.trim()) {
    mockUser = name.trim();
    setCookie('mock_user', mockUser);
    document.getElementById('user-display').textContent = mockUser;
  }
}

function getHeaders(extra) {
  const h = { 'Content-Type': 'application/json', 'X-User': mockUser };
  if (extra) Object.assign(h, extra);
  return h;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('user-display').textContent = mockUser;
});

const SVC_DATA = ${svcDataJson};
let currentService = '';
let currentOpName = '';
let currentOpType = '';

function hideAll() {
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('explorer').classList.remove('active');
  document.getElementById('rest-view').classList.remove('active');
  document.getElementById('event-view').classList.remove('active');
  document.getElementById('routes-view').classList.remove('active');
  document.getElementById('setup-view').classList.remove('active');
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
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({query: '{ __schema { types { name kind fields { name args { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } type { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } } queryType { name } mutationType { name } } }'})
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

function buildFieldsQuery(schema, typeName, depth = 0) {
  if (depth > 3) return null;
  const t = findType(schema, typeName);
  if (!t || !t.fields || t.fields.length === 0) return null;

  const parts = [];
  for (const f of t.fields.slice(0, 20)) {
    let inner = f.type;
    while (inner && inner.ofType) inner = inner.ofType;
    if (!inner || !inner.name) {
      parts.push(f.name);
      continue;
    }

    if (inner.kind === 'SCALAR' || inner.kind === 'ENUM') {
      parts.push(f.name);
    } else if ((inner.kind === 'OBJECT' || inner.kind === 'INTERFACE' || inner.kind === 'UNION') && depth < 3) {
      const nested = buildFieldsQuery(schema, inner.name, depth + 1);
      if (nested) {
        parts.push(f.name + ' { ' + nested + ' }');
      } else {
        parts.push(f.name + ' { __typename }');
      }
    } else {
      parts.push(f.name);
    }
  }

  if (parts.length > 0) return parts.join(' ');
  const fallback = t.fields.slice(0, 10).map(f => f.name);
  return fallback.length > 0 ? fallback.join(' ') : null;
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

  currentOpName = name;
  currentOpType = type;
  window.__restCtx = null;

  const typeBadge = document.getElementById('editor-type-badge');
  typeBadge.textContent = 'GraphQL';
  typeBadge.className = 'badge graphql';

  const editor = document.getElementById('editor-query');
  const result = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  const srcLabel = document.getElementById('response-source');
  result.textContent = 'Loading...';
  result.className = '';
  timingEl.innerHTML = '';
  srcLabel.style.color = '#30363d';
  srcLabel.textContent = '(from Microcks)';

  ['inline-ai-scenario','inline-ai-prompt','inline-ai-btn','inline-ai-clear','inline-ai-global-wrap'].forEach(id => {
    document.getElementById(id).style.display = '';
  });
  document.getElementById('inline-ai-scenario').value = '';
  document.getElementById('inline-ai-prompt').value = '';
  document.getElementById('inline-ai-global').checked = false;

  const schema = await fetchSchema(currentService);
  const prefix = type === 'MUTATION' ? 'mutation ' : '';

  // Fetch fields from server-side (most reliable — uses parsed .graphql files)
  let fieldsStr = null;
  try {
    const fb = await fetch('/schema/query-fields?operation=' + encodeURIComponent(name) + '&service=' + encodeURIComponent(currentService));
    const fbData = await fb.json();
    if (fbData.fields) fieldsStr = fbData.fields;
  } catch (_) {}

  // Fallback: try client-side introspection
  if (!fieldsStr && schema) {
    const retType = getReturnTypeName(schema, name, type);
    fieldsStr = retType ? buildFieldsQuery(schema, retType) : null;
  }

  function formatFieldsStr(str) {
    let indent = 2;
    let result = '';
    const tokens = str.split(/([{}])/);
    for (const tok of tokens) {
      const trimmed = tok.trim();
      if (!trimmed) continue;
      if (trimmed === '{') { result += ' {\\n' + '  '.repeat(++indent); }
      else if (trimmed === '}') { result += '\\n' + '  '.repeat(--indent) + '}'; }
      else {
        const fields = trimmed.split(/\\s+/).filter(f => f);
        result += fields.join('\\n' + '  '.repeat(indent));
      }
    }
    return result;
  }

  // Build args string — prefer variable syntax when operation has args (for Microcks dispatch matching)
  let argStr = '';
  let vars = {};
  let variableDefs = '';
  try {
    const vRes = await fetch('/schema/query-variables?operation=' + encodeURIComponent(name));
    const vData = await vRes.json();
    if (vData.variableDefs && vData.argumentRefs && Object.keys(vData.variables || {}).length > 0) {
      argStr = vData.argumentRefs;
      vars = vData.variables;
      variableDefs = vData.variableDefs;
      window.__graphqlVariables = vars;
    } else {
      window.__graphqlVariables = null;
      if (schema) {
        const a = getArgStr(schema, name, type);
        if (a) argStr = a;
      }
    }
  } catch (_) {
    window.__graphqlVariables = null;
    if (schema) {
      const a = getArgStr(schema, name, type);
      if (a) argStr = a;
    }
  }

  const opPart = prefix ? prefix.trim() : 'query';
  const queryOp = (opPart === 'mutation' ? 'mutation ' : 'query ') + name + (variableDefs ? ' ' + variableDefs : '');
  const callPart = name + argStr;

  if (fieldsStr) {
    const formatted = fieldsStr.includes('{') ? formatFieldsStr(fieldsStr) : fieldsStr.split(/\\s+/).filter(f=>f).join('\\n    ');
    editor.value = queryOp + ' {\\n  ' + callPart + ' {\\n    ' + formatted + '\\n  }\\n}';
  } else {
    editor.value = queryOp + ' {\\n  ' + callPart + '\\n}';
  }

  result.textContent = 'Click Run (Cmd+Enter) to execute, or select an AI scenario and click Apply Scenario.';
  timingEl.innerHTML = '';
}

function showRest() {
  hideAll();
  document.getElementById('rest-view').classList.add('active');
  document.querySelectorAll('.svc-btn[data-type="rest"]').forEach(b => b.classList.add('active'));
}

let asyncSpecsCache = null;
let currentAsyncPayload = '';

function showEvents() {
  hideAll();
  document.getElementById('event-view').classList.add('active');
  document.querySelectorAll('.svc-btn[data-type="event"]').forEach(b => b.classList.add('active'));
  if (!asyncSpecsCache) loadAsyncSpecs();
}

async function loadAsyncSpecs() {
  try {
    const r = await fetch('/async/specs');
    asyncSpecsCache = await r.json();
    const sel = document.getElementById('async-spec-select');
    sel.innerHTML = '<option value="">Select a spec...</option>';
    for (const [title, spec] of Object.entries(asyncSpecsCache)) {
      const opt = document.createElement('option');
      opt.value = title;
      opt.textContent = title + ' (' + spec.channels.length + ' channels)';
      sel.appendChild(opt);
    }
  } catch (_) {}
}

function loadAsyncChannels() {
  const specTitle = document.getElementById('async-spec-select').value;
  const chSel = document.getElementById('async-channel-select');
  chSel.innerHTML = '<option value="">Select a channel...</option>';
  document.getElementById('async-channel-info').style.display = 'none';
  document.getElementById('async-ai-controls').style.display = 'none';
  document.getElementById('async-example-payload').textContent = 'Select a channel to view examples';
  document.getElementById('async-copy-btn').style.display = 'none';
  document.getElementById('async-ai-result').textContent = 'Generate AI data to see results here';
  hideAsyncValidation();

  if (!specTitle || !asyncSpecsCache || !asyncSpecsCache[specTitle]) return;

  const spec = asyncSpecsCache[specTitle];
  for (const ch of spec.channels) {
    const opt = document.createElement('option');
    opt.value = ch.name;
    const proto = ch.protocol === 'kafka' ? 'Kafka' : ch.protocol === 'rabbitmq' ? 'RabbitMQ' : ch.protocol;
    opt.textContent = ch.name + ' (' + proto + ', ' + ch.direction + ')';
    chSel.appendChild(opt);
  }
}

async function loadAsyncExample() {
  const specTitle = document.getElementById('async-spec-select').value;
  const channel = document.getElementById('async-channel-select').value;
  if (!specTitle || !channel) return;

  try {
    const r = await fetch('/async/examples?spec=' + encodeURIComponent(specTitle) + '&channel=' + encodeURIComponent(channel));
    const data = await r.json();

    document.getElementById('async-channel-info').style.display = 'block';
    document.getElementById('async-ai-controls').style.display = 'block';

    const protoBadge = document.getElementById('async-protocol-badge');
    protoBadge.textContent = data.protocol === 'kafka' ? 'KAFKA' : 'RABBITMQ';
    protoBadge.style.background = data.protocol === 'kafka' ? '#1f6feb22' : '#f0883e22';
    protoBadge.style.color = data.protocol === 'kafka' ? '#58a6ff' : '#f0883e';

    const dirBadge = document.getElementById('async-direction-badge');
    dirBadge.textContent = data.direction.toUpperCase();

    document.getElementById('async-channel-name').textContent = channel;
    document.getElementById('async-channel-desc').textContent = data.description || '';
    document.getElementById('async-msg-name').textContent = data.messageName;
    document.getElementById('async-op-id').textContent = data.operationId;
    document.getElementById('async-content-type').textContent = data.contentType;

    const tabsEl = document.getElementById('async-example-tabs');
    if (data.examples && data.examples.length > 0) {
      tabsEl.style.display = 'flex';
      tabsEl.innerHTML = data.examples.map((ex, i) =>
        '<button onclick="showAsyncExampleTab(' + i + ')" style="background:' + (i === 0 ? '#1f6feb' : '#21262d') + ';color:#fff;border:none;padding:2px 8px;border-radius:3px;cursor:pointer;font-size:.7rem" data-idx="' + i + '">' + (ex.name || 'Example ' + (i+1)) + '</button>'
      ).join('');

      currentAsyncPayload = JSON.stringify(data.examples[0].payload, null, 2);
      document.getElementById('async-example-payload').textContent = currentAsyncPayload;
      document.getElementById('async-copy-btn').style.display = 'block';

      window.__asyncExamples = data.examples;
    } else {
      tabsEl.style.display = 'none';
      document.getElementById('async-example-payload').textContent = 'No examples available for this channel';
      document.getElementById('async-copy-btn').style.display = 'none';
    }

    document.getElementById('async-ai-result').textContent = 'Generate AI data to see results here';
    hideAsyncValidation();
  } catch (e) {
    document.getElementById('async-example-payload').textContent = 'Error loading: ' + e.message;
  }
}

function showAsyncExampleTab(idx) {
  if (!window.__asyncExamples || !window.__asyncExamples[idx]) return;
  currentAsyncPayload = JSON.stringify(window.__asyncExamples[idx].payload, null, 2);
  document.getElementById('async-example-payload').textContent = currentAsyncPayload;
  document.querySelectorAll('#async-example-tabs button').forEach((b, i) => {
    b.style.background = i === idx ? '#1f6feb' : '#21262d';
  });
}

function copyAsyncPayload() {
  navigator.clipboard.writeText(currentAsyncPayload).then(() => {
    const btn = document.getElementById('async-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

async function generateAsyncAI() {
  const specTitle = document.getElementById('async-spec-select').value;
  const channel = document.getElementById('async-channel-select').value;
  const scenario = document.getElementById('async-ai-scenario').value;
  const prompt = document.getElementById('async-ai-prompt').value;

  if (!specTitle || !channel) {
    document.getElementById('async-ai-result').textContent = 'Select a spec and channel first';
    return;
  }
  if (!scenario && !prompt) {
    document.getElementById('async-ai-result').textContent = 'Select a scenario or type a prompt';
    return;
  }

  const resultEl = document.getElementById('async-ai-result');
  resultEl.textContent = 'Generating...';
  resultEl.style.color = '#c9d1d9';
  hideAsyncValidation();

  try {
    const r = await fetch('/async/ai-generate', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ spec: specTitle, channel, scenario: scenario || undefined, prompt: prompt || undefined })
    });
    const data = await r.json();

    if (data.error) {
      resultEl.textContent = 'Error: ' + data.error;
      resultEl.style.color = '#f85149';
      return;
    }

    const generated = data.generated;
    let display;
    try {
      const parsed = typeof generated === 'string' ? JSON.parse(generated) : generated;
      display = JSON.stringify(parsed, null, 2);
      validateAsyncPayload(specTitle, channel, parsed);
    } catch (_) {
      display = typeof generated === 'string' ? generated : JSON.stringify(generated, null, 2);
    }

    resultEl.textContent = display;
    resultEl.style.color = '#7ee787';
  } catch (e) {
    resultEl.textContent = 'Error: ' + e.message;
    resultEl.style.color = '#f85149';
  }
}

async function validateAsyncPayload(specTitle, channel, payload) {
  try {
    const r = await fetch('/async/validate', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ spec: specTitle, channel, payload })
    });
    const d = await r.json();
    if (d.count > 0) showAsyncValidation(d.violations);
  } catch (_) {}
}

function showAsyncValidation(violations) {
  const panel = document.getElementById('async-validation-panel');
  const list = document.getElementById('async-validation-list');
  const count = document.getElementById('async-validation-count');
  count.textContent = violations.length + ' issue' + (violations.length !== 1 ? 's' : '');
  list.innerHTML = violations.map(v => {
    const icon = v.got === 'missing' ? '&#128308;' : v.got === 'null/undefined' ? '&#128308;' : v.expected === 'absent' ? '&#128993;' : '&#128992;';
    return '<div style="padding:2px 0;color:#e3b341;border-bottom:1px solid #533d1133">' +
      '<span style="margin-right:4px">' + icon + '</span>' +
      '<strong style="color:#f0883e">' + escHtml(v.field) + '</strong> ' +
      '<span style="color:#8b949e">expected </span>' +
      '<span style="color:#7ee787">' + escHtml(v.expected) + '</span>' +
      '<span style="color:#8b949e">, got </span>' +
      '<span style="color:#f85149">' + escHtml(v.got) + '</span></div>';
  }).join('');
  panel.style.display = 'block';
}

function hideAsyncValidation() {
  document.getElementById('async-validation-panel').style.display = 'none';
  document.getElementById('async-validation-list').innerHTML = '';
}

function showRoutes() {
  hideAll();
  document.getElementById('routes-view').classList.add('active');
  document.querySelector('.svc-btn[data-type="routes"]').classList.add('active');
}

const REST_PARAM_DEFAULTS = {
  tenant: 'bleacherReport',
  bolt_id: '1250616d-b38d-4d74-864e-9e1016394fec',
  boltId: '1250616d-b38d-4d74-864e-9e1016394fec',
  id: '237',
  user_id: '006320e5-ceea-431e-9dab-8b5c368a8c0c',
  tag_uuid: '0177b48b-0ab4-4dba-b132-de8e1e96cec8',
  tagUUID: '0177b48b-0ab4-4dba-b132-de8e1e96cec8',
  gamePermalink: 'nfl-game-2026-01-15',
  gamecastPermalink: 'nfl-game-2026-01-15',
  permalink: 'nfl',
  season: '2026',
  date: '2026-03-01',
  leagueSlug: 'nfl',
  language: 'en',
  gameId: '1',
  playerId: '1',
  apiWidgetId: '1',
  customerId: '1',
  wranglerConfigId: '1',
};

function substitutePathParams(url) {
  return url.replace(/\\{([^}]+)\\}/g, (match, param) => {
    return REST_PARAM_DEFAULTS[param] || REST_PARAM_DEFAULTS[param.replace(/-/g,'_')] || 'example';
  });
}

function tryRest(method, fullUrl) {
  hideAll();
  document.getElementById('explorer').classList.add('active');
  currentService = '__rest__';

  const resolvedUrl = substitutePathParams(fullUrl);
  const templateUrl = fullUrl;

  // Parse service name + operation from template URL (keep {param} braces intact)
  const urlPath = new URL(templateUrl).pathname;
  const decodedPath = decodeURIComponent(urlPath);
  const restMatch = decodedPath.match(/\\/rest\\/([^/]+)\\/([^/]+)\\/(.*)/);
  let restServiceName = '', restOpPath = '';
  if (restMatch) {
    restServiceName = restMatch[1].replace(/\\+/g, ' ');
    restOpPath = '/' + restMatch[3];
  }
  window.__restCtx = { method, url: resolvedUrl, serviceName: restServiceName, operationName: method + ' ' + restOpPath };

  document.getElementById('editor-svc').textContent = method + ' ' + urlPath;
  const typeBadge = document.getElementById('editor-type-badge');
  typeBadge.textContent = 'REST';
  typeBadge.className = 'badge rest';

  // Show AI controls for REST
  ['inline-ai-scenario','inline-ai-prompt','inline-ai-btn','inline-ai-clear','inline-ai-global-wrap'].forEach(id => {
    document.getElementById(id).style.display = '';
  });
  document.getElementById('inline-ai-scenario').value = '';
  document.getElementById('inline-ai-prompt').value = '';
  document.getElementById('inline-ai-global').checked = false;

  const hasParams = /\\{[^}]+\\}/.test(templateUrl);
  let panelHtml = '<div style="padding:1rem;color:#8b949e;font-size:.82rem">';
  panelHtml += '<strong style="color:#c9d1d9">REST Endpoint</strong><br><br>';
  panelHtml += '<span class="badge ' + method.toLowerCase() + '" style="font-size:.7rem">' + method + '</span>';
  panelHtml += ' <span style="color:#58a6ff;font-size:.78rem">' + restServiceName + '</span><br><br>';
  if (hasParams) {
    panelHtml += '<strong style="color:#f0883e;font-size:.75rem">Path Parameters</strong><br>';
    const params = templateUrl.match(/\\{([^}]+)\\}/g) || [];
    params.forEach(p => {
      const name = p.replace(/[{}]/g, '');
      const val = REST_PARAM_DEFAULTS[name] || REST_PARAM_DEFAULTS[name.replace(/-/g,'_')] || 'example';
      panelHtml += '<span style="color:#79c0ff">{' + name + '}</span> = <span style="color:#7ee787">' + val + '</span><br>';
    });
    panelHtml += '<br>';
  }
  panelHtml += '<div style="margin-top:.5rem;padding-top:.5rem;border-top:1px solid #21262d"><strong style="color:#a371f7;font-size:.72rem">AI Agent</strong><br><span style="font-size:.72rem;color:#484f58">Select a scenario above and click Apply Scenario to generate test data for this REST endpoint via AI.</span></div>';
  panelHtml += '</div>';
  document.getElementById('ops-panel').innerHTML = panelHtml;

  document.getElementById('editor-query').value = resolvedUrl;
  document.getElementById('editor-result').textContent = 'Click Run to send the request, or select an AI scenario and click Apply Scenario.';
  document.getElementById('editor-result').className = '';
  document.getElementById('editor-timing').innerHTML = '';

  const srcLabel = document.getElementById('response-source');
  srcLabel.style.color = '#30363d';
  srcLabel.textContent = '(from Microcks)';
}

async function runQuery() {
  const el = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  el.textContent = 'Loading...';
  el.className = '';
  const start = performance.now();

  hideValidation();

  if (currentService === '__rest__') {
    const method = window.__restCtx.method;
    const url = document.getElementById('editor-query').value.trim();
    window.__restCtx.url = url;
    try {
      const urlObj = new URL(url.startsWith('http') ? url : window.location.origin + url);
      const r = await fetch(urlObj.pathname + urlObj.search, {method, headers: getHeaders({'x-api-key':'mock'})});
      const ms = Math.round(performance.now() - start);
      const text = await r.text();
      let parsed = null;
      let display; try { parsed = JSON.parse(text); display = JSON.stringify(parsed,null,2); } catch(_) { display = text; }
      const sc = r.status < 300 ? 's2' : 's4';
      timingEl.innerHTML = '<span class="pg-status '+sc+'">'+r.status+'</span> '+ms+'ms';
      el.textContent = display;
      if (r.status >= 400) el.className = 'error';
      if (parsed && window.__restCtx.serviceName) {
        validateResponse(window.__restCtx.serviceName, window.__restCtx.operationName, parsed, 'rest');
      }
    } catch(e) { el.textContent = 'Error: '+e.message; el.className = 'error'; }
    return;
  }

  const query = document.getElementById('editor-query').value;
  const cleanQuery = query.replace(/^#.*\\n/gm, '').trim();
  const body = { query: cleanQuery };
  if (window.__graphqlVariables && Object.keys(window.__graphqlVariables).length > 0) {
    body.variables = window.__graphqlVariables;
  }
  try {
    const r = await fetch('/graphql/' + currentService, {
      method:'POST', headers: getHeaders(),
      body: JSON.stringify(body)
    });
    const ms = Math.round(performance.now() - start);
    const xSource = r.headers.get('X-Source') || '';
    const isAI = xSource === 'ai-override';
    const isScenario = xSource === 'ai-scenario';
    const aiLeft = parseInt(r.headers.get('X-Override-Remaining') || '0', 10);
    const text = await r.text();
    let parsed = null;
    let display;
    try { parsed = JSON.parse(text); display = JSON.stringify(parsed,null,2); } catch(_) { display = text; }
    const srcLabel = document.getElementById('response-source');
    const hasErrors = parsed && parsed.errors && parsed.errors.length > 0;
    const hasData = parsed && parsed.data && Object.keys(parsed.data).length > 0;
    let logicalStatus = r.status;
    if (r.status === 200 && hasErrors && !hasData) logicalStatus = 400;
    if (r.status === 200 && hasErrors && hasData) logicalStatus = 206;
    const sc = logicalStatus === 206 ? 's206' : (logicalStatus < 300 ? 's2' : (logicalStatus < 500 ? 's4' : 's5'));
    const sourceHint = isScenario ? '(scenario for ' + mockUser + ')' : isAI ? '(ai-override)' : '(via Microcks)';
    timingEl.innerHTML = '<span class="pg-status '+sc+'">'+logicalStatus+'</span> '+ms+'ms <span style="font-size:.7rem;color:#484f58">' + sourceHint + '</span>';
    el.textContent = display;
    if (hasErrors) el.className = 'error';
    if (parsed && currentOpName) {
      validateResponse(currentService, currentOpName, parsed, 'graphql');
    }
  } catch(e) { el.textContent = 'Error: '+e.message; el.className = 'error'; }
}

function hideValidation() {
  document.getElementById('validation-panel').style.display = 'none';
  document.getElementById('validation-list').innerHTML = '';
}

function extractQueryFields(queryText) {
  try {
    const body = queryText.replace(/^[^{]*\\{/, '').replace(/\\}[^}]*$/, '');
    const inner = body.replace(/^[^{]*\\{/, '').replace(/\\}[^}]*$/, '');
    return inner.split(/[\\s,]+/).map(f => f.trim()).filter(f => f && !f.startsWith('{') && !f.startsWith('}') && !f.includes('(') && !f.includes(':'));
  } catch(_) { return []; }
}

async function validateResponse(service, operation, response, apiType) {
  try {
    let queryFields = [];
    if (apiType === 'graphql') {
      const q = document.getElementById('editor-query').value || '';
      queryFields = extractQueryFields(q);
    }
    const r = await fetch('/ai/validate', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ service, operation, response, apiType, queryFields })
    });
    const d = await r.json();
    if (d.count > 0) {
      showValidation(d.violations);
    }
  } catch(_) {}
}

function showValidation(violations) {
  const panel = document.getElementById('validation-panel');
  const list = document.getElementById('validation-list');
  const count = document.getElementById('validation-count');

  count.textContent = violations.length + ' issue' + (violations.length !== 1 ? 's' : '');
  list.innerHTML = violations.map(v => {
    const icon = v.got === 'missing' ? '🔴' : v.got === 'null' ? '🔴' : v.expected === 'absent' ? '🟡' : '🟠';
    return '<div style="padding:2px 0;color:#e3b341;border-bottom:1px solid #533d1133">' +
      '<span style="margin-right:4px">' + icon + '</span>' +
      '<strong style="color:#f0883e">' + escHtml(v.field) + '</strong> ' +
      '<span style="color:#8b949e">expected </span>' +
      '<span style="color:#7ee787">' + escHtml(v.expected) + '</span>' +
      '<span style="color:#8b949e">, got </span>' +
      '<span style="color:#f85149">' + escHtml(v.got) + '</span>' +
      '</div>';
  }).join('');

  panel.style.display = 'block';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

document.getElementById('editor-query').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
});

function extractFieldsFromQuery(queryText) {
  const clean = queryText.replace(/^#.*$/gm, '').trim();
  const braceIdx = clean.indexOf('{', clean.indexOf('{') + 1);
  if (braceIdx === -1) return [];
  let depth = 0;
  let fieldBlock = '';
  for (let i = braceIdx; i < clean.length; i++) {
    if (clean[i] === '{') { depth++; continue; }
    if (clean[i] === '}') { depth--; if (depth <= 0) break; continue; }
    if (depth === 1) fieldBlock += clean[i];
  }
  return fieldBlock.split(/[\\s,]+/).map(f => f.trim()).filter(f => f && !f.startsWith('#'));
}

async function inlineAIInject() {
  const isRest = currentService === '__rest__' && window.__restCtx;
  if (!isRest && (!currentOpName || !currentService)) return;
  if (isRest && !window.__restCtx.serviceName) return;

  const scenario = document.getElementById('inline-ai-scenario').value;
  const prompt = document.getElementById('inline-ai-prompt').value;
  const isGlobal = document.getElementById('inline-ai-global').checked;
  if (!scenario && !prompt) { document.getElementById('editor-result').textContent = 'Select a scenario or type a prompt, then click Apply Scenario'; return; }

  const result = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  const srcLabel = document.getElementById('response-source');
  const editor = document.getElementById('editor-query');

  if (isRest) {
    const ctx = window.__restCtx;
    result.textContent = 'Applying scenario for REST: ' + ctx.serviceName + ' / ' + ctx.operationName + (isGlobal ? ' (GLOBAL)' : '') + '...';
    result.className = '';
    timingEl.innerHTML = '<span class="pg-status ai">AI</span> applying scenario...';
    srcLabel.textContent = '(applying...)';
    srcLabel.style.color = '#a371f7';

    try {
      const payload = {
        service: ctx.serviceName,
        operation: ctx.operationName,
        apiType: 'rest',
      };
      if (scenario) payload.scenario = scenario;
      if (prompt) payload.prompt = prompt;
      if (isGlobal) payload.global = true;

      const r = await fetch('/ai/scenario', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify(payload)
      });
      const d = await r.json();

      if (d.error) {
        result.textContent = 'AI Error: ' + d.error;
        result.className = 'error';
        timingEl.innerHTML = '<span class="pg-status s4">ERR</span>';
        srcLabel.textContent = '(scenario failed)';
        return;
      }

      srcLabel.textContent = isGlobal ? '(scenario applied globally)' : '(scenario applied for ' + mockUser + ')';
      srcLabel.style.color = '#a371f7';

      result.textContent = JSON.stringify(d.preview, null, 2);
      timingEl.innerHTML = '<span class="pg-status ai">AI</span> scenario active — click Run to verify';
      await runQuery();
    } catch(e) {
      result.textContent = 'Error: ' + e.message;
      result.className = 'error';
    }
    return;
  }

  // GraphQL scenario
  const fields = extractFieldsFromQuery(editor.value);
  result.textContent = 'Applying scenario for: ' + (fields.length ? fields.join(', ') : 'all fields') + (isGlobal ? ' (GLOBAL)' : '') + '...';
  result.className = '';
  timingEl.innerHTML = '<span class="pg-status ai">AI</span> applying scenario...';
  srcLabel.textContent = '(applying...)';
  srcLabel.style.color = '#a371f7';

  try {
    const payload = { service: currentService, operation: currentOpName };
    if (scenario) payload.scenario = scenario;
    if (prompt) payload.prompt = prompt;
    if (fields.length > 0) payload.fields = fields;
    if (isGlobal) payload.global = true;

    const r = await fetch('/ai/scenario', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    const d = await r.json();

    if (d.error) {
      result.textContent = 'AI Error: ' + d.error;
      result.className = 'error';
      timingEl.innerHTML = '<span class="pg-status s4">ERR</span>';
      srcLabel.textContent = '(scenario failed)';
      return;
    }

    srcLabel.textContent = isGlobal ? '(scenario applied globally)' : '(scenario applied for ' + mockUser + ')';
    srcLabel.style.color = '#a371f7';

    await runQuery();
  } catch(e) {
    result.textContent = 'Error: ' + e.message;
    result.className = 'error';
  }
}

async function inlineAIClear() {
  const isRest = currentService === '__rest__' && window.__restCtx;
  if (!isRest && (!currentOpName || !currentService)) return;

  const serviceName = isRest ? window.__restCtx.serviceName : currentService;
  if (!serviceName) return;

  const result = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  const srcLabel = document.getElementById('response-source');

  result.textContent = 'Restoring original Microcks examples for ' + serviceName + '...';
  timingEl.innerHTML = '<span class="pg-status s206">...</span> restoring';

  try {
    await fetch('/ai/overrides', { method: 'DELETE', headers: getHeaders() });
    await fetch('/ai/scenarios/active', { method: 'DELETE', headers: getHeaders() });
    const r = await fetch('/ai/restore', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ service: serviceName })
    });
    const d = await r.json();

    srcLabel.textContent = '(from Microcks)';
    srcLabel.style.color = '#30363d';

    document.getElementById('inline-ai-scenario').value = '';
    document.getElementById('inline-ai-prompt').value = '';
    document.getElementById('inline-ai-global').checked = false;

    result.textContent = d.restored ? 'Scenarios & overrides cleared. Click Run to verify.' : d.reason || 'Cleared.';
    timingEl.innerHTML = '';
  } catch(e) {
    result.textContent = 'Restore error: ' + e.message;
  }
}

function showSetup() {
  hideAll();
  document.getElementById('setup-view').classList.add('active');
  document.querySelector('.svc-btn[data-type="setup"]').classList.add('active');
}

async function runSetup() {
  const schema = document.getElementById('setup-schema').value.trim();
  const prompt = document.getElementById('setup-prompt').value.trim();
  const serviceName = document.getElementById('setup-service-name').value.trim();

  if (!schema) {
    alert('Please paste a GraphQL SDL or OpenAPI spec.');
    return;
  }

  const btn = document.getElementById('setup-deploy-btn');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  btn.style.opacity = '0.6';

  const progressDiv = document.getElementById('setup-progress');
  const stepsDiv = document.getElementById('setup-steps');
  const resultDiv = document.getElementById('setup-result');
  const resultContent = document.getElementById('setup-result-content');
  progressDiv.style.display = 'block';
  resultDiv.style.display = 'none';
  stepsDiv.innerHTML = '<div style="color:#58a6ff">⏳ Starting AI setup...</div>';

  try {
    const body = {};
    if (schema) body.schema = schema;
    if (prompt) body.prompt = prompt;
    if (serviceName) body.serviceName = serviceName;

    const r = await fetch('/ai/setup', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await r.json();

    if (!r.ok) {
      stepsDiv.innerHTML = '<div style="color:#f85149">✗ ' + (data.error || 'Setup failed') + '</div>';
      if (data.steps) {
        data.steps.forEach(s => {
          stepsDiv.innerHTML += '<div style="color:' + (s.status === 'done' ? '#3fb950' : s.status === 'warning' ? '#d29922' : '#f85149') + '">' + (s.status === 'done' ? '✓' : s.status === 'warning' ? '⚠' : '✗') + ' ' + s.step + '</div>';
        });
      }
      return;
    }

    stepsDiv.innerHTML = '';
    (data.steps || []).forEach(s => {
      const icon = s.status === 'done' ? '✓' : s.status === 'warning' ? '⚠' : '○';
      const color = s.status === 'done' ? '#3fb950' : s.status === 'warning' ? '#d29922' : '#8b949e';
      stepsDiv.innerHTML += '<div style="color:' + color + '">' + icon + ' ' + s.step + '</div>';
    });

    resultDiv.style.display = 'block';
    const isRest = data.schemaType === 'openapi';
    let html = '<div style="margin-bottom:.75rem"><strong>Service:</strong> ' + data.serviceName + ' &nbsp;|&nbsp; <strong>Operations:</strong> ' + data.operationCount + ' &nbsp;|&nbsp; <strong>Type:</strong> ' + (isRest ? 'REST (OpenAPI)' : 'GraphQL') + '</div>';
    if (isRest) {
      html += '<div style="margin-bottom:.75rem"><strong>REST Base:</strong> <code style="background:#21262d;padding:2px 6px;border-radius:4px;color:#58a6ff">' + data.restEndpoint + '</code></div>';
    } else {
      html += '<div style="margin-bottom:.75rem"><strong>GraphQL Endpoint:</strong> <code style="background:#21262d;padding:2px 6px;border-radius:4px;color:#58a6ff">POST ' + data.graphqlEndpoint + '</code></div>';
    }
    html += '<div style="margin-bottom:.5rem"><strong>Mock Routes:</strong></div>';
    html += '<div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.5rem;max-height:200px;overflow:auto">';
    (data.mockRoutes || []).forEach(route => {
      const statusDot = route.exampleGenerated ? '<span style="color:#3fb950">●</span>' : '<span style="color:#d29922">●</span>';
      if (isRest) {
        html += '<div style="font-family:monospace;font-size:.78rem;padding:2px 0;color:#c9d1d9">' + statusDot + ' ' + route.method + ' ' + route.path + '</div>';
      } else {
        html += '<div style="font-family:monospace;font-size:.78rem;padding:2px 0;color:#c9d1d9">' + statusDot + ' ' + route.method + ' ' + route.operation + ' → ' + (route.returnType || '') + (route.isList ? '[]' : '') + '</div>';
      }
    });
    html += '</div>';
    const filesArr = [data.schemaFile || data.openapiFile, data.examplesFile].filter(Boolean);
    html += '<div style="margin-top:.75rem;font-size:.78rem;color:#8b949e">Files: ' + filesArr.map(f => '<code>' + f + '</code>').join(', ') + '</div>';
    resultContent.innerHTML = html;

    lastFetch = 0;
    fetch('/api/services').then(r => r.json()).then(() => {});
  } catch (err) {
    stepsDiv.innerHTML = '<div style="color:#f85149">✗ Network error: ' + err.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate & Deploy';
    btn.style.opacity = '1';
  }
}

// ── File drag-and-drop / upload handling ──────────────────────

function handleFileDrop(e) {
  e.preventDefault();
  const dz = document.getElementById('setup-dropzone');
  dz.style.borderColor = '#30363d';
  dz.style.background = '#161b22';
  const file = e.dataTransfer.files[0];
  if (file) readSchemaFile(file);
}

function handleFileSelect(input) {
  const file = input.files[0];
  if (file) readSchemaFile(file);
}

function readSchemaFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const content = e.target.result;
    document.getElementById('setup-schema').value = content;
    const fnLabel = document.getElementById('setup-file-name');
    fnLabel.textContent = '✓ ' + file.name + ' (' + (content.length / 1024).toFixed(1) + ' KB)';
    fnLabel.style.display = 'block';

    // Auto-detect service name from filename
    const nameInput = document.getElementById('setup-service-name');
    if (!nameInput.value.trim()) {
      const baseName = file.name.replace(/\.(graphql|gql|json|yaml|yml|txt)$/i, '')
        .replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, '');
      if (baseName) nameInput.value = baseName;
    }

    // DO NOT auto-trigger generation - wait for user to provide prompt
    // User must click "Generate & Deploy" button
    document.getElementById('editor-result').innerHTML = '<div style="color:#58a6ff">✓ Schema loaded. Now enter a prompt and click Generate & Deploy</div>';
  };
  reader.readAsText(file);
}

// ── Re-generate service mock data ──────────────────────

function regenService(serviceName, type) {
  const overlay = document.createElement('div');
  overlay.className = 'regen-modal-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = '<div class="regen-modal">'
    + '<h3 style="color:#c9d1d9;margin:0 0 .75rem;font-size:.95rem">Re-generate: ' + serviceName + '</h3>'
    + '<p style="color:#8b949e;font-size:.78rem;margin-bottom:1rem">AI will regenerate all mock data for this service. Optionally provide a prompt to customize the data.</p>'
    + '<div style="margin-bottom:.75rem"><label style="color:#8b949e;font-size:.78rem;display:block;margin-bottom:.25rem">Prompt (optional)</label>'
    + '<input id="regen-prompt" type="text" placeholder="e.g. Use NFL teams, realistic scores, 2025 season data" style="width:100%;padding:.5rem;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:.85rem;box-sizing:border-box"></div>'
    + '<div id="regen-status" style="display:none;margin-bottom:.75rem;font-family:monospace;font-size:.78rem;color:#8b949e"></div>'
    + '<div style="display:flex;gap:.5rem;justify-content:flex-end">'
    + '<button onclick="this.closest(\\'.regen-modal-overlay\\').remove()" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.82rem">Cancel</button>'
    + '<button id="regen-go-btn" onclick="doRegen(\\'' + serviceName + '\\',\\'' + type + '\\')" style="background:#238636;color:#fff;border:none;padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.82rem;font-weight:600">Re-generate</button>'
    + '</div></div>';

  document.body.appendChild(overlay);
  setTimeout(function() { document.getElementById('regen-prompt').focus(); }, 100);
}

async function doRegen(serviceName, type) {
  const prompt = document.getElementById('regen-prompt').value.trim();
  const statusEl = document.getElementById('regen-status');
  const btn = document.getElementById('regen-go-btn');

  btn.disabled = true;
  btn.textContent = 'Generating...';
  btn.style.opacity = '0.6';
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<div style="color:#58a6ff">⏳ Finding schema for ' + serviceName + '...</div>';

  // Spin the sidebar icon
  const allIcons = document.querySelectorAll('.regen-icon');
  let spinIcon = null;
  allIcons.forEach(function(icon) {
    if (icon.closest('.svc-btn') && icon.closest('.svc-btn').textContent.includes(serviceName)) {
      icon.classList.add('spinning');
      spinIcon = icon;
    }
  });

  try {
    // Find the schema file in artifacts
    const schemaR = await fetch('/ai/service-schema?service=' + encodeURIComponent(serviceName));
    const schemaData = await schemaR.json();
    if (schemaData.error) throw new Error(schemaData.error);

    statusEl.innerHTML += '<div style="color:#3fb950">✓ Schema loaded (' + (schemaData.schema.length/1024).toFixed(1) + ' KB)</div>';
    statusEl.innerHTML += '<div style="color:#58a6ff">⏳ Running AI setup...</div>';

    const body = { schema: schemaData.schema, serviceName: serviceName };
    if (prompt) body.prompt = prompt;

    const r = await fetch('/ai/setup', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await r.json();

    if (!r.ok) throw new Error(data.error || 'Setup failed');

    statusEl.innerHTML = '';
    (data.steps || []).forEach(function(s) {
      const icon = s.status === 'done' ? '✓' : s.status === 'warning' ? '⚠' : '○';
      const color = s.status === 'done' ? '#3fb950' : s.status === 'warning' ? '#d29922' : '#8b949e';
      statusEl.innerHTML += '<div style="color:' + color + '">' + icon + ' ' + s.step + '</div>';
    });
    statusEl.innerHTML += '<div style="color:#3fb950;font-weight:600;margin-top:.5rem">✓ Done — ' + (data.operationCount || 0) + ' operations regenerated</div>';

    btn.textContent = 'Done!';
    btn.style.background = '#23863688';
    setTimeout(function() {
      const modal = document.querySelector('.regen-modal-overlay');
      if (modal) modal.remove();
    }, 2000);

    // Refresh page to pick up new data
    lastFetch = 0;
    schemaCache = {};
  } catch (err) {
    statusEl.innerHTML += '<div style="color:#f85149">✗ ' + err.message + '</div>';
    btn.disabled = false;
    btn.textContent = 'Re-generate';
    btn.style.opacity = '1';
  } finally {
    if (spinIcon) spinIcon.classList.remove('spinning');
  }
}
</script>
</body>
</html>`);
});

module.exports = router;
