const http = require('http');
const https = require('https');
const express = require('express');
const router = express.Router();
const { PORT, MICROCKS_URL } = require('../config.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');
const { authHeaders, isAuthEnabled } = require('../lib/microcks-auth.cjs');

async function httpGetStatus(url, timeoutMs = 4000) {
  const mod = url.startsWith('https') ? https : http;
  const headers = {};
  if (isAuthEnabled() && url.startsWith(MICROCKS_URL)) {
    Object.assign(headers, await authHeaders());
  }
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: timeoutMs, headers }, (r) => {
      r.resume();
      resolve({ url, status: r.statusCode });
    });
    req.on('error', (e) => resolve({ url, status: null, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ url, status: null, error: 'timeout' });
    });
  });
}

router.get('/health', async (req, res) => {
  const services = await fetchMicrocksServices();
  const graphql = services.filter(s => s.type === 'GRAPHQL' || s.type === 'GRAPH');
  const rest = services.filter(s => s.type === 'REST');
  const event = services.filter(s => s.type === 'EVENT' || s.type === 'ASYNC_API');
  const totalOps = services.reduce((sum, s) => sum + (s.operations?.length || 0), 0);

  const port = PORT || 4010;
  const shimUrl = `http://127.0.0.1:${port}/api/gamecast/test?appversion=500.0`;
  const microcksWrongUrl = `${MICROCKS_URL.replace(/\/$/, '')}/api/gamecast/test?appversion=500.0`;
  const [statmilkShimSelf, microcksRootApi] = await Promise.all([
    httpGetStatus(shimUrl),
    httpGetStatus(microcksWrongUrl),
  ]);

  res.json({
    status: 'ok',
    microcks: MICROCKS_URL,
    microcksReachable: services.length > 0,
    services: { total: services.length, graphql: graphql.length, rest: rest.length, event: event.length },
    totalOperations: totalOps,
    uptime: process.uptime(),
    statmilkRestForSportsStatsApi: {
      setEnvTo: `http://localhost:${port}`,
      reason: 'Apollo RESTDataSource uses new URL("/api/...", baseURL); a /rest/... base is dropped, so requests must hit this mock /api/* shim (not Microcks /api/*, which 404s).',
      selfShimProbe: statmilkShimSelf,
      microcksDirectApiPathProbe: { ...microcksRootApi, note: microcksRootApi.status === 404 ? 'Expected 404 — use mock dashboard port for Stat REST.' : null },
    },
  });
});

module.exports = router;
