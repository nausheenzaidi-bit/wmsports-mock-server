const express = require('express');
const router = express.Router();
const { scenarioStore, getUserScope, getWorkspaceId, dispatchExample } = require('../state.cjs');
const { proxyToMicrocks, proxyToMicrocksAsText } = require('../lib/http-helpers.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');

function checkRestScenario(req, service) {
  const userScope = getUserScope(req);
  const wsId = getWorkspaceId(req);
  const method = req.method;
  const subPath = '/' + (req.params[0] || '');
  const opKey = `${method} ${subPath}`;

  const scopes = [
    wsId ? `ws:${wsId}:${userScope}` : null,
    userScope,
    'global',
  ].filter(Boolean);

  for (const scope of scopes) {
    const exactKey = `${scope}:${service}:${opKey}`;
    if (scenarioStore[exactKey]) return scenarioStore[exactKey];
  }

  for (const scope of scopes) {
    const prefix = `${scope}:${service}:${method} `;
    for (const key of Object.keys(scenarioStore)) {
      if (!key.startsWith(prefix)) continue;
      const storedPath = key.slice(prefix.length);
      if (storedPath.includes('{') && pathMatchesTemplate(subPath, storedPath)) {
        return scenarioStore[key];
      }
    }
  }

  return null;
}

function pathMatchesTemplate(actualPath, templatePath) {
  const actualParts = actualPath.split('/');
  const templateParts = templatePath.split('/');
  if (actualParts.length !== templateParts.length) return false;
  return templateParts.every((tp, i) => tp.startsWith('{') || tp === actualParts[i]);
}

// NOTE: Template fallback is intentionally kept for ai-setup scenarios
// (which store keys with {param} templates). User-applied scenarios from
// the dashboard now store against the resolved path so each unique
// parameter value gets its own response.

function tryExampleDispatch(req, res, service) {
  const subPath = '/' + (req.params[0] || '');
  const dispatched = dispatchExample(service, req.method, subPath, req.query || {});
  if (!dispatched) return false;
  const { exampleName, response } = dispatched;
  const status = response.status || 200;
  if (response.headers) {
    for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
  }
  res.setHeader('X-Source', 'example-dispatcher');
  res.setHeader('X-Example-Name', exampleName);
  res.status(status);
  if (response.body === undefined || response.body === null) {
    res.end();
  } else {
    res.json(response.body);
  }
  return true;
}

function handleRestVersioned(req, res) {
  const service = req.params.service;
  const entry = checkRestScenario(req, service);
  if (entry && entry.data) {
    res.setHeader('X-Source', entry.source === 'ai-setup' ? 'ai-setup-workspace' : 'ai-scenario');
    return res.json(entry.data);
  }
  if (tryExampleDispatch(req, res, service)) return;
  const version = req.params.version;
  const subPath = req.params[0] || '';
  const search = req._parsedUrl.search || '';
  const restPath = `/rest/${service}/${version}/${subPath}${search}`;
  proxyToMicrocks(req, res, restPath);
}

function handleRestNoVersion(req, res) {
  const service = req.params.service;
  const entry = checkRestScenario(req, service);
  if (entry && entry.data) {
    res.setHeader('X-Source', entry.source === 'ai-setup' ? 'ai-setup-workspace' : 'ai-scenario');
    return res.json(entry.data);
  }
  if (tryExampleDispatch(req, res, service)) return;
  const subPath = req.params[0] || '';
  const search = req._parsedUrl.search || '';
  const restPath = `/rest/${service}/1.0/${subPath}${search}`;
  proxyToMicrocks(req, res, restPath);
}

router.all('/rest/:service/:version/*', handleRestVersioned);
router.all('/rest/:service/*', handleRestNoVersion);

router.all('/ws/:workspaceId/rest/:service/:version/*', (req, res) => {
  req.headers['x-workspace'] = req.params.workspaceId;
  handleRestVersioned(req, res);
});
router.all('/ws/:workspaceId/rest/:service/*', (req, res) => {
  req.headers['x-workspace'] = req.params.workspaceId;
  handleRestNoVersion(req, res);
});

router.all('/v3/*', (req, res) => {
  const search = req._parsedUrl.search || '';
  proxyToMicrocks(req, res, `/rest/Census+API/1.0/v3/${req.params[0]}${search}`);
});

let _resolvedStatMilkService = null;
let _statMilkResolveTime = 0;
async function resolveStatMilkService() {
  if (_resolvedStatMilkService && Date.now() - _statMilkResolveTime < 300000) {
    return _resolvedStatMilkService;
  }
  const services = await fetchMicrocksServices();
  const rest = services.filter(s => s.type === 'REST');
  const preferred = [
    'StatMilk REST API - Schema Only',
    'StatMilk REST API',
    'StatMilk',
    'StatMilkTest',
  ];
  for (const name of preferred) {
    if (rest.some(s => s.name === name)) {
      _resolvedStatMilkService = name;
      _statMilkResolveTime = Date.now();
      console.log(`[StatMilk proxy] Resolved to service: ${name}`);
      return name;
    }
  }
  const fuzzy = rest.find(s => /statmilk/i.test(s.name));
  if (fuzzy) {
    _resolvedStatMilkService = fuzzy.name;
    _statMilkResolveTime = Date.now();
    console.log(`[StatMilk proxy] Resolved (fuzzy) to service: ${fuzzy.name}`);
    return fuzzy.name;
  }
  _resolvedStatMilkService = 'StatMilk REST API - Schema Only';
  _statMilkResolveTime = Date.now();
  console.warn('[StatMilk proxy] No StatMilk REST service in Microcks; using default name (requests may 404).');
  return _resolvedStatMilkService;
}

router.all('/statmilk/*', async (req, res) => {
  const search = req._parsedUrl.search || '';
  const svcName = await resolveStatMilkService();
  const encodedSvcName = encodeURIComponent(svcName);
  proxyToMicrocks(req, res, `/rest/${encodedSvcName}/1.0/statmilk/${req.params[0]}${search}`);
});

router.all('/api/*', async (req, res) => {
  const search = req._parsedUrl.search || '';
  const subPath = req.params[0] || '';
  const statmilkPaths = ['gamecast/', 'scores/', 'standings/', 'schedules/', 'leagues', 'events/', 'games/'];
  if (statmilkPaths.some(p => subPath.startsWith(p))) {
    const svcName = await resolveStatMilkService();
    const encodedSvcName = encodeURIComponent(svcName);
    if (subPath.startsWith('scores/')) {
      return proxyToMicrocksAsText(req, res, `/rest/${encodedSvcName}/1.0/api/${subPath}${search}`);
    }
    return proxyToMicrocks(req, res, `/rest/${encodedSvcName}/1.0/api/${subPath}${search}`);
  }
  proxyToMicrocks(req, res, `/api/${subPath}${search}`);
});

module.exports = router;
