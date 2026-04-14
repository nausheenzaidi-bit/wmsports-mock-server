const express = require('express');
const router = express.Router();
const { scenarioStore, getUserScope } = require('../state.cjs');
const { proxyToMicrocks, proxyToMicrocksAsText } = require('../lib/http-helpers.cjs');
const { getMicrocksServiceId } = require('../lib/microcks-service.cjs');

function checkRestScenario(req, service) {
  const userScope = getUserScope(req);
  const method = req.method;
  const subPath = '/' + (req.params[0] || '');
  const opKey = `${method} ${subPath}`;
  const wsKey = `${userScope}:${service}:${opKey}`;
  const globalKey = `global:${service}:${opKey}`;
  return scenarioStore[wsKey] || scenarioStore[globalKey] || null;
}

router.all('/rest/:service/:version/*', (req, res) => {
  const service = req.params.service;
  const entry = checkRestScenario(req, service);
  if (entry) {
    res.setHeader('X-Source', 'ai-scenario');
    return res.json(entry.data);
  }
  const restPath = req.originalUrl;
  proxyToMicrocks(req, res, restPath);
});

router.all('/rest/:service/*', (req, res) => {
  const service = req.params.service;
  const entry = checkRestScenario(req, service);
  if (entry) {
    res.setHeader('X-Source', 'ai-scenario');
    return res.json(entry.data);
  }
  const subPath = req.params[0] || '';
  const search = req._parsedUrl.search || '';
  const restPath = `/rest/${service}/1.0/${subPath}${search}`;
  proxyToMicrocks(req, res, restPath);
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
  for (const candidate of ['StatMilkTest', 'StatMilk REST API', 'StatMilk']) {
    const id = await getMicrocksServiceId(candidate);
    if (id) {
      _resolvedStatMilkService = candidate;
      _statMilkResolveTime = Date.now();
      console.log(`[StatMilk proxy] Resolved to service: ${candidate}`);
      return candidate;
    }
  }
  return 'StatMilkTest';
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
