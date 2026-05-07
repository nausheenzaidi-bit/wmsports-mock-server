const express = require('express');
const router = express.Router();
const { MICROCKS_URL } = require('../config.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');
const { isServiceVisibleInWorkspace, serviceRegistry } = require('../state.cjs');
const { isInNamespace, getDisplayName } = require('../lib/microcks-namespace.cjs');

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return cookies;
}

router.get('/', async (req, res) => {
  const allServices = await fetchMicrocksServices();
  const cookies = parseCookies(req.headers.cookie);
  const activeWs = cookies.mock_workspace || null;

  // Decorate services with `displayName` (prefix + workspace-id stripped) so
  // the UI can render human-friendly labels while keeping `name` as the
  // canonical identifier for backend operations.
  const services = allServices
    .filter(s => isServiceVisibleInWorkspace(s.name, activeWs))
    .map(s => ({
      ...s,
      displayName: getDisplayName(s.name, serviceRegistry[s.name] || null),
    }));

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ services, microcks: MICROCKS_URL });
  }

  const graphqlSvcs = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
  const restSvcs = services.filter(s => s.type === 'REST');
  const eventSvcs = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
  const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);

  const host = `${req.protocol}://${req.get('host')}`;
  const microcksUp = services.length > 0;

  const delIcon = (name) => isInNamespace(name)
    ? `<span class="delete-icon" title="Delete from Microcks" onclick="event.stopPropagation();deleteService('${name.replace(/'/g, "\\'")}')">🗑</span>`
    : '';

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
    return `<div class="rest-svc" data-svc="${s.name}"><h3>${s.displayName || s.name} <span class="badge rest">REST</span> <span class="ops-count">${s.operations?.length || 0}</span></h3>${ops}</div>`;
  }).join('\n');

  const eventRows = eventSvcs.map(s => {
    const ops = (s.operations || []).map(o => o.name).join(', ');
    return `<tr><td><strong>${s.displayName || s.name}</strong></td><td><span class="badge event">Event</span></td><td><span class="ops-count">${s.operations?.length || 0}</span></td><td>${ops}</td></tr>`;
  }).join('\n');

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WM Sports Mock Server</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#1c2128;--border:#21262d;--border2:#30363d;--fg:#e1e4e8;--fg2:#c9d1d9;--fg3:#8b949e;--fg4:#484f58;--accent:#58a6ff;--accent2:#1f6feb;--green:#238636;--green2:#3fb950;--red:#da3633;--red2:#f85149;--purple:#8957e5;--purple2:#a371f7;--orange:#f0883e;--yellow:#d29922;--pink:#e535ab;--code-bg:#0d1117;--card-bg:#161b22}
[data-theme="light"]{--bg:#ffffff;--bg2:#f6f8fa;--bg3:#eaeef2;--border:#d0d7de;--border2:#d0d7de;--fg:#1f2328;--fg2:#1f2328;--fg3:#656d76;--fg4:#8b949e;--accent:#0969da;--accent2:#0969da;--green:#1a7f37;--green2:#1a7f37;--red:#cf222e;--red2:#cf222e;--purple:#8250df;--purple2:#8250df;--orange:#bc4c00;--yellow:#9a6700;--pink:#bf3989;--code-bg:#f6f8fa;--card-bg:#ffffff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
.header{background:var(--bg2);border-bottom:1px solid var(--border2);padding:1rem 1.5rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.header h1{font-size:1.3rem;color:var(--fg2)}
.status-badge{padding:3px 10px;border-radius:12px;font-size:.7rem;font-weight:600}
.status-badge.online{background:var(--green);color:#fff}
.status-badge.offline{background:var(--red);color:#fff}
.user-badge{display:flex;align-items:center;gap:.35rem;padding:3px 10px;border-radius:12px;background:var(--bg2);border:1px solid var(--border2);cursor:pointer;transition:border-color .15s}
.user-badge:hover{border-color:var(--accent)}
.user-badge strong{color:var(--accent)}
.stats-bar{display:flex;gap:1.5rem;margin-left:auto;font-size:.8rem;color:var(--fg3)}
.stats-bar strong{color:var(--accent)}
.theme-btn{background:none;border:1px solid var(--border2);border-radius:12px;padding:3px 10px;cursor:pointer;font-size:.75rem;color:var(--fg3);transition:all .15s}
.theme-btn:hover{border-color:var(--accent);color:var(--accent)}
.layout{display:flex;height:calc(100vh - 56px)}
.sidebar{width:240px;min-width:0;background:var(--bg);border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;transition:width .2s ease}
.sidebar.collapsed{width:0;overflow:hidden;border-right:none}
.sidebar-toggle{position:relative;z-index:10;background:var(--bg2);border:1px solid var(--border2);border-left:none;border-radius:0 4px 4px 0;padding:0;cursor:pointer;color:var(--fg3);font-size:.65rem;transition:all .2s;line-height:1;width:14px;text-align:center;align-self:stretch;flex-shrink:0}
.sidebar-toggle:hover{color:var(--accent);border-color:var(--accent)}
.sidebar-section{padding:.3rem 0}
.sidebar-section h3{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg4);padding:.3rem .8rem;user-select:none;cursor:pointer;display:flex;align-items:center;gap:.3rem}
.sidebar-section h3 .section-arrow{font-size:.55rem;transition:transform .15s;color:var(--fg4)}
.sidebar-section h3 .section-arrow.collapsed{transform:rotate(-90deg)}
.sidebar-section .section-items{overflow:hidden;transition:max-height .2s ease}
.sidebar-section .section-items.collapsed{max-height:0 !important}
.svc-btn{display:flex;align-items:center;gap:.4rem;padding:.35rem .8rem;cursor:pointer;font-size:.78rem;color:var(--fg2);border:none;background:none;width:100%;text-align:left}
.svc-btn:hover{background:var(--bg2)}
.svc-btn.active{background:color-mix(in srgb, var(--accent) 12%, transparent);color:var(--accent);border-left:2px solid var(--accent)}
.svc-btn .cnt{margin-left:auto;font-size:.65rem;color:var(--fg4);background:var(--border);padding:1px 5px;border-radius:8px}
.badge{padding:1px 6px;border-radius:3px;font-size:.6rem;font-weight:700;text-transform:uppercase}
.badge.graphql{background:color-mix(in srgb, var(--pink) 15%, transparent);color:var(--pink)}
.badge.rest{background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent)}
.badge.event{background:color-mix(in srgb, var(--orange) 15%, transparent);color:var(--orange)}
.badge.query{background:color-mix(in srgb, var(--green2) 15%, transparent);color:var(--green2)}.badge.mutation{background:color-mix(in srgb, var(--red2) 15%, transparent);color:var(--red2)}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative}
.explorer{display:none;flex:1;overflow:hidden}
.explorer.active{display:flex}
.explorer .ops-panel{width:240px;min-width:200px;background:var(--bg);border-right:1px solid var(--border);overflow-y:auto;padding:.5rem 0;display:flex;flex-direction:column}
.ops-panel h4{font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:var(--fg4);padding:.4rem .8rem .2rem;margin-top:.2rem}
.ops-panel-back{display:flex;align-items:center;gap:.3rem;padding:.4rem .8rem;cursor:pointer;font-size:.72rem;color:var(--accent);border:none;background:none;width:100%;text-align:left;border-bottom:1px solid var(--border);margin-bottom:.3rem;font-weight:600}
.ops-panel-back:hover{background:var(--bg2)}
.ops-fields-header{display:flex;align-items:center;gap:.4rem;padding:.3rem .6rem;border-bottom:1px solid var(--border);font-size:.65rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg4)}
.ops-fields-header button{background:var(--border);color:var(--fg3);border:none;padding:1px 6px;border-radius:3px;font-size:.6rem;cursor:pointer}
.ops-fields-header button:hover{background:var(--border2);color:var(--fg2)}
.op-btn{display:flex;align-items:center;gap:.4rem;padding:.3rem .8rem;cursor:pointer;font-size:.78rem;color:var(--fg2);border:none;background:none;width:100%;text-align:left}
.op-btn:hover{background:var(--bg2)}
.op-btn.active{background:color-mix(in srgb, var(--accent) 10%, transparent);color:var(--accent)}
.op-btn .ret{margin-left:auto;color:var(--fg4);font-size:.68rem;font-family:"SF Mono",Menlo,monospace;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.editor-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.editor-header{background:var(--bg2);border-bottom:1px solid var(--border);padding:.4rem 1rem;display:flex;align-items:center;gap:.5rem;font-size:.85rem}
.editor-header strong{color:var(--fg2)}
.editor-header .run-btn{margin-left:auto;background:var(--green);color:#fff;border:none;padding:5px 16px;border-radius:4px;cursor:pointer;font-size:.85rem;font-weight:600}
.editor-header .run-btn:hover{background:color-mix(in srgb, var(--green) 85%, white)}
.editor-header .timing{color:var(--fg3);font-size:.8rem;margin-right:.5rem}
.editor-body{display:flex;flex:1;overflow:hidden}
.editor-left{flex:1;display:flex;flex-direction:column;border-right:1px solid var(--border)}
.editor-left label,.editor-right label{display:block;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;color:var(--fg4);padding:.4rem .8rem;background:var(--bg);border-bottom:1px solid var(--border)}
.editor-left textarea{flex:1;width:100%;background:var(--code-bg);border:none;color:var(--fg2);font-family:"SF Mono",Menlo,monospace;font-size:.85rem;padding:.8rem;resize:none;outline:none}
.editor-right{flex:1;display:flex;flex-direction:column;overflow:hidden}
#bottom-panel-wrap{resize:vertical;overflow:auto}
.editor-right pre{flex:1;margin:0;padding:.8rem;font-family:"SF Mono",Menlo,monospace;font-size:.82rem;color:var(--green2);overflow:auto;white-space:pre-wrap;background:var(--code-bg)}
.editor-right pre.error{color:var(--red2)}
.pg-status{padding:1px 6px;border-radius:3px;font-size:.72rem;font-weight:600;margin-right:.3rem}
.pg-status.s2{background:var(--green);color:#fff}.pg-status.s206{background:var(--yellow);color:#fff}.pg-status.s4{background:var(--red);color:#fff}.pg-status.s5{background:var(--red);color:#fff}.pg-status.ai{background:var(--purple);color:#fff}
.welcome{padding:3rem;color:var(--fg4);font-size:1rem;text-align:center;margin:auto}
.welcome h2{color:var(--fg2);margin-bottom:.5rem;font-size:1.2rem}
.rest-section,.event-section{display:none;padding:1.5rem;overflow-y:auto;flex:1}
.rest-section.active,.event-section.active{display:block}
.rest-svc{background:var(--card-bg);border:1px solid var(--border2);border-radius:8px;padding:1rem;margin-bottom:1rem}
.rest-svc h3{font-size:.95rem;margin-bottom:.5rem;color:var(--fg2)}
.rest-ep{display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.85rem;flex-wrap:wrap}
.rest-ep button{margin-left:auto;background:var(--green);color:#fff;border:none;padding:3px 10px;border-radius:3px;cursor:pointer;font-size:.75rem}
.rest-ep button:hover{background:color-mix(in srgb, var(--green) 85%, white)}
.method{padding:2px 6px;border-radius:3px;font-weight:700;font-size:.65rem;min-width:40px;text-align:center}
.get{background:var(--accent2);color:#fff}.post{background:var(--green);color:#fff}.put{background:var(--orange);color:#fff}.delete{background:var(--red);color:#fff}
code{background:var(--bg3);padding:1px 5px;border-radius:3px;font-size:.8rem;color:var(--accent)}
.ops-count{background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent);padding:1px 6px;border-radius:8px;font-size:.72rem;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--card-bg);border:1px solid var(--border2);border-radius:8px;overflow:hidden}
th{background:var(--bg3);text-align:left;padding:.5rem .8rem;color:var(--fg3);font-size:.75rem;text-transform:uppercase}
td{padding:.5rem .8rem;border-top:1px solid var(--border);font-size:.85rem}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.footer-bar{background:var(--bg2);border-top:1px solid var(--border);padding:.4rem 1rem;font-size:.72rem;color:var(--fg4);display:flex;gap:1rem;align-items:center}
.svc-btn{display:flex;align-items:center;justify-content:space-between}
.svc-btn .svc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}
.svc-btn .svc-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}
.regen-icon{display:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;font-size:12px;color:var(--fg3);cursor:pointer;transition:all .15s}
.svc-btn:hover .regen-icon{display:inline-block}
.regen-icon:hover{background:color-mix(in srgb, var(--green2) 25%, transparent);color:var(--green2)}
.regen-icon.spinning{display:inline-block;animation:spin .8s linear infinite;color:var(--green2)}
.delete-icon{display:none;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;font-size:11px;color:var(--fg3);cursor:pointer;transition:all .15s}
.svc-btn:hover .delete-icon{display:inline-block}
.delete-icon:hover{background:color-mix(in srgb, #da3633 25%, transparent);color:#da3633}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
#setup-dropzone.drag-active{border-color:var(--green2) !important;background:color-mix(in srgb, var(--green2) 5%, transparent) !important}
.regen-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:1000;display:flex;align-items:center;justify-content:center}
.regen-modal{background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:1.5rem;width:460px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.4)}
.field-tree{font-size:.78rem;font-family:"SF Mono",Menlo,monospace;overflow-y:auto;flex:1}
.ft-node{padding:1px 0}
.ft-toggle{display:inline-flex;align-items:center;gap:4px;cursor:pointer;padding:2px 4px;border-radius:3px;border:none;background:none;color:var(--fg2);font-family:inherit;font-size:inherit;width:100%;text-align:left}
.ft-toggle:hover{background:var(--bg2)}
.ft-toggle .ft-arrow{color:var(--fg4);font-size:.7rem;width:14px;text-align:center;transition:transform .15s;flex-shrink:0}
.ft-toggle .ft-arrow.open{transform:rotate(90deg)}
.ft-toggle .ft-check{width:14px;height:14px;border-radius:3px;border:1px solid var(--border2);background:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;color:var(--green2);transition:all .15s}
.ft-toggle .ft-check.checked{background:color-mix(in srgb, var(--green2) 25%, transparent);border-color:var(--green2)}
.ft-toggle .ft-fname{color:var(--fg2)}
.ft-toggle .ft-type{color:var(--fg4);margin-left:auto;font-size:.68rem}
.ft-toggle .ft-type.scalar{color:var(--accent)}
.ft-toggle .ft-type.object{color:var(--pink)}
.ft-toggle .ft-type.list{color:var(--orange)}
.ft-children{padding-left:14px;border-left:1px solid var(--border);margin-left:7px}
.var-panel{border-top:1px solid var(--border);padding:.5rem .8rem;max-height:200px;overflow-y:auto}
.var-row{display:flex;align-items:center;gap:.5rem;padding:3px 0;font-size:.8rem}
.var-row label{color:var(--accent);font-family:"SF Mono",Menlo,monospace;min-width:80px;font-size:.78rem}
.var-row input{flex:1;background:var(--code-bg);border:1px solid var(--border2);border-radius:4px;color:var(--fg2);padding:3px 6px;font-size:.78rem;font-family:"SF Mono",Menlo,monospace}
.var-row .var-type{color:var(--fg4);font-size:.68rem;min-width:50px}
.scenario-suggest{overflow-y:auto;padding:.5rem .8rem;flex:1}
.suggest-card{background:var(--card-bg);border:1px solid var(--border2);border-radius:6px;padding:.5rem .6rem;margin-bottom:.4rem;cursor:pointer;transition:border-color .15s}
.suggest-card:hover{border-color:var(--accent)}
.suggest-card.active-scenario{border-color:var(--purple);background:color-mix(in srgb, var(--purple) 8%, transparent)}
.suggest-card .sc-name{color:var(--fg2);font-size:.78rem;font-weight:600}
.suggest-card .sc-cat{padding:1px 5px;border-radius:3px;font-size:.55rem;font-weight:600;text-transform:uppercase}
.suggest-card .sc-cat.edge-case{background:color-mix(in srgb, var(--yellow) 15%, transparent);color:var(--yellow)}
.suggest-card .sc-cat.error-handling{background:color-mix(in srgb, var(--red2) 15%, transparent);color:var(--red2)}
.suggest-card .sc-cat.data-integrity{background:color-mix(in srgb, var(--green2) 15%, transparent);color:var(--green2)}
.suggest-card .sc-cat.business-logic{background:color-mix(in srgb, var(--purple2) 15%, transparent);color:var(--purple2)}
.suggest-card .sc-cat.performance{background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent)}
.suggest-card .sc-cat.security{background:color-mix(in srgb, var(--orange) 15%, transparent);color:var(--orange)}
.suggest-card .sc-desc{color:var(--fg3);font-size:.68rem;margin-top:2px}
.suggest-card .sc-sev{font-size:.55rem;font-weight:700;padding:1px 5px;border-radius:3px}
.suggest-card .sc-sev.critical{background:color-mix(in srgb, var(--red2) 15%, transparent);color:var(--red2)}
.suggest-card .sc-sev.high{background:color-mix(in srgb, var(--yellow) 15%, transparent);color:var(--yellow)}
.suggest-card .sc-sev.medium{background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--accent)}
.suggest-card .sc-sev.low{background:var(--border);color:var(--fg3)}
.ws-switcher{display:flex;align-items:center;gap:.35rem;padding:3px 10px;border-radius:12px;background:var(--bg2);border:1px solid var(--border2);cursor:pointer;transition:border-color .15s;font-size:.78rem}
.ws-switcher:hover{border-color:var(--purple2)}
.ws-switcher strong{color:var(--purple2)}
.tab-bar{display:flex;gap:0;border-bottom:1px solid var(--border);background:var(--bg)}
.tab-bar button{background:none;border:none;border-bottom:2px solid transparent;color:var(--fg3);padding:5px 10px;font-size:.68rem;cursor:pointer;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.tab-bar button:hover{color:var(--fg2)}
.tab-bar button.active{color:var(--accent);border-bottom-color:var(--accent)}
.fields-sidebar{display:none}
.fields-sidebar.visible{display:none}
.apply-btn{background:var(--purple);color:#fff;border:none;padding:3px 10px;border-radius:3px;font-size:.65rem;cursor:pointer;font-weight:600;transition:opacity .15s}
.apply-btn:hover{opacity:.85}
.apply-btn:disabled{opacity:.4;cursor:not-allowed}
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
  <div class="ws-switcher" id="ws-switcher" onclick="toggleWorkspaceMenu()" title="Workspaces — isolate scenarios">
    <span style="font-size:.7rem;opacity:.6">Workspace:</span>
    <strong id="ws-display">Default</strong>
    <span style="font-size:.6rem;color:var(--fg4)">▼</span>
  </div>
  <div class="stats-bar">
    <span><strong>${graphqlSvcs.length}</strong> GraphQL</span>
    <span><strong>${restSvcs.length}</strong> REST</span>
    <span><strong>${eventSvcs.length}</strong> Event</span>
    <span><strong>${totalOps}</strong> ops</span>
  </div>
  <button class="theme-btn" onclick="toggleTheme()" id="theme-toggle-btn" title="Toggle light/dark theme">Light</button>
</div>
<div class="layout">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-section" id="section-graphql">
      <h3 onclick="toggleSection(this)"><span class="section-arrow">▼</span> GraphQL Services</h3>
      <div class="section-items" style="max-height:2000px">
      ${graphqlSvcs.map(s => {
        const qc = (s.operations||[]).filter(o=>o.method==='QUERY').length;
        const mc = (s.operations||[]).filter(o=>o.method==='MUTATION').length;
        return `<button class="svc-btn" data-svc="${s.name}" data-type="graphql" onclick="selectService('${s.name}')"><span class="svc-name">${s.displayName || s.name}</span><span class="svc-actions">${delIcon(s.name)}<span class="regen-icon" title="Re-generate mock data" onclick="event.stopPropagation();regenService('${s.name}','graphql')">↻</span><span class="cnt">${qc}Q${mc?'/'+mc+'M':''}</span></span></button>`;
      }).join('\n')}
      </div>
    </div>
    <div class="sidebar-section" id="section-rest">
      <h3 onclick="toggleSection(this)"><span class="section-arrow">▼</span> REST APIs</h3>
      <div class="section-items" style="max-height:2000px">
      ${restSvcs.map(s => `<button class="svc-btn" data-svc="${s.name}" data-type="rest" onclick="showRest()"><span class="svc-name">${s.displayName || s.name}</span><span class="svc-actions">${delIcon(s.name)}<span class="regen-icon" title="Re-generate mock data" onclick="event.stopPropagation();regenService('${s.name}','rest')">↻</span><span class="cnt">${s.operations?.length||0}</span></span></button>`).join('\n')}
      </div>
    </div>
    <div class="sidebar-section" id="section-event">
      <h3 onclick="toggleSection(this)"><span class="section-arrow">▼</span> Event / Async</h3>
      <div class="section-items" style="max-height:2000px">
      ${eventSvcs.map(s => `<button class="svc-btn" data-svc="${s.name}" data-type="event" onclick="showEvents()"><span class="svc-name">${s.displayName || s.name}</span><span class="svc-actions">${delIcon(s.name)}<span class="cnt">${s.operations?.length||0}</span></span></button>`).join('\n')}
      </div>
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
  <button class="sidebar-toggle" id="sidebar-toggle" onclick="toggleSidebar()">◂</button>
  <div class="main" id="main-panel">
    <div id="welcome" class="welcome" style="display:flex;flex-direction:column">
      <h2>Select a service from the sidebar</h2>
      <p>Click any GraphQL service to explore its queries and mutations, or click REST/Event to browse endpoints.</p>
    </div>

    <div id="explorer" class="explorer">
      <div class="ops-panel" id="ops-panel">
        <div id="ops-list"></div>
        <div id="ops-fields-view" style="display:none;flex-direction:column;overflow:hidden">
          <button class="ops-panel-back" onclick="showOpsList()">← Operations</button>
          <div class="ops-fields-header">
            <span style="flex:1">Fields</span>
            <button onclick="fieldTreeSelectAll()">All</button>
            <button onclick="fieldTreeSelectNone()">None</button>
            <button onclick="applyFieldSelection()" style="background:var(--green);color:#fff;font-weight:600">Apply</button>
          </div>
          <div id="field-tree-root" class="field-tree" style="padding:.3rem .5rem;flex:1;overflow-y:auto">
            <div style="color:var(--fg4);font-size:.75rem;padding:.5rem">Select an operation</div>
          </div>
        </div>
      </div>
      <div class="editor-area">
        <div class="editor-header">
          <span class="badge graphql" id="editor-type-badge">GraphQL</span>
          <strong id="editor-svc"></strong>
          <span class="timing" id="editor-timing"></span>
          <select id="inline-ai-scenario" style="display:none"></select>
          <input id="inline-ai-prompt" style="display:none">
          <input type="checkbox" id="inline-ai-global" style="display:none">
          <span id="inline-ai-global-wrap" style="display:none"></span>
          <span id="inline-ai-btn" style="display:none"></span>
          <span id="inline-ai-clear" style="display:none"></span>
          <div style="display:flex;gap:.4rem;align-items:center;margin-left:auto">
            <button id="clear-scenario-btn" onclick="inlineAIClear()" style="display:none;background:#da363322;color:#f85149;border:1px solid #da363344;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:.72rem">Clear Scenario</button>
            <button class="run-btn" onclick="runQuery()">Run</button>
          </div>
        </div>
        <div id="ws-endpoint-bar" style="display:none;padding:.35rem .8rem;background:var(--code-bg);border-bottom:1px solid var(--border);font-size:.72rem;display:none;align-items:center;gap:.5rem">
          <span style="color:var(--fg4)">Endpoint:</span>
          <code id="ws-endpoint-url" style="color:var(--blue);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></code>
          <button onclick="copyWsEndpoint()" style="background:var(--bg2);color:var(--fg3);border:1px solid var(--border2);padding:2px 8px;border-radius:3px;font-size:.65rem;cursor:pointer">Copy</button>
        </div>
        <div class="editor-body">
          <div class="editor-left" style="display:flex;flex-direction:column;min-width:320px">
            <div style="display:flex;flex:1;overflow:hidden">
              <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
                <textarea id="editor-query" spellcheck="false" placeholder="Select a query from the left panel..." style="flex:1;width:100%;background:var(--code-bg);border:none;color:var(--fg2);font-family:'SF Mono',Menlo,monospace;font-size:.85rem;padding:.8rem;resize:none;outline:none"></textarea>
              </div>
            </div>
            <div style="border-top:1px solid var(--border);display:flex;flex-direction:column;min-height:160px;max-height:45%;" id="bottom-panel-wrap">
              <div class="tab-bar" id="bottom-tabs">
                <button class="active" onclick="switchBottomTab('variables')">Variables</button>
                <button onclick="switchBottomTab('scenarios')">AI Scenarios</button>
              </div>
              <div id="bottom-tab-variables" style="display:flex;flex-direction:column;flex:1;overflow:hidden">
                <div id="variables-panel" style="flex:1;padding:.5rem .8rem;overflow-y:auto">
                  <div style="color:var(--fg4);font-size:.8rem;padding:1rem">Select an operation to configure variables</div>
                </div>
              </div>
              <div id="bottom-tab-scenarios" style="display:none;flex-direction:column;flex:1;overflow:hidden">
                <div style="padding:.3rem .8rem;background:var(--bg);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
                  <span style="font-size:.68rem;color:var(--fg4)">AI test scenarios</span>
                  <input id="custom-scenario-prompt" placeholder="Describe a custom scenario..." style="flex:1;min-width:150px;background:var(--code-bg);border:1px solid var(--border2);border-radius:4px;color:var(--fg2);padding:3px 8px;font-size:.72rem">
                  <button onclick="applyCustomScenario()" style="background:var(--green);color:#fff;border:none;padding:2px 10px;border-radius:3px;font-size:.65rem;cursor:pointer;font-weight:600">Apply Custom</button>
                  <button id="suggest-btn" onclick="loadAISuggestions()" style="background:var(--purple);color:#fff;border:none;padding:2px 10px;border-radius:3px;font-size:.65rem;cursor:pointer;font-weight:600">Suggest</button>
                </div>
                <div id="scenario-suggestions" class="scenario-suggest">
                  <div style="color:var(--fg4);font-size:.8rem;padding:1rem">Enter a custom scenario above or click "Suggest" for AI-generated scenarios</div>
                </div>
              </div>
            </div>
          </div>
          <div class="editor-right">
            <label>Response <span id="response-source" style="font-size:.6rem;color:var(--fg4)">(from Microcks)</span></label>
            <pre id="editor-result">Select a query and click Run</pre>
            <div id="validation-panel" style="display:none;background:color-mix(in srgb, var(--yellow) 5%, var(--bg));border-top:1px solid color-mix(in srgb, var(--yellow) 30%, var(--border));padding:.5rem .8rem;max-height:180px;overflow-y:auto">
              <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem">
                <span style="color:var(--yellow);font-weight:600;font-size:.75rem">⚠ Schema Violations</span>
                <span id="validation-count" style="background:color-mix(in srgb, var(--yellow) 15%, transparent);color:var(--yellow);padding:1px 6px;border-radius:8px;font-size:.68rem;font-weight:600"></span>
              </div>
              <div id="validation-list" style="font-family:'SF Mono',Menlo,monospace;font-size:.75rem"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="rest-view" class="rest-section">
      <h2 style="color:var(--fg2);margin-bottom:1rem">REST APIs</h2>
      ${restRows}
    </div>

    <div id="event-view" class="event-section">
      <h2 style="color:var(--fg2);margin-bottom:1rem">Event / Async APIs <span class="badge event">Messages</span></h2>
      <p style="color:var(--fg3);font-size:.85rem;margin-bottom:1rem">View message schemas and examples from AsyncAPI specs. Generate AI test data for Kafka/RabbitMQ payloads.</p>

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
      <p style="color:#8b949e;font-size:.85rem;margin-bottom:1rem">Hit these URLs from any client (curl, Postman, tests). Requests flow through this dashboard so workspace overrides, AI-generated variants, and active scenarios are applied before Microcks plays back the response.</p>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">GraphQL Endpoints</h3>
        <p style="color:#8b949e;font-size:.78rem;margin-bottom:.5rem">POST to these URLs with <code>{"query": "{ operationName { fields } }"}</code></p>
        <table><thead><tr><th>Service</th><th>Mock URL</th><th>Operations</th></tr></thead><tbody>
        ${graphqlSvcs.map(s => {
          const oc = (s.operations||[]).length;
          return `<tr><td style="font-weight:600">${s.displayName || s.name}</td><td><code style="color:#79c0ff">${host}/graphql/${s.name}</code></td><td>${oc}</td></tr>`;
        }).join('')}
        </tbody></table>
      </div>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-bottom:1rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">REST Endpoints</h3>
        ${restSvcs.map(s => {
          const ops = (s.operations||[]);
          return `<div style="margin-bottom:.8rem"><strong style="color:#c9d1d9">${s.displayName || s.name}</strong> <span style="color:#484f58;font-size:.75rem">${ops.length} operations</span>` +
            ops.map(o => {
              const parts = o.name.split(' ');
              const method = parts[0] || 'GET';
              const path = parts.slice(1).join(' ') || o.name;
              const mc = method.toLowerCase();
              return `<div style="margin:.2rem 0 .2rem 1rem;font-size:.82rem"><span class="badge ${mc}" style="font-size:.65rem;padding:1px 4px">${method}</span> <code style="color:#79c0ff">${host}/rest/${s.name}/${s.version}${path}</code></div>`;
            }).join('') + '</div>';
        }).join('')}
      </div>
      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem">
        <h3 style="color:#c9d1d9;font-size:.9rem;margin-bottom:.5rem">Event / Async Endpoints</h3>
        ${eventSvcs.map(s => `<div style="margin-bottom:.3rem"><strong style="color:#c9d1d9">${s.displayName || s.name}</strong> <span style="color:#484f58;font-size:.75rem">${(s.operations||[]).map(o=>o.name).join(', ')}</span></div>`).join('')}
      </div>
    </div>

    <div id="setup-view" class="rest-section">
      <h2 style="color:var(--fg2);margin-bottom:.5rem">AI-Driven Mock Setup <span class="badge" style="background:color-mix(in srgb, var(--green) 15%, transparent);color:var(--green2)">Auto</span></h2>
      <p style="color:var(--fg3);font-size:.85rem;margin-bottom:1.5rem">Upload or drop a schema file — AI generates all mock data and deploys it to Microcks instantly.</p>

      <!-- Drag-and-drop zone -->
      <div id="setup-dropzone" style="background:var(--bg2);border:2px dashed var(--border2);border-radius:8px;padding:2rem;margin-bottom:1rem;text-align:center;cursor:pointer;transition:all .2s"
        ondragover="event.preventDefault();this.style.borderColor='var(--green2)';this.style.background='color-mix(in srgb, var(--green) 5%, transparent)'"
        ondragleave="this.style.borderColor='var(--border2)';this.style.background='var(--bg2)'"
        ondrop="handleFileDrop(event)"
        onclick="document.getElementById('setup-file-input').click()">
        <div style="font-size:2rem;margin-bottom:.5rem;opacity:.5">📂</div>
        <div style="color:var(--fg2);font-size:.85rem;font-weight:600;margin-bottom:.25rem">Drop a schema file here or click to browse</div>
        <div style="color:var(--fg4);font-size:.75rem">.graphql, .gql, .json, .yaml, .yml, .txt</div>
        <div id="setup-file-name" style="display:none;color:var(--green2);font-size:.78rem;margin-top:.5rem;font-weight:600"></div>
        <input type="file" id="setup-file-input" accept=".graphql,.gql,.json,.yaml,.yml,.txt" style="display:none" onchange="handleFileSelect(this)">
      </div>

      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:1rem">
        <div style="flex:1;height:1px;background:var(--border2)"></div>
        <span style="color:var(--fg4);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em">or paste directly</span>
        <div style="flex:1;height:1px;background:var(--border2)"></div>
      </div>

      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:1rem;margin-bottom:1rem">
        <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem">
          <h3 style="color:var(--green2);font-size:.85rem">Schema</h3>
          <span style="color:var(--fg4);font-size:.72rem">Plain types, JSON, GraphQL SDL, or OpenAPI 3.x</span>
        </div>
        <textarea id="setup-schema" placeholder="Paste a schema here, or use the drop zone above&#10;&#10;1. Plain types:  name: string, age: int&#10;2. JSON types:   { &quot;name&quot;: &quot;string&quot; }&#10;3. GraphQL SDL:  type Query { ... }&#10;4. OpenAPI 3.x JSON/YAML" style="width:100%;height:180px;background:var(--code-bg);border:1px solid var(--border2);border-radius:6px;color:var(--fg2);font-family:monospace;font-size:.78rem;padding:.5rem;resize:vertical"></textarea>
      </div>

      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:1rem;margin-bottom:1rem">
        <div style="display:flex;gap:1rem;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <label style="color:var(--fg3);font-size:.78rem;display:block;margin-bottom:.35rem">Prompt / Instructions <span style="color:var(--fg4)">(optional)</span></label>
            <input id="setup-prompt" type="text" placeholder="e.g. Generate mock data for 10 games with realistic NFL scores and team names" style="width:100%;padding:.5rem;background:var(--code-bg);border:1px solid var(--border2);border-radius:6px;color:var(--fg2);font-size:.85rem">
          </div>
          <div>
            <label style="color:var(--fg3);font-size:.78rem;display:block;margin-bottom:.35rem">Service Name <span style="color:var(--fg4)">(optional)</span></label>
            <input id="setup-service-name" type="text" placeholder="e.g. SportsAPI" style="width:180px;padding:.5rem;background:var(--code-bg);border:1px solid var(--border2);border-radius:6px;color:var(--fg2);font-size:.85rem">
          </div>
          <button onclick="runSetup()" id="setup-deploy-btn" style="background:var(--green);color:#fff;border:none;padding:.55rem 1.5rem;border-radius:6px;cursor:pointer;font-size:.85rem;font-weight:600;white-space:nowrap">Generate &amp; Deploy</button>
        </div>
        <div style="margin-top:.75rem">
          <label style="color:var(--fg3);font-size:.78rem;display:block;margin-bottom:.35rem">Real API URL <span style="color:var(--fg4)">(optional — the mock server transparently replaces this API; unmocked requests forward here)</span></label>
          <input id="setup-proxy-url" type="text" placeholder="e.g. https://api.staging.example.com/graphql" style="width:100%;padding:.5rem;background:var(--code-bg);border:1px solid var(--border2);border-radius:6px;color:var(--fg2);font-size:.85rem">
        </div>
      </div>

      <div id="setup-progress" style="display:none;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:1rem;margin-bottom:1rem">
        <h4 style="color:var(--fg2);font-size:.85rem;margin-bottom:.5rem">Progress</h4>
        <div id="setup-steps" style="font-family:monospace;font-size:.78rem;color:var(--fg3)"></div>
      </div>

      <div id="setup-result" style="display:none;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:1rem">
        <h4 style="color:var(--green2);font-size:.85rem;margin-bottom:.5rem">✓ Mock API Deployed</h4>
        <div id="setup-result-content" style="font-size:.82rem;color:var(--fg2)"></div>
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

let currentWorkspace = getCookie('mock_workspace') || null;

function getHeaders(extra) {
  const h = { 'Content-Type': 'application/json', 'X-User': mockUser };
  if (currentWorkspace) h['X-Workspace'] = currentWorkspace;
  if (extra) Object.assign(h, extra);
  return h;
}

function getGraphqlPath(service) {
  if (currentWorkspace) return '/ws/' + currentWorkspace + '/graphql/' + service;
  return '/graphql/' + service;
}

function getRestPath(service, version, subPath) {
  var base = currentWorkspace ? '/ws/' + currentWorkspace + '/rest/' : '/rest/';
  return base + service + '/' + (version || '1.0') + (subPath || '');
}

function updateEndpointBar() {
  var bar = document.getElementById('ws-endpoint-bar');
  var urlEl = document.getElementById('ws-endpoint-url');
  if (!currentWorkspace || !currentService) {
    bar.style.display = 'none';
    return;
  }
  var endpoint = window.location.origin + getGraphqlPath(currentService);
  urlEl.textContent = endpoint;
  bar.style.display = 'flex';
}

function copyWsEndpoint() {
  var url = document.getElementById('ws-endpoint-url').textContent;
  navigator.clipboard.writeText(url).then(function() {
    var btn = event.target;
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('user-display').textContent = mockUser;
  if (currentWorkspace) {
    try {
      var r = await fetch('/workspaces/' + currentWorkspace, { headers: getHeaders() });
      if (!r.ok) throw new Error('gone');
      var wsData = await r.json();
      document.getElementById('ws-display').textContent = wsData.name || currentWorkspace;
      try { await fetch('/workspaces/' + currentWorkspace + '/activate', { method: 'POST', headers: getHeaders() }); } catch(_) {}
      await filterSidebarByWorkspace();
    } catch(_) {
      currentWorkspace = null;
      document.cookie = 'mock_workspace=; path=/; max-age=0';
      document.getElementById('ws-display').textContent = 'Default';
    }
  }
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
  window.__restCtx = null;

  var activeBtn = document.querySelector('.svc-btn[data-svc="'+name+'"]');
  activeBtn.classList.add('active');
  document.getElementById('explorer').classList.add('active');
  // Prefer the cleaned-up label rendered in the sidebar over the raw scoped
  // service name so the editor header reads "CensusAPI" not
  // "wmsports-ws-mc8x9y-CensusAPI".
  var svcLabel = activeBtn.querySelector('.svc-name');
  document.getElementById('editor-svc').textContent = svcLabel ? svcLabel.textContent : name;
  document.getElementById('editor-result').textContent = 'Select a query and click Run';
  document.getElementById('editor-result').className = '';
  document.getElementById('editor-timing').innerHTML = '';

  var typeBadge = document.getElementById('editor-type-badge');
  typeBadge.textContent = 'GraphQL';
  typeBadge.className = 'badge graphql';

  const panel = document.getElementById('ops-list');
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
  showOpsList();
  updateEndpointBar();

  document.getElementById('scenario-suggestions').innerHTML = '<div style="color:var(--fg4);font-size:.8rem;padding:1rem">Enter a custom scenario above or click "Suggest" for AI-generated scenarios</div>';
  _suggestedScenarios = [];
}

function showOpsList() {
  document.getElementById('ops-list').style.display = 'block';
  document.getElementById('ops-fields-view').style.display = 'none';
}

function showFieldsInOpsPanel() {
  document.getElementById('ops-list').style.display = 'none';
  var fv = document.getElementById('ops-fields-view');
  fv.style.display = 'flex';
  fv.style.flex = '1';
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
  srcLabel.style.color = 'var(--fg4)';
  srcLabel.textContent = '(from Microcks)';

  document.getElementById('clear-scenario-btn').style.display = 'none';

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

  loadFieldTree(currentService, name).then(function() {
    if (fieldTreeData && fieldTreeData.arguments) {
      queryArgsData[name] = fieldTreeData.arguments;
    }
    loadVariablesPanel(name);
  });

  document.getElementById('scenario-suggestions').innerHTML = '<div style="color:var(--fg4);font-size:.8rem;padding:1rem">Click "Suggest" to get AI-generated test scenarios specific to this operation</div>';
  _suggestedScenarios = [];
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
  const resolvedUrlPath = new URL(resolvedUrl.startsWith('http') ? resolvedUrl : window.location.origin + resolvedUrl).pathname;
  const resolvedDecoded = decodeURIComponent(resolvedUrlPath);
  const resolvedMatch = resolvedDecoded.match(/\\/rest\\/([^/]+)\\/([^/]+)\\/(.*)/);
  const resolvedOpPath = resolvedMatch ? '/' + resolvedMatch[3] : restOpPath;
  window.__restCtx = { method, url: resolvedUrl, serviceName: restServiceName, operationName: method + ' ' + restOpPath, resolvedOperationName: method + ' ' + resolvedOpPath, _templateUrl: fullUrl };

  document.getElementById('editor-svc').textContent = method + ' ' + urlPath;
  const typeBadge = document.getElementById('editor-type-badge');
  typeBadge.textContent = 'REST';
  typeBadge.className = 'badge rest';

  document.getElementById('clear-scenario-btn').style.display = 'none';
  var fsSb = document.getElementById('fields-sidebar');
  if (fsSb) fsSb.classList.remove('visible');

  const hasParams = /\\{[^}]+\\}/.test(templateUrl);
  let panelHtml = '<div style="padding:1rem;color:#8b949e;font-size:.82rem">';
  panelHtml += '<strong style="color:#c9d1d9">REST Endpoint</strong><br><br>';
  panelHtml += '<span class="badge ' + method.toLowerCase() + '" style="font-size:.7rem">' + method + '</span>';
  panelHtml += ' <span style="color:#58a6ff;font-size:.78rem">' + restServiceName + '</span><br><br>';
  if (hasParams) {
    panelHtml += '<strong style="color:var(--orange);font-size:.75rem">Path Parameters</strong><br>';
    const params = templateUrl.match(/\\{([^}]+)\\}/g) || [];
    params.forEach(p => {
      const name = p.replace(/[{}]/g, '');
      const val = REST_PARAM_DEFAULTS[name] || REST_PARAM_DEFAULTS[name.replace(/-/g,'_')] || 'example';
      panelHtml += '<span style="color:var(--accent)">{' + name + '}</span> = <span id="ops-param-' + name + '" style="color:var(--green2)">' + val + '</span><br>';
    });
    panelHtml += '<br>';
  }
  panelHtml += '<div style="margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--border)"><strong style="color:var(--purple2);font-size:.72rem">AI Agent</strong><br><span style="font-size:.72rem;color:var(--fg4)">Select a scenario above and click Apply Scenario to generate test data for this REST endpoint via AI.</span></div>';
  panelHtml += '</div>';
  document.getElementById('ops-list').innerHTML = panelHtml;
  document.getElementById('ops-list').style.display = 'block';
  document.getElementById('ops-fields-view').style.display = 'none';

  document.getElementById('editor-query').value = resolvedUrl;
  document.getElementById('editor-result').textContent = 'Click Run to send the request, or select an AI scenario and click Apply Scenario.';
  document.getElementById('editor-result').className = '';
  document.getElementById('editor-timing').innerHTML = '';

  const srcLabel = document.getElementById('response-source');
  srcLabel.style.color = 'var(--border2)';
  srcLabel.textContent = '(from Microcks)';

  document.getElementById('scenario-suggestions').innerHTML = '<div style="color:var(--fg4);font-size:.8rem;padding:1rem">Click "Suggest" to get AI-generated test scenarios specific to this REST endpoint</div>';
  _suggestedScenarios = [];

  loadRestVariablesPanel(templateUrl);
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
    const r = await fetch(getGraphqlPath(currentService), {
      method:'POST', headers: getHeaders(),
      body: JSON.stringify(body)
    });
    const ms = Math.round(performance.now() - start);
    const xSource = r.headers.get('X-Source') || '';
    const isAI = xSource === 'ai-override';
    const isScenario = xSource === 'ai-scenario' || xSource === 'ai-scenario-overlay';
    const isExample = xSource === 'microcks-example';
    const exampleName = r.headers.get('X-Example-Name') || '';
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
    const sourceHint = isExample ? '(example: ' + exampleName + ')' : isScenario ? '(scenario for ' + mockUser + ')' : isAI ? '(ai-override)' : '(via Microcks)';
    const sourceColor = isExample ? 'var(--blue)' : '#484f58';
    timingEl.innerHTML = '<span class="pg-status '+sc+'">'+logicalStatus+'</span> '+ms+'ms <span style="font-size:.7rem;color:' + sourceColor + '">' + sourceHint + '</span>';
    el.textContent = display;
    if (isExample) { srcLabel.textContent = '(example: ' + exampleName + ')'; srcLabel.style.color = 'var(--blue)'; }
    else { srcLabel.textContent = sourceHint; srcLabel.style.color = 'var(--fg4)'; }
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

// ── Bottom panel tab switching ──────────────────────────────────
function switchBottomTab(tab) {
  ['variables','scenarios'].forEach(t => {
    const el = document.getElementById('bottom-tab-' + t);
    if (el) el.style.display = t === tab ? 'flex' : 'none';
  });
  document.querySelectorAll('#bottom-tabs button').forEach((b, i) => {
    var tabs = ['variables','scenarios'];
    b.classList.toggle('active', tabs[i] === tab);
  });
}
function switchLeftTab(tab) {
  if (tab === 'query') return;
  switchBottomTab(tab);
}

// ── Sidebar toggle ──────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  sb.classList.toggle('collapsed');
  var btn = document.getElementById('sidebar-toggle');
  btn.textContent = sb.classList.contains('collapsed') ? '▸' : '◂';
}

// ── Sidebar section collapse ──────────────────────────────────
function toggleSection(h3) {
  const items = h3.nextElementSibling;
  const arrow = h3.querySelector('.section-arrow');
  if (items.classList.contains('collapsed')) {
    items.classList.remove('collapsed');
    if (arrow) { arrow.classList.remove('collapsed'); arrow.textContent = '▼'; }
  } else {
    items.classList.add('collapsed');
    if (arrow) { arrow.classList.add('collapsed'); arrow.textContent = '▶'; }
  }
}

// ── Theme toggle ──────────────────────────────────
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'light' ? '' : 'light';
  if (next) html.setAttribute('data-theme', 'light');
  else html.removeAttribute('data-theme');
  document.getElementById('theme-toggle-btn').textContent = next === 'light' ? 'Dark' : 'Light';
  try { localStorage.setItem('wm-theme', next || 'dark'); } catch(_) {}
}
(function initTheme() {
  try {
    const saved = localStorage.getItem('wm-theme');
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      var btn = document.getElementById('theme-toggle-btn');
      if (btn) btn.textContent = 'Dark';
    }
  } catch(_) {}
})();

// ── Apollo-style Field Tree ──────────────────────────────────
let fieldTreeData = null;
let fieldTreeSelection = {};

async function loadFieldTree(service, operation) {
  try {
    const r = await fetch('/schema/type-tree?operation=' + encodeURIComponent(operation) + '&service=' + encodeURIComponent(service));
    const data = await r.json();
    if (!data.tree || data.tree.length === 0) {
      document.getElementById('field-tree-root').innerHTML = '<div style="color:var(--fg4);padding:.5rem;font-size:.75rem">No schema type info available</div>';
      showFieldsInOpsPanel();
      return;
    }
    fieldTreeData = data;
    fieldTreeSelection = {};
    selectAllFields(data.tree, '');
    renderFieldTree(data.tree, document.getElementById('field-tree-root'), '');
    showFieldsInOpsPanel();
  } catch (e) {
    document.getElementById('field-tree-root').innerHTML = '<div style="color:var(--red2);padding:.5rem;font-size:.75rem">Error: ' + e.message + '</div>';
    showFieldsInOpsPanel();
  }
}

function selectAllFields(nodes, prefix) {
  for (const n of nodes) {
    const path = prefix ? prefix + '.' + n.name : n.name;
    fieldTreeSelection[path] = true;
    if (n.children) selectAllFields(n.children, path);
  }
}

function renderFieldTree(nodes, container, prefix) {
  container.innerHTML = '';
  for (const node of nodes) {
    const path = prefix ? prefix + '.' + node.name : node.name;
    const div = document.createElement('div');
    div.className = 'ft-node';

    const toggle = document.createElement('button');
    toggle.className = 'ft-toggle';

    const checked = fieldTreeSelection[path];
    const typeClass = node.isScalar ? 'scalar' : (node.isList ? 'list' : 'object');
    const typeLabel = node.isList ? '[' + node.type + ']' : node.type;

    let html = '';
    if (node.hasChildren && node.children) {
      html += '<span class="ft-arrow" data-path="' + path + '">&#9654;</span>';
    } else {
      html += '<span style="width:14px;display:inline-block"></span>';
    }
    html += '<span class="ft-check ' + (checked ? 'checked' : '') + '" data-path="' + path + '">' + (checked ? '&#10003;' : '') + '</span>';
    html += '<span class="ft-fname">' + node.name + '</span>';
    html += (node.required ? '<span style="color:#da3633;font-size:.7rem">!</span>' : '');
    html += '<span class="ft-type ' + typeClass + '">' + typeLabel + '</span>';
    toggle.innerHTML = html;

    toggle.addEventListener('click', function(e) {
      const target = e.target.closest('.ft-check');
      const arrow = e.target.closest('.ft-arrow');
      if (target) {
        toggleFieldSelection(path, node);
        renderFieldTree(nodes, container, prefix);
      } else if (arrow || (node.hasChildren && node.children)) {
        const childDiv = div.querySelector('.ft-children');
        if (childDiv) {
          const visible = childDiv.style.display !== 'none';
          childDiv.style.display = visible ? 'none' : 'block';
          const arrowEl = div.querySelector('.ft-arrow');
          if (arrowEl) arrowEl.classList.toggle('open', !visible);
        }
      }
    });

    div.appendChild(toggle);

    if (node.hasChildren && node.children && node.children.length > 0) {
      const childDiv = document.createElement('div');
      childDiv.className = 'ft-children';
      childDiv.style.display = 'block';
      renderFieldTree(node.children, childDiv, path);
      div.appendChild(childDiv);
      const arrowEl = toggle.querySelector('.ft-arrow');
      if (arrowEl) arrowEl.classList.add('open');
    }

    container.appendChild(div);
  }
}

function toggleFieldSelection(path, node) {
  const current = !!fieldTreeSelection[path];
  fieldTreeSelection[path] = !current;
  if (node && node.children) {
    setChildrenSelection(node.children, path, !current);
  }
}

function setChildrenSelection(nodes, prefix, selected) {
  for (const n of nodes) {
    const p = prefix + '.' + n.name;
    fieldTreeSelection[p] = selected;
    if (n.children) setChildrenSelection(n.children, p, selected);
  }
}

function fieldTreeSelectAll() {
  if (fieldTreeData) {
    selectAllFields(fieldTreeData.tree, '');
    renderFieldTree(fieldTreeData.tree, document.getElementById('field-tree-root'), '');
  }
}

function fieldTreeSelectNone() {
  fieldTreeSelection = {};
  if (fieldTreeData) {
    renderFieldTree(fieldTreeData.tree, document.getElementById('field-tree-root'), '');
  }
}

function buildQueryFromSelection(tree, prefix, depth) {
  const parts = [];
  for (const node of tree) {
    const path = prefix ? prefix + '.' + node.name : node.name;
    if (!fieldTreeSelection[path]) continue;
    if (node.isScalar || !node.children || node.children.length === 0) {
      parts.push(node.name);
    } else {
      const nested = buildQueryFromSelection(node.children, path, depth + 1);
      if (nested) {
        parts.push(node.name + ' { ' + nested + ' }');
      } else {
        parts.push(node.name + ' { __typename }');
      }
    }
  }
  return parts.join(' ');
}

function applyFieldSelection() {
  if (!fieldTreeData || !currentOpName) return;
  const fieldsStr = buildQueryFromSelection(fieldTreeData.tree, '', 0);
  if (!fieldsStr) return;

  const prefix = currentOpType === 'MUTATION' ? 'mutation ' : 'query ';
  let variableDefs = '';
  let argStr = '';
  if (window.__graphqlVariables && Object.keys(window.__graphqlVariables).length > 0) {
    const vRes = fieldTreeData.arguments || [];
    if (vRes.length > 0) {
      variableDefs = '(' + vRes.map(a => '$' + a.name + ': ' + a.typeStr).join(', ') + ')';
      argStr = '(' + vRes.map(a => a.name + ': $' + a.name).join(', ') + ')';
    }
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

  const opLine = prefix.trim() + ' ' + currentOpName + (variableDefs ? ' ' + variableDefs : '');
  const callPart = currentOpName + argStr;
  const formatted = fieldsStr.includes('{') ? formatFieldsStr(fieldsStr) : fieldsStr.split(/\\s+/).filter(f=>f).join('\\n    ');
  document.getElementById('editor-query').value = opLine + ' {\\n  ' + callPart + ' {\\n    ' + formatted + '\\n  }\\n}';
}

// ── Variables Panel ──────────────────────────────────
let currentVariablesDef = [];

function loadVariablesPanel(operation) {
  const panel = document.getElementById('variables-panel');
  if (!fieldTreeData || !fieldTreeData.arguments || fieldTreeData.arguments.length === 0) {
    const args = queryArgsData[operation];
    if (!args || args.length === 0) {
      panel.innerHTML = '<div style="color:var(--fg4);font-size:.8rem;padding:1rem">This operation has no arguments</div>';
      return;
    }
  }

  const args = (fieldTreeData && fieldTreeData.arguments) || queryArgsData[operation] || [];
  if (args.length === 0) {
    panel.innerHTML = '<div style="color:var(--fg4);font-size:.8rem;padding:1rem">This operation has no arguments</div>';
    return;
  }

  currentVariablesDef = args;
  const currentVars = window.__graphqlVariables || {};
  let html = '<div style="font-size:.68rem;color:var(--fg4);padding:0 0 .4rem;border-bottom:1px solid var(--border);margin-bottom:.4rem">Set variable values below. These are sent as query parameters when you click Run.</div>';
  for (const arg of args) {
    const val = currentVars[arg.name] !== undefined ? (typeof currentVars[arg.name] === 'object' ? JSON.stringify(currentVars[arg.name]) : currentVars[arg.name]) : '';
    html += '<div class="var-row">';
    html += '<label>$' + escHtml(arg.name) + '</label>';
    html += '<input id="var-input-' + arg.name + '" value="' + escHtml(String(val)) + '" placeholder="Enter value..." onchange="updateVariable(\\'' + arg.name + '\\', this.value)">';
    html += '<span class="var-type">' + escHtml(arg.typeStr || arg.type) + '</span>';
    html += '</div>';
  }
  panel.innerHTML = html;
}

function updateVariable(name, value) {
  if (!window.__graphqlVariables) window.__graphqlVariables = {};
  try {
    window.__graphqlVariables[name] = JSON.parse(value);
  } catch (_) {
    window.__graphqlVariables[name] = value;
  }
}

function loadRestVariablesPanel(templateUrl) {
  const panel = document.getElementById('variables-panel');
  const params = (templateUrl.match(/\{([^}]+)\}/g) || []).map(p => p.replace(/[{}]/g, ''));
  if (params.length === 0) {
    panel.innerHTML = '<div style="color:var(--fg4);font-size:.8rem;padding:1rem">This endpoint has no path parameters</div>';
    return;
  }

  window.__restPathParams = {};
  let html = '<div style="font-size:.68rem;color:var(--fg4);padding:0 0 .4rem;border-bottom:1px solid var(--border);margin-bottom:.4rem">Edit path parameter values below. Changes update the URL when you click Run.</div>';
  for (const name of params) {
    const val = REST_PARAM_DEFAULTS[name] || REST_PARAM_DEFAULTS[name.replace(/-/g,'_')] || 'example';
    window.__restPathParams[name] = val;
    html += '<div class="var-row">';
    html += '<label>{' + escHtml(name) + '}</label>';
    html += '<input id="rest-param-' + name + '" value="' + escHtml(val) + '" placeholder="Enter value..." onchange="updateRestParam(\\'' + escHtml(name) + '\\', this.value)">';
    html += '<span class="var-type">path</span>';
    html += '</div>';
  }
  html += '<div id="rest-available-examples" style="margin-top:.6rem;padding-top:.5rem;border-top:1px solid var(--border)"><div style="color:var(--fg4);font-size:.68rem">Loading available examples...</div></div>';
  panel.innerHTML = html;

  if (window.__restCtx) {
    fetchRestExamples(window.__restCtx.serviceName, window.__restCtx.operationName, params);
  }
}

async function fetchRestExamples(serviceName, operationName, paramNames) {
  const container = document.getElementById('rest-available-examples');
  if (!container) return;
  try {
    const r = await fetch('/api/microcks-examples?service=' + encodeURIComponent(serviceName) + '&operation=' + encodeURIComponent(operationName), { headers: getHeaders() });
    const data = await r.json();
    if (!data.examples || data.examples.length === 0) {
      container.innerHTML = '<div style="color:var(--fg4);font-size:.68rem">No examples found in Microcks</div>';
      return;
    }
    let html = '<div style="font-size:.68rem;color:var(--fg4);margin-bottom:.3rem;font-weight:600">Available Examples <span style="color:var(--fg5)">(' + data.examples.length + ')</span> — click to load:</div>';
    const seen = new Set();
    for (const ex of data.examples) {
      if (seen.has(ex.name)) continue;
      seen.add(ex.name);
      const dispCriteria = ex.dispatchCriteria || '';
      const paramVal = dispCriteria.startsWith('/') ? dispCriteria.slice(1) : (ex.name || 'default');
      html += '<button onclick="selectRestExample(\\'' + escHtml(paramVal) + '\\')" style="display:inline-block;margin:2px 3px;padding:2px 8px;background:var(--code-bg);border:1px solid var(--border2);border-radius:4px;color:var(--accent);font-family:SF Mono,Menlo,monospace;font-size:.72rem;cursor:pointer;transition:border-color .15s" onmouseover="this.style.borderColor=\\'var(--accent)\\'" onmouseout="this.style.borderColor=\\'var(--border2)\\'">' + escHtml(ex.name) + (dispCriteria ? ' <span style=\\"color:var(--fg4)\\">' + escHtml(dispCriteria) + '</span>' : '') + '</button>';
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="color:var(--fg4);font-size:.68rem">Could not load examples</div>';
  }
}

function selectRestExample(paramVal) {
  if (!window.__restCtx || !window.__restCtx._templateUrl) return;
  const params = (window.__restCtx._templateUrl.match(/\{([^}]+)\}/g) || []).map(p => p.replace(/[{}]/g, ''));
  if (params.length === 1) {
    const input = document.getElementById('rest-param-' + params[0]);
    if (input) input.value = paramVal;
    updateRestParam(params[0], paramVal);
  }
  setTimeout(runQuery, 100);
}

function updateRestParam(name, value) {
  if (!window.__restPathParams) window.__restPathParams = {};
  window.__restPathParams[name] = value;
  if (window.__restCtx && window.__restCtx._templateUrl) {
    let url = window.__restCtx._templateUrl;
    for (const [k, v] of Object.entries(window.__restPathParams)) {
      url = url.replace('{' + k + '}', encodeURIComponent(v || 'example'));
    }
    document.getElementById('editor-query').value = url;
    window.__restCtx.url = url;
    try {
      const rp = new URL(url.startsWith('http') ? url : window.location.origin + url).pathname;
      const rd = decodeURIComponent(rp);
      const rm = rd.match(/\\/rest\\/([^/]+)\\/([^/]+)\\/(.*)/);
      if (rm) window.__restCtx.resolvedOperationName = window.__restCtx.method + ' /' + rm[3];
    } catch(_) {}
  }
  var opsLabel = document.getElementById('ops-param-' + name);
  if (opsLabel) opsLabel.textContent = value || 'example';
}

const queryArgsData = {};

async function generateWithVariables() {
  if (!currentService || !currentOpName) return;
  const vars = {};
  for (const arg of currentVariablesDef) {
    const input = document.getElementById('var-input-' + arg.name);
    if (input && input.value) {
      try { vars[arg.name] = JSON.parse(input.value); } catch(_) { vars[arg.name] = input.value; }
    }
  }
  if (Object.keys(vars).length === 0) {
    document.getElementById('editor-result').textContent = 'Enter at least one variable value first';
    return;
  }

  const el = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  el.textContent = 'Generating mock for variables: ' + JSON.stringify(vars) + '...';
  timingEl.innerHTML = '<span class="pg-status ai">AI</span> generating...';

  const selectedFields = [];
  if (fieldTreeData) {
    for (const [path, checked] of Object.entries(fieldTreeSelection)) {
      if (checked && !path.includes('.')) selectedFields.push(path);
    }
  }

  try {
    const r = await fetch('/ai/generate-with-variables', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        service: currentService,
        operation: currentOpName,
        variables: vars,
        selectedFields: selectedFields.length > 0 ? selectedFields : undefined,
      })
    });
    const data = await r.json();
    if (data.error) {
      el.textContent = 'Error: ' + data.error;
      el.className = 'error';
      timingEl.innerHTML = '<span class="pg-status s4">ERR</span>';
      return;
    }
    el.textContent = JSON.stringify(data.data, null, 2);
    el.className = '';
    timingEl.innerHTML = '<span class="pg-status ai">AI</span> ' + (data.cached ? 'cached' : 'generated & injected') + ' for vars: ' + JSON.stringify(vars);

    try {
      await fetch('/ai/scenario-inject', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({
          service: currentService,
          operation: currentOpName,
          data: data.data,
          apiType: 'graphql',
          scenarioName: 'variable-mock',
          variables: vars,
        })
      });
    } catch(_) {}

    loadSavedVariableMocks();
  } catch(e) {
    el.textContent = 'Error: ' + e.message;
    el.className = 'error';
  }
}

async function loadSavedVariableMocks() {
  // Variable mocks are now injected directly into Microcks
}

async function loadVariableMock(key) {
  try {
    const allMocks = await fetch('/ai/variable-mocks?service=' + encodeURIComponent(currentService) + '&operation=' + encodeURIComponent(currentOpName), { headers: getHeaders() }).then(r => r.json());
    const mock = allMocks.mocks[key];
    if (mock && mock.variables) {
      for (const [k, v] of Object.entries(mock.variables)) {
        const input = document.getElementById('var-input-' + k);
        if (input) input.value = typeof v === 'object' ? JSON.stringify(v) : v;
        updateVariable(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
    await generateWithVariables();
  } catch(_) {}
}

// ── AI Scenario Suggestions ──────────────────────────────────
let _suggestedScenarios = [];

async function loadAISuggestions() {
  const isRest = currentService === '__rest__' && window.__restCtx;
  const svcName = isRest ? window.__restCtx.serviceName : currentService;
  const opName = isRest ? window.__restCtx.operationName : currentOpName;
  if (!svcName || !opName) return;
  const el = document.getElementById('scenario-suggestions');
  const btn = document.getElementById('suggest-btn');
  btn.disabled = true;
  btn.textContent = 'Thinking...';
  el.innerHTML = '<div style="color:var(--accent);padding:1rem;font-size:.8rem">AI is analyzing the schema and generating tailored test scenarios...</div>';

  try {
    const r = await fetch('/ai/suggest-scenarios', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ service: svcName, operation: opName, apiType: isRest ? 'rest' : 'graphql' })
    });
    const data = await r.json();
    if (data.error) { el.innerHTML = '<div style="color:var(--red2);padding:1rem">' + data.error + '</div>'; return; }

    _suggestedScenarios = data.scenarios || [];
    if (_suggestedScenarios.length === 0) { el.innerHTML = '<div style="color:var(--fg4);padding:1rem">No scenarios generated</div>'; return; }

    el.innerHTML = _suggestedScenarios.map(function(s, idx) {
      var catClass = (s.category || 'edge-case').replace(/[^a-z-]/g, '');
      var sevClass = (s.severity || 'medium').toLowerCase();
      return '<div class="suggest-card" data-idx="' + idx + '" onclick="applySuggestion(' + idx + ', this)">'
        + '<div style="display:flex;align-items:center;gap:.4rem">'
        + '<span class="sc-cat ' + catClass + '">' + escHtml(s.category || '') + '</span>'
        + '<span class="sc-sev ' + sevClass + '">' + escHtml(s.severity || '') + '</span>'
        + '<span class="sc-name" style="flex:1">' + escHtml(s.name) + '</span>'
        + '<span class="apply-btn" style="font-size:.6rem;padding:2px 8px">APPLY</span>'
        + '</div>'
        + '<div class="sc-desc">' + escHtml(s.description || '') + '</div>'
        + '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="color:var(--red2);padding:1rem">Error: ' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Suggest';
  }
}

async function applyCustomScenario() {
  const promptInput = document.getElementById('custom-scenario-prompt');
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  const _isRestCtx = currentService === '__rest__' && window.__restCtx;
  if (!_isRestCtx && (!currentService || !currentOpName)) return;

  var result = document.getElementById('editor-result');
  var timingEl = document.getElementById('editor-timing');
  var srcLabel = document.getElementById('response-source');

  result.textContent = 'Applying custom scenario...';
  result.className = '';
  timingEl.innerHTML = '<span class="pg-status ai">AI</span> generating & injecting...';
  srcLabel.textContent = '(applying...)';
  srcLabel.style.color = 'var(--purple2)';

  try {
    var isRest = currentService === '__rest__' && window.__restCtx;
    var payload = {
      service: isRest ? window.__restCtx.serviceName : currentService,
      operation: isRest ? window.__restCtx.operationName : currentOpName,
      prompt: prompt,
      apiType: isRest ? 'rest' : 'graphql',
    };
    if (isRest && window.__restCtx.resolvedOperationName) {
      payload.resolvedOperation = window.__restCtx.resolvedOperationName;
    }
    var fields = extractFieldsFromQuery(document.getElementById('editor-query').value);
    if (fields.length > 0) payload.fields = fields;

    var r = await fetch('/ai/scenario', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    var d = await r.json();

    if (d.error) {
      result.textContent = 'AI Error: ' + d.error;
      result.className = 'error';
      timingEl.innerHTML = '<span class="pg-status s4">ERR</span>';
      return;
    }

    srcLabel.textContent = '(scenario: custom)';
    srcLabel.style.color = 'var(--purple2)';
    document.getElementById('clear-scenario-btn').style.display = '';

    try {
      var injectBody = {
        service: payload.service,
        operation: isRest ? window.__restCtx.operationName : currentOpName,
        data: d.preview,
        apiType: payload.apiType,
        scenarioName: 'custom',
      };
      if (isRest && window.__restCtx.resolvedOperationName) {
        injectBody.resolvedOperation = window.__restCtx.resolvedOperationName;
      }
      if (window.__graphqlVariables && Object.keys(window.__graphqlVariables).length > 0) {
        injectBody.variables = window.__graphqlVariables;
      }
      await fetch('/ai/scenario-inject', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify(injectBody)
      });
    } catch(_) {}

    await runQuery();
    promptInput.value = '';
  } catch(e) {
    result.textContent = 'Error: ' + e.message;
    result.className = 'error';
  }
}

async function applySuggestion(idx, cardEl) {
  var s = _suggestedScenarios[idx];
  if (!s) return;

  if (s.variables && typeof s.variables === 'object') {
    for (var _k of Object.keys(s.variables)) {
      var _v = s.variables[_k];
      var input = document.getElementById('var-input-' + _k);
      if (input) {
        input.value = typeof _v === 'object' ? JSON.stringify(_v) : _v;
        updateVariable(_k, typeof _v === 'object' ? JSON.stringify(_v) : String(_v));
      }
    }
  }

  var result = document.getElementById('editor-result');
  var timingEl = document.getElementById('editor-timing');
  var srcLabel = document.getElementById('response-source');

  result.textContent = 'Applying scenario "' + s.name + '" and injecting into Microcks...';
  result.className = '';
  timingEl.innerHTML = '<span class="pg-status ai">AI</span> generating & injecting...';
  srcLabel.textContent = '(applying...)';
  srcLabel.style.color = 'var(--purple2)';

  document.querySelectorAll('.suggest-card').forEach(function(c) { c.classList.remove('active-scenario'); });
  if (cardEl) cardEl.classList.add('active-scenario');

  try {
    var isRest = currentService === '__rest__' && window.__restCtx;
    var payload = {
      service: isRest ? window.__restCtx.serviceName : currentService,
      operation: isRest ? window.__restCtx.operationName : currentOpName,
      prompt: s.prompt || '',
      apiType: isRest ? 'rest' : 'graphql',
    };
    if (isRest && window.__restCtx.resolvedOperationName) {
      payload.resolvedOperation = window.__restCtx.resolvedOperationName;
    }
    var fields = extractFieldsFromQuery(document.getElementById('editor-query').value);
    if (fields.length > 0) payload.fields = fields;

    var r = await fetch('/ai/scenario', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify(payload)
    });
    var d = await r.json();

    if (d.error) {
      result.textContent = 'AI Error: ' + d.error;
      result.className = 'error';
      timingEl.innerHTML = '<span class="pg-status s4">ERR</span>';
      srcLabel.textContent = '(scenario failed)';
      if (cardEl) cardEl.classList.remove('active-scenario');
      return;
    }

    srcLabel.textContent = '(scenario: ' + escHtml(s.name) + ')';
    srcLabel.style.color = 'var(--purple2)';
    document.getElementById('clear-scenario-btn').style.display = '';

    try {
      var sugInjectBody = {
        service: payload.service,
        operation: isRest ? window.__restCtx.operationName : currentOpName,
        data: d.preview,
        apiType: payload.apiType,
        scenarioName: s.name,
      };
      if (isRest && window.__restCtx.resolvedOperationName) {
        sugInjectBody.resolvedOperation = window.__restCtx.resolvedOperationName;
      }
      if (window.__graphqlVariables && Object.keys(window.__graphqlVariables).length > 0) {
        sugInjectBody.variables = window.__graphqlVariables;
      }
      await fetch('/ai/scenario-inject', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify(sugInjectBody)
      });
    } catch(_) {}

    await runQuery();
  } catch(e) {
    result.textContent = 'Error: ' + e.message;
    result.className = 'error';
    if (cardEl) cardEl.classList.remove('active-scenario');
  }
}

// ── Workspace Management ──────────────────────────────────

function toggleWorkspaceMenu() {
  const existing = document.getElementById('ws-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'ws-menu';
  menu.style.cssText = 'position:fixed;top:48px;left:0;right:0;bottom:0;z-index:999';
  menu.onclick = function(e) { if (e.target === menu) menu.remove(); };

  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;top:0;left:50%;transform:translateX(-50%);background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;width:360px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.4)';

  box.innerHTML = '<h4 style="color:#c9d1d9;margin-bottom:.6rem;font-size:.85rem">Workspaces</h4>'
    + '<p style="color:#8b949e;font-size:.72rem;margin-bottom:.8rem">Isolate scenarios, overrides, and variable mocks into separate workspaces</p>'
    + '<div style="display:flex;gap:.4rem;margin-bottom:.8rem">'
    + '<input id="ws-new-name" placeholder="New workspace name..." style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;padding:4px 8px;font-size:.8rem">'
    + '<button onclick="createWorkspace()" style="background:#238636;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.78rem;font-weight:600">Create</button>'
    + '</div>'
    + '<div id="ws-list" style="max-height:250px;overflow-y:auto"></div>'
    + '<div style="border-top:1px solid #21262d;margin-top:.6rem;padding-top:.6rem">'
    + '<button onclick="switchWorkspace(null)" style="background:' + (!currentWorkspace ? '#1f6feb22' : 'none') + ';color:' + (!currentWorkspace ? '#58a6ff' : '#8b949e') + ';border:1px solid ' + (!currentWorkspace ? '#1f6feb44' : '#30363d') + ';padding:4px 12px;border-radius:4px;cursor:pointer;font-size:.78rem;width:100%">Default (no workspace)</button>'
    + '</div>';

  menu.appendChild(box);
  document.body.appendChild(menu);
  loadWorkspaceList();
}

async function loadWorkspaceList() {
  try {
    const r = await fetch('/workspaces', { headers: getHeaders() });
    const data = await r.json();
    const listEl = document.getElementById('ws-list');
    if (!data.workspaces || data.workspaces.length === 0) {
      listEl.innerHTML = '<div style="color:#484f58;font-size:.78rem;text-align:center;padding:.5rem">No workspaces yet</div>';
      return;
    }
    listEl.innerHTML = data.workspaces.map(function(w) {
      var isActive = currentWorkspace === w.id;
      var isolatedBadge = w.isolated ? '<span style="font-size:.6rem;padding:1px 5px;border-radius:6px;background:#1f6feb22;color:#58a6ff;margin-left:.3rem">isolated</span>' : '<span style="font-size:.6rem;padding:1px 5px;border-radius:6px;background:#21262d;color:#8b949e;margin-left:.3rem">shared</span>';
      var wsEndpoint = window.location.origin + '/ws/' + w.id + '/graphql/{service}';
      var q = String.fromCharCode(39);
      var card = '<div style="padding:.5rem;border-radius:4px;' + (isActive ? 'background:#1f6feb22;border:1px solid #1f6feb44' : 'border:1px solid #21262d') + ';margin-bottom:.3rem">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">'
        + '<div style="font-size:.82rem;color:' + (isActive ? '#58a6ff' : '#c9d1d9') + ';font-weight:600">' + escHtml(w.name) + isolatedBadge + '</div>'
        + '<div style="display:flex;gap:4px;flex-shrink:0">'
        + '<button onclick="toggleWorkspaceIsolation(' + q + w.id + q + ', ' + !w.isolated + ')" title="' + (w.isolated ? 'Switch to shared' : 'Switch to isolated') + '" style="background:#21262d;color:' + (w.isolated ? '#58a6ff' : '#8b949e') + ';border:1px solid #30363d;padding:2px 6px;border-radius:3px;font-size:.62rem;cursor:pointer">' + (w.isolated ? '🔒' : '🔓') + '</button>'
        + '<button onclick="switchWorkspace(' + q + w.id + q + ')" style="background:' + (isActive ? '#238636' : '#21262d') + ';color:' + (isActive ? '#fff' : '#c9d1d9') + ';border:1px solid ' + (isActive ? '#238636' : '#30363d') + ';padding:2px 10px;border-radius:3px;font-size:.68rem;cursor:pointer;font-weight:600">' + (isActive ? 'Active' : 'Use') + '</button>'
        + '<button onclick="deleteWorkspace(' + q + w.id + q + ')" style="background:#da363322;color:#f85149;border:1px solid #da363344;padding:2px 6px;border-radius:3px;font-size:.68rem;cursor:pointer">✕</button>'
        + '</div></div>'
        + '<div style="font-size:.58rem;color:#484f58;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + wsEndpoint + '">' + wsEndpoint + '</div>'
        + '</div>';
      return card;
    }).join('');
  } catch(_) {}
}

async function createWorkspace() {
  const nameInput = document.getElementById('ws-new-name');
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    const r = await fetch('/workspaces', {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ name })
    });
    const data = await r.json();
    nameInput.value = '';
    switchWorkspace(data.id);
    loadWorkspaceList();
  } catch(_) {}
}

async function switchWorkspace(wsId) {
  var menu = document.getElementById('ws-menu');
  if (menu) menu.remove();

  try {
    var oldWs = currentWorkspace;
    if (oldWs && oldWs !== wsId) {
      try { await fetch('/workspaces/' + oldWs + '/deactivate', { method: 'POST', headers: getHeaders() }); } catch(_) {}
    }
    currentWorkspace = wsId;
    if (wsId) {
      setCookie('mock_workspace', wsId);
    } else {
      document.cookie = 'mock_workspace=; path=/; max-age=0';
    }
    if (wsId) {
      try { await fetch('/workspaces/' + wsId + '/activate', { method: 'POST', headers: getHeaders() }); } catch(_) {}
    }
    window.location.reload();
  } catch(e) {
    console.error('switchWorkspace error:', e);
  }
}

async function filterSidebarByWorkspace() {
  var allBtns = document.querySelectorAll('.svc-btn[data-svc]');
  var sections = ['section-graphql','section-rest','section-event'];

  function showAll() {
    allBtns.forEach(function(b) { b.style.display = ''; b.style.opacity = ''; b.title = ''; });
    sections.forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = ''; });
    document.querySelectorAll('.rest-svc[data-svc]').forEach(function(el) { el.style.display = ''; });
  }

  function applyFilter(visibleNames) {
    var nameSet = {};
    visibleNames.forEach(function(n) { nameSet[n] = true; });
    allBtns.forEach(function(b) {
      var svcName = b.getAttribute('data-svc');
      b.style.display = nameSet[svcName] ? '' : 'none';
      b.style.opacity = nameSet[svcName] ? '1' : '';
    });
    sections.forEach(function(id) {
      var sec = document.getElementById(id);
      if (!sec) return;
      var anyVisible = false;
      sec.querySelectorAll('.svc-btn[data-svc]').forEach(function(b) { if (b.style.display !== 'none') anyVisible = true; });
      sec.style.display = anyVisible ? '' : 'none';
    });
    document.querySelectorAll('.rest-svc[data-svc]').forEach(function(el) {
      el.style.display = nameSet[el.getAttribute('data-svc')] ? '' : 'none';
    });
  }

  try {
    var wsParam = currentWorkspace ? 'workspace=' + encodeURIComponent(currentWorkspace) : '';
    var r = await fetch('/api/services-for-workspace?' + wsParam, { headers: getHeaders() });
    if (r.ok) {
      var data = await r.json();
      applyFilter(data.services || []);
      return;
    }
  } catch(_) {}

  showAll();
}

function addServiceToSidebar(serviceName, schemaType, mockRoutes, displayName) {
  var isGraphql = schemaType !== 'openapi';
  var sectionId = isGraphql ? 'section-graphql' : 'section-rest';
  var section = document.getElementById(sectionId);
  if (!section) return;

  var existing = section.querySelector('.svc-btn[data-svc="' + serviceName + '"]');
  if (existing) return;

  section.style.display = '';
  var q = String.fromCharCode(39);
  var label = displayName || serviceName;

  if (isGraphql) {
    var queries = (mockRoutes || []).filter(function(r) { return r.method === 'QUERY'; });
    var mutations = (mockRoutes || []).filter(function(r) { return r.method === 'MUTATION'; });
    SVC_DATA[serviceName] = {
      version: '1.0',
      queries: queries.map(function(r) { return { name: r.operation, output: r.returnType || '' }; }),
      mutations: mutations.map(function(r) { return { name: r.operation, output: r.returnType || '' }; }),
    };
    var qc = queries.length;
    var mc = mutations.length;
    var cntLabel = qc + 'Q' + (mc ? '/' + mc + 'M' : '');
    var btn = document.createElement('button');
    btn.className = 'svc-btn';
    btn.setAttribute('data-svc', serviceName);
    btn.setAttribute('data-type', 'graphql');
    btn.onclick = function() { selectService(serviceName); };
    btn.innerHTML = '<span class="svc-name">' + label + '</span><span class="svc-actions"><span class="regen-icon" title="Re-generate mock data" onclick="event.stopPropagation();regenService(' + q + serviceName + q + ',' + q + 'graphql' + q + ')">↻</span><span class="cnt">' + cntLabel + '</span></span>';
    section.querySelector('.section-items').appendChild(btn);
  } else {
    var opCount = (mockRoutes || []).length;
    var btn = document.createElement('button');
    btn.className = 'svc-btn';
    btn.setAttribute('data-svc', serviceName);
    btn.setAttribute('data-type', 'rest');
    btn.onclick = function() { showRest(); };
    btn.innerHTML = '<span class="svc-name">' + label + '</span><span class="svc-actions"><span class="regen-icon" title="Re-generate mock data" onclick="event.stopPropagation();regenService(' + q + serviceName + q + ',' + q + 'rest' + q + ')">↻</span><span class="cnt">' + opCount + '</span></span>';
    section.querySelector('.section-items').appendChild(btn);

    var restView = document.getElementById('rest-view');
    if (restView && mockRoutes && mockRoutes.length > 0) {
      var existing = restView.querySelector('.rest-svc[data-svc="' + serviceName + '"]');
      if (!existing) {
        var svcDiv = document.createElement('div');
        svcDiv.className = 'rest-svc';
        svcDiv.setAttribute('data-svc', serviceName);
        var opsHtml = mockRoutes.map(function(r) {
          var m = (r.method || 'GET').toUpperCase();
          var fullUrl = window.location.origin + (r.url || '/rest/' + serviceName + '/1.0' + (r.path || ''));
          return '<div class="rest-ep"><span class="method ' + m.toLowerCase() + '">' + m + '</span><code>' + fullUrl + '</code><button onclick="tryRest(' + q + m + q + ',' + q + fullUrl + q + ')">Try</button></div>';
        }).join('');
        svcDiv.innerHTML = '<h3>' + serviceName + ' <span class="badge rest">REST</span> <span class="ops-count">' + opCount + '</span></h3>' + opsHtml;
        restView.appendChild(svcDiv);
      }
    }
  }
}

async function getWorkspaceName(wsId) {
  try {
    const r = await fetch('/workspaces/' + wsId, { headers: getHeaders() });
    const data = await r.json();
    return data.name || wsId;
  } catch(_) { return wsId; }
}

async function snapshotWorkspace(wsId) {
  try {
    await fetch('/workspaces/' + wsId + '/snapshot', { method: 'POST', headers: getHeaders() });
    loadWorkspaceList();
  } catch(_) {}
}

async function deleteWorkspace(wsId) {
  var existing = document.getElementById('ws-delete-dialog');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'ws-delete-dialog';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center';

  var box = document.createElement('div');
  box.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.5rem;width:400px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,.5)';
  box.innerHTML = '<h4 style="color:#f85149;margin-bottom:.6rem;font-size:.9rem">Delete Workspace</h4>'
    + '<p style="color:#c9d1d9;font-size:.82rem;margin-bottom:1rem;line-height:1.5">What should happen to the services created in this workspace?</p>'
    + '<div style="display:flex;flex-direction:column;gap:.5rem">'
    + '<button id="ws-del-move" style="background:#1f6feb;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:.8rem;font-weight:600;text-align:left">Move services to Default workspace<br><span style="font-weight:400;font-size:.72rem;opacity:.8">Services stay in Microcks and become globally visible</span></button>'
    + '<button id="ws-del-purge" style="background:#da3633;color:#fff;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:.8rem;font-weight:600;text-align:left">Delete services permanently<br><span style="font-weight:400;font-size:.72rem;opacity:.8">Removes services from Microcks entirely</span></button>'
    + '<button id="ws-del-cancel" style="background:none;color:#8b949e;border:1px solid #30363d;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.8rem;margin-top:.2rem">Cancel</button>'
    + '</div>';

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.getElementById('ws-del-cancel').onclick = function() { overlay.remove(); };

  document.getElementById('ws-del-move').onclick = async function() {
    overlay.remove();
    try {
      await fetch('/workspaces/' + wsId + '?deleteServices=false', { method: 'DELETE', headers: getHeaders() });
      if (currentWorkspace === wsId) { currentWorkspace = null; document.cookie = 'mock_workspace=; path=/; max-age=0'; }
      window.location.reload();
    } catch(_) {}
  };

  document.getElementById('ws-del-purge').onclick = async function() {
    overlay.remove();
    try {
      await fetch('/workspaces/' + wsId + '?deleteServices=true', { method: 'DELETE', headers: getHeaders() });
      if (currentWorkspace === wsId) { currentWorkspace = null; document.cookie = 'mock_workspace=; path=/; max-age=0'; }
      window.location.reload();
    } catch(_) {}
  };
}

async function toggleWorkspaceIsolation(wsId, isolated) {
  try {
    await fetch('/workspaces/' + wsId, {
      method: 'PUT', headers: getHeaders(),
      body: JSON.stringify({ isolated: isolated })
    });
    loadWorkspaceList();
  } catch(_) {}
}

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
  // No-op: scenarios are now applied directly from the AI Scenarios tab
}

async function inlineAIClear() {
  const isRest = currentService === '__rest__' && window.__restCtx;
  if (!isRest && (!currentOpName || !currentService)) return;

  document.getElementById('clear-scenario-btn').style.display = 'none';
  document.querySelectorAll('.suggest-card').forEach(function(c) { c.classList.remove('active-scenario'); });

  const serviceName = isRest ? window.__restCtx.serviceName : currentService;
  const opName = isRest ? window.__restCtx.operationName : currentOpName;
  if (!serviceName || !opName) return;

  const result = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  const srcLabel = document.getElementById('response-source');

  result.textContent = 'Clearing scenario for ' + opName + '...';
  timingEl.innerHTML = '<span class="pg-status s206">...</span> clearing';

  try {
    var clearOps = [opName];
    if (isRest && window.__restCtx.resolvedOperationName && window.__restCtx.resolvedOperationName !== opName) {
      clearOps.push(window.__restCtx.resolvedOperationName);
    }
    for (var _clearOp of clearOps) {
      await fetch('/ai/scenario/clear', {
        method: 'POST', headers: getHeaders(),
        body: JSON.stringify({ service: serviceName, operation: _clearOp, apiType: isRest ? 'rest' : 'graphql' })
      });
    }

    srcLabel.textContent = '(from Microcks)';
    srcLabel.style.color = 'var(--fg4)';

    result.textContent = 'Scenario cleared for ' + opName + '. Click Run to get the original response.';
    timingEl.innerHTML = '';
  } catch(e) {
    result.textContent = 'Clear error: ' + e.message;
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
  const proxyUrl = document.getElementById('setup-proxy-url').value.trim();

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
  stepsDiv.innerHTML = '<div style="color:var(--accent)">⏳ Starting AI setup...</div>';

  try {
    const body = {};
    if (schema) body.schema = schema;
    if (prompt) body.prompt = prompt;
    if (serviceName) body.serviceName = serviceName;
    if (proxyUrl) body.proxyUrl = proxyUrl;

    const r = await fetch('/ai/setup', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(body),
    });
    const data = await r.json();

    if (!r.ok) {
      stepsDiv.innerHTML = '<div style="color:var(--red2)">✗ ' + (data.error || 'Setup failed') + '</div>';
      if (data.steps) {
        data.steps.forEach(s => {
          var stepText = (typeof s === 'string') ? s : (s.step || String(s));
          var status = (typeof s === 'object' && s.status) ? s.status : 'done';
          stepsDiv.innerHTML += '<div style="color:' + (status === 'done' ? 'var(--green2)' : status === 'warning' ? 'var(--yellow)' : 'var(--red2)') + '">' + (status === 'done' ? '✓' : status === 'warning' ? '⚠' : '✗') + ' ' + stepText + '</div>';
        });
      }
      return;
    }

    stepsDiv.innerHTML = '';
    (data.steps || []).forEach(s => {
      var stepText = (typeof s === 'string') ? s : (s.step || String(s));
      var status = (typeof s === 'object' && s.status) ? s.status : 'done';
      var icon = status === 'done' ? '✓' : status === 'warning' ? '⚠' : '○';
      var color = status === 'done' ? 'var(--green2)' : status === 'warning' ? 'var(--yellow)' : 'var(--fg3)';
      stepsDiv.innerHTML += '<div style="color:' + color + '">' + icon + ' ' + stepText + '</div>';
    });

    if (proxyUrl && data.serviceName) {
      try {
        await fetch('/api/proxy-url', {
          method: 'POST', headers: getHeaders(),
          body: JSON.stringify({ service: data.serviceName, url: proxyUrl })
        });
      } catch(_) {}
      try {
        await fetch('/api/upstream-url', {
          method: 'POST', headers: getHeaders(),
          body: JSON.stringify({ url: proxyUrl })
        });
      } catch(_) {}
    }

    resultDiv.style.display = 'block';
    const isRest = data.schemaType === 'openapi';
    let html = '<div style="margin-bottom:.75rem"><strong>Service:</strong> ' + data.serviceName + ' &nbsp;|&nbsp; <strong>Operations:</strong> ' + data.operationCount + ' &nbsp;|&nbsp; <strong>Type:</strong> ' + (isRest ? 'REST (OpenAPI)' : 'GraphQL') + '</div>';
    if (isRest) {
      html += '<div style="margin-bottom:.75rem"><strong>REST Base:</strong> <code style="background:var(--border);padding:2px 6px;border-radius:4px;color:var(--accent)">' + window.location.origin + data.restEndpoint + '</code></div>';
    } else {
      html += '<div style="margin-bottom:.75rem"><strong>GraphQL Endpoint:</strong> <code style="background:var(--border);padding:2px 6px;border-radius:4px;color:var(--accent)">POST ' + window.location.origin + data.graphqlEndpoint + '</code></div>';
    }
    html += '<div style="margin-bottom:.5rem"><strong>Mock Routes:</strong></div>';
    html += '<div style="background:var(--code-bg);border:1px solid var(--border2);border-radius:6px;padding:.5rem;max-height:200px;overflow:auto">';
    (data.mockRoutes || []).forEach(route => {
      const statusDot = route.exampleGenerated ? '<span style="color:var(--green2)">●</span>' : '<span style="color:var(--yellow)">●</span>';
      if (isRest) {
        html += '<div style="font-family:monospace;font-size:.78rem;padding:2px 0;color:var(--fg2)">' + statusDot + ' ' + route.method + ' ' + route.path + '</div>';
      } else {
        html += '<div style="font-family:monospace;font-size:.78rem;padding:2px 0;color:var(--fg2)">' + statusDot + ' ' + route.method + ' ' + route.operation + ' → ' + (route.returnType || '') + (route.isList ? '[]' : '') + '</div>';
      }
    });
    html += '</div>';
    const filesArr = [data.schemaFile || data.openapiFile, data.examplesFile].filter(Boolean);
    html += '<div style="margin-top:.75rem;font-size:.78rem;color:var(--fg3)">Files: ' + filesArr.map(f => '<code>' + f + '</code>').join(', ') + '</div>';
    resultContent.innerHTML = html;

    addServiceToSidebar(data.serviceName, data.schemaType || 'graphql', data.mockRoutes || [], data.displayName || data.serviceName);
    if (currentWorkspace) {
      await filterSidebarByWorkspace();
    }
  } catch (err) {
    stepsDiv.innerHTML = '<div style="color:var(--red2)">✗ Network error: ' + err.message + '</div>';
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
  dz.style.borderColor = 'var(--border2)';
  dz.style.background = 'var(--bg2)';
  const file = e.dataTransfer.files[0];
  if (file) readSchemaFile(file);
}

function handleFileSelect(input) {
  const file = input.files[0];
  if (file) readSchemaFile(file);
}

// Derive a clean service name from the schema's own metadata first, then
// fall back to a sanitized filename. The filename heuristic strips file
// extensions AND known suffix words (-schema, -openapi, -asyncapi, -examples,
// -postman) so files like "sports-search-api-schema.graphql" suggest
// "SportsSearchAPI" instead of "SportsSearchApiSchema".
function deriveServiceNameFromSchema(content, filename) {
  // NOTE: this whole script lives inside a server-side template literal, so
  // every backslash that needs to reach the browser must be doubled here.
  // 1. GraphQL: prefer the explicit microcksId directive at the top of the SDL.
  if (content) {
    var idMatch = content.match(/^#\\s*microcksId:\\s*([^:\\n\\r]+?)\\s*:/m);
    if (idMatch && idMatch[1]) return idMatch[1].trim();

    // 2. OpenAPI JSON/YAML: try to pull info.title.
    var titleMatch = content.match(/"title"\\s*:\\s*"([^"]+)"/);
    if (titleMatch && titleMatch[1]) return titleMatch[1].trim();
    var yamlTitleMatch = content.match(/^\\s*title:\\s*['"]?([^'"\\n\\r]+?)['"]?\\s*$/m);
    if (yamlTitleMatch && yamlTitleMatch[1]) return yamlTitleMatch[1].trim();
  }

  // 3. Filename fallback: strip extension + known suffixes, then PascalCase.
  if (!filename) return '';
  var stem = filename.replace(/\\.(graphql|gql|json|yaml|yml|txt)$/i, '');
  stem = stem.replace(/[-_](schema|openapi|asyncapi|examples|postman)$/i, '');
  // If stripping leaves nothing meaningful (e.g. plain "schema.graphql"),
  // bail out so the user fills it in themselves.
  if (!stem || /^(schema|openapi|asyncapi|examples|postman)$/i.test(stem)) return '';
  return stem
    .replace(/[-_]+/g, ' ')
    .replace(/\\b\\w/g, function(c) { return c.toUpperCase(); })
    .replace(/\\s+/g, '');
}

function readSchemaFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const content = e.target.result;
    document.getElementById('setup-schema').value = content;
    const fnLabel = document.getElementById('setup-file-name');
    fnLabel.textContent = '✓ ' + file.name + ' (' + (content.length / 1024).toFixed(1) + ' KB)';
    fnLabel.style.display = 'block';

    const nameInput = document.getElementById('setup-service-name');
    if (!nameInput.value.trim()) {
      const derived = deriveServiceNameFromSchema(content, file.name);
      if (derived) nameInput.value = derived;
    }

    // DO NOT auto-trigger generation - wait for user to provide prompt
    // User must click "Generate & Deploy" button
    document.getElementById('editor-result').innerHTML = '<div style="color:var(--accent)">✓ Schema loaded. Now enter a prompt and click Generate & Deploy</div>';
  };
  reader.readAsText(file);
}

// ── Re-generate service mock data ──────────────────────

function deleteService(serviceName) {
  var overlay = document.createElement('div');
  overlay.className = 'regen-modal-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = '<div class="regen-modal">'
    + '<h3 style="color:#da3633;margin:0 0 .75rem;font-size:.95rem">Delete service</h3>'
    + '<p style="color:var(--fg3);font-size:.82rem;margin-bottom:1rem">Permanently remove <strong style="color:var(--fg2)">' + serviceName + '</strong> from Microcks? This cannot be undone.</p>'
    + '<div id="del-status" style="display:none;margin-bottom:.75rem;font-family:monospace;font-size:.78rem"></div>'
    + '<div style="display:flex;gap:.5rem;justify-content:flex-end">'
    + '<button onclick="this.closest(\\'.regen-modal-overlay\\').remove()" style="background:var(--bg3);color:var(--fg2);border:1px solid var(--border2);padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.82rem">Cancel</button>'
    + '<button id="del-go-btn" onclick="doDeleteService(\\'' + serviceName.replace(/'/g, "\\\\'") + '\\')" style="background:#da3633;color:#fff;border:none;padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.82rem;font-weight:600">Delete</button>'
    + '</div></div>';
  document.body.appendChild(overlay);
}

async function doDeleteService(serviceName) {
  var btn = document.getElementById('del-go-btn');
  var statusEl = document.getElementById('del-status');
  btn.disabled = true;
  btn.textContent = 'Deleting...';
  btn.style.opacity = '0.6';
  statusEl.style.display = 'block';
  statusEl.innerHTML = '<div style="color:var(--accent)">Deleting ' + serviceName + '...</div>';
  try {
    var r = await fetch('/api/services/' + encodeURIComponent(serviceName), { method: 'DELETE', headers: getHeaders() });
    var data = await r.json();
    if (r.status === 403) {
      statusEl.innerHTML = '<div style="color:#da3633">⛔ ' + (data.error || 'Namespace violation — cannot delete services outside your namespace') + '</div>';
      btn.textContent = 'Blocked';
      return;
    }
    if (!r.ok || !data.deleted) {
      statusEl.innerHTML = '<div style="color:#da3633">✗ ' + (data.error || data.reason || 'Delete failed') + '</div>';
      btn.textContent = 'Failed';
      return;
    }
    statusEl.innerHTML = '<div style="color:var(--green2)">✓ Deleted successfully</div>';
    btn.textContent = 'Done';
    setTimeout(function() { window.location.reload(); }, 800);
  } catch (err) {
    statusEl.innerHTML = '<div style="color:#da3633">✗ ' + err.message + '</div>';
    btn.textContent = 'Error';
  }
}

function regenService(serviceName, type) {
  const overlay = document.createElement('div');
  overlay.className = 'regen-modal-overlay';
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = '<div class="regen-modal">'
    + '<h3 style="color:var(--fg2);margin:0 0 .75rem;font-size:.95rem">Re-generate: ' + serviceName + '</h3>'
    + '<p style="color:var(--fg3);font-size:.78rem;margin-bottom:1rem">AI will regenerate all mock data for this service. Optionally provide a prompt to customize the data.</p>'
    + '<div style="margin-bottom:.75rem"><label style="color:var(--fg3);font-size:.78rem;display:block;margin-bottom:.25rem">Prompt (optional)</label>'
    + '<input id="regen-prompt" type="text" placeholder="e.g. Use NFL teams, realistic scores, 2025 season data" style="width:100%;padding:.5rem;background:var(--code-bg);border:1px solid var(--border2);border-radius:6px;color:var(--fg2);font-size:.85rem;box-sizing:border-box"></div>'
    + '<div id="regen-status" style="display:none;margin-bottom:.75rem;font-family:monospace;font-size:.78rem;color:var(--fg3)"></div>'
    + '<div style="display:flex;gap:.5rem;justify-content:flex-end">'
    + '<button onclick="this.closest(\\'.regen-modal-overlay\\').remove()" style="background:var(--bg3);color:var(--fg2);border:1px solid var(--border2);padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.82rem">Cancel</button>'
    + '<button id="regen-go-btn" onclick="doRegen(\\'' + serviceName + '\\',\\'' + type + '\\')" style="background:var(--green);color:#fff;border:none;padding:.4rem 1rem;border-radius:6px;cursor:pointer;font-size:.82rem;font-weight:600">Re-generate</button>'
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
  statusEl.innerHTML = '<div style="color:var(--accent)">⏳ Finding schema for ' + serviceName + '...</div>';

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

    statusEl.innerHTML += '<div style="color:var(--green2)">✓ Schema loaded (' + (schemaData.schema.length/1024).toFixed(1) + ' KB)</div>';
    statusEl.innerHTML += '<div style="color:var(--accent)">⏳ Running AI setup...</div>';

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
      const color = s.status === 'done' ? 'var(--green2)' : s.status === 'warning' ? 'var(--yellow)' : 'var(--fg3)';
      statusEl.innerHTML += '<div style="color:' + color + '">' + icon + ' ' + s.step + '</div>';
    });
    statusEl.innerHTML += '<div style="color:var(--green2);font-weight:600;margin-top:.5rem">✓ Done — ' + (data.operationCount || 0) + ' operations regenerated</div>';

    btn.textContent = 'Done!';
    btn.style.background = 'color-mix(in srgb, var(--green) 50%, transparent)';
    setTimeout(function() {
      const modal = document.querySelector('.regen-modal-overlay');
      if (modal) modal.remove();
    }, 2000);

    // Refresh page to pick up new data
    lastFetch = 0;
    Object.keys(schemaCache).forEach(function(k) { delete schemaCache[k]; });
  } catch (err) {
    statusEl.innerHTML += '<div style="color:var(--red2)">✗ ' + err.message + '</div>';
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
