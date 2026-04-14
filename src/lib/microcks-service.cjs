const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { MICROCKS_URL, CACHE_TTL } = require('../config.cjs');
const { httpGet, httpGetLong } = require('./http-helpers.cjs');

let microcksServices = [];
let lastFetch = 0;

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

function invalidateCache() {
  lastFetch = 0;
}

async function getMicrocksServiceId(serviceName) {
  invalidateCache();
  const services = await fetchMicrocksServices();
  const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const svc = services.find(s => s.name === serviceName)
    || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
    || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
  return svc ? svc.id : null;
}

function curlExec(args, timeoutMs = 20000) {
  const { execSync } = require('child_process');
  return execSync(`curl -s -w "\\n%{http_code}" ${args}`, { timeout: timeoutMs, encoding: 'utf-8' });
}

function parseCurlResult(result) {
  const lines = result.trim().split('\n');
  const statusCode = parseInt(lines[lines.length - 1], 10);
  const body = lines.slice(0, -1).join('\n');
  return { status: statusCode, body };
}

async function deleteServiceFromMicrocks(serviceId) {
  try {
    const result = curlExec(`-X DELETE "${MICROCKS_URL}/api/services/${serviceId}"`);
    const { status } = parseCurlResult(result);
    return status >= 200 && status < 300;
  } catch (_) { return false; }
}

function importArtifactToMicrocks(filePath, isMain = true) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes = { '.graphql': 'text/plain', '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml' };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    const mainParam = isMain ? 'true' : 'false';

    const fileContent = fs.readFileSync(filePath);
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const url = new URL(`${MICROCKS_URL}/api/artifact/upload?mainArtifact=${mainParam}`);
    const transport = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 60000,
    };

    const r = transport.request(opts, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        const code = resp.statusCode;
        if (code === 200 || code === 201) {
          resolve({ success: true, file: fileName, code });
        } else {
          reject(new Error(`Import failed for ${fileName}: HTTP ${code} — ${d.substring(0, 200)}`));
        }
      });
    });
    r.on('error', (err) => reject(new Error(`Import error for ${fileName}: ${err.message}`)));
    r.on('timeout', () => { r.destroy(); reject(new Error(`Import timeout for ${fileName}`)); });
    r.write(body);
    r.end();
  });
}

function clearServiceDispatchers(serviceName) {
  return new Promise(async (resolve) => {
    try {
      const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
      const services = JSON.parse(data);
      const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const svc = services.find(s => s.name === serviceName)
        || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
        || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
      if (!svc) { resolve({ cleared: 0 }); return; }

      let cleared = 0;
      for (const op of (svc.operations || [])) {
        if (op.dispatcher === 'QUERY_ARGS' || op.dispatcher === 'JSON_BODY' || op.dispatcher === 'FALLBACK') {
          try {
            await new Promise((res2, rej2) => {
              const opName = encodeURIComponent(op.name);
              const url = new URL(`${MICROCKS_URL}/api/services/${svc.id}/operation?operationName=${opName}`);
              const transport = url.protocol === 'https:' ? https : http;
              const body = JSON.stringify({ dispatcher: null, dispatcherRules: null });
              const opts = {
                hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search, method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                timeout: 15000,
              };
              const r = transport.request(opts, (resp) => {
                let d = ''; resp.on('data', c => d += c);
                resp.on('end', () => res2(resp.statusCode));
              });
              r.on('error', rej2);
              r.on('timeout', () => { r.destroy(); rej2(new Error('timeout')); });
              r.write(body); r.end();
            });
            cleared++;
          } catch (_) {}
        }
      }
      resolve({ cleared });
    } catch (err) {
      resolve({ cleared: 0, error: err.message });
    }
  });
}

function configureServiceDispatchers(serviceName, dispatcher, rules) {
  return new Promise(async (resolve) => {
    try {
      const data = await httpGetLong(`${MICROCKS_URL}/api/services?page=0&size=200`);
      const services = JSON.parse(data);
      const norm = serviceName.toLowerCase().replace(/[^a-z0-9]/g, '');
      const svc = services.find(s => s.name === serviceName)
        || services.find(s => s.name.toLowerCase() === serviceName.toLowerCase())
        || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
      if (!svc) { resolve({ configured: 0 }); return; }

      let configured = 0;
      for (const op of (svc.operations || [])) {
        try {
          await new Promise((res2, rej2) => {
            const opName = encodeURIComponent(op.name);
            const url = new URL(`${MICROCKS_URL}/api/services/${svc.id}/operation?operationName=${opName}`);
            const transport = url.protocol === 'https:' ? https : http;
            const body = JSON.stringify({ dispatcher, dispatcherRules: rules });
            const opts = {
              hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
              path: url.pathname + url.search, method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
              timeout: 15000,
            };
            const r = transport.request(opts, (resp) => {
              let d = ''; resp.on('data', c => d += c);
              resp.on('end', () => res2(resp.statusCode));
            });
            r.on('error', rej2);
            r.on('timeout', () => { r.destroy(); rej2(new Error('timeout')); });
            r.write(body); r.end();
          });
          configured++;
        } catch (_) {}
      }
      resolve({ configured });
    } catch (err) {
      resolve({ configured: 0, error: err.message });
    }
  });
}

module.exports = {
  fetchMicrocksServices,
  invalidateCache,
  getMicrocksServiceId,
  curlExec,
  parseCurlResult,
  deleteServiceFromMicrocks,
  importArtifactToMicrocks,
  clearServiceDispatchers,
  configureServiceDispatchers,
};
