const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { MICROCKS_URL } = require('../config.cjs');

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

function httpGetLong(targetUrl, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const mod = targetUrl.startsWith('https') ? https : http;
    mod.get(targetUrl, { timeout }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
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

function proxyToMicrocksAsText(req, res, targetPath) {
  const url = new URL(targetPath, MICROCKS_URL);
  const mod = url.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: url.host };
  delete headers['content-length'];
  delete headers['accept-encoding'];
  const options = {
    hostname: url.hostname, port: url.port,
    path: url.pathname + url.search,
    method: req.method, headers, timeout: 10000,
  };
  const proxyReq = mod.request(options, (proxyRes) => {
    const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
    let stream = proxyRes;
    if (encoding === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
    else if (encoding === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
    else if (encoding === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.status(proxyRes.statusCode);
      res.setHeader('content-type', 'text/plain');
      res.send(body);
    });
    stream.on('error', () => {
      res.status(502).json({ error: 'Decompression error' });
    });
  });
  proxyReq.on('error', (err) => {
    res.status(502).json({ error: 'Microcks proxy error', detail: err.message });
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.status(504).json({ error: 'Timeout' }); });
  proxyReq.end();
}

function fetchFromMicrocks(targetPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetPath, MICROCKS_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const opts = {
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 10000,
    };
    const r = mod.request(opts, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body: d, headers: resp.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.write(postData);
    r.end();
  });
}

module.exports = {
  httpGet,
  httpGetLong,
  proxyToMicrocks,
  proxyToMicrocksAsText,
  fetchFromMicrocks,
};
