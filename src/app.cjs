const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const state = require('./state.cjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

app.use(require('./routes/health.cjs'));
app.use(require('./routes/workspace.cjs'));
app.use(require('./routes/schema-api.cjs'));
app.use(require('./routes/graphql.cjs'));
app.use(require('./routes/rest.cjs'));
app.use(require('./routes/ai-generate.cjs'));
app.use(require('./routes/ai-scenario.cjs'));
app.use(require('./routes/ai-setup.cjs'));
app.use(require('./routes/async-api.cjs'));
app.use(require('./routes/dashboard.cjs'));

app.all('*', (req, res) => {
  const upstream = state.upstreamUrl;
  if (!upstream) {
    return res.status(404).json({ error: 'No route matched and no upstream URL configured' });
  }

  try {
    const url = new URL(upstream);
    const mod = url.protocol === 'https:' ? https : http;
    const fwdHeaders = {};
    const skip = new Set(['host', 'connection', 'content-length', 'x-user', 'x-workspace']);
    for (const [k, v] of Object.entries(req.headers)) {
      if (!skip.has(k.toLowerCase())) fwdHeaders[k] = v;
    }
    const targetPath = url.pathname.replace(/\/$/, '') + req.originalUrl;
    let payload = '';
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      payload = JSON.stringify(req.body);
      fwdHeaders['content-type'] = 'application/json';
      fwdHeaders['content-length'] = Buffer.byteLength(payload);
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      payload = req.body;
      fwdHeaders['content-length'] = Buffer.byteLength(payload);
    }

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: req.method,
      headers: fwdHeaders,
      timeout: 30000,
    };

    const proxyReq = mod.request(opts, (proxyRes) => {
      res.setHeader('X-Mock-Source', 'upstream-proxy');
      for (const [hk, hv] of Object.entries(proxyRes.headers)) {
        if (!['transfer-encoding', 'connection'].includes(hk.toLowerCase())) {
          res.setHeader(hk, hv);
        }
      }
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.status(502).json({ error: 'Upstream proxy error', detail: err.message });
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      res.status(504).json({ error: 'Upstream proxy timeout' });
    });

    if (payload) proxyReq.write(payload);
    proxyReq.end();
  } catch (err) {
    res.status(502).json({ error: 'Upstream proxy error', detail: err.message });
  }
});

module.exports = app;
