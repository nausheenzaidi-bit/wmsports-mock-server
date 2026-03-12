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
const { parse: gqlParse, Kind } = require('graphql');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));

// ── Load real GraphQL schemas for field validation ──────────────────────

const fullTypeMap = {};

function loadSchemaFiles() {
  const artifactsDir = path.join(__dirname, 'artifacts');
  if (!fs.existsSync(artifactsDir)) return;

  const schemaFiles = fs.readdirSync(artifactsDir).filter(f => f.endsWith('.graphql'));
  for (const file of schemaFiles) {
    try {
      const content = fs.readFileSync(path.join(artifactsDir, file), 'utf-8');
      const doc = gqlParse(content);
      for (const def of doc.definitions) {
        if (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) {
          const typeName = def.name.value;
          if (!fullTypeMap[typeName]) {
            fullTypeMap[typeName] = { name: typeName, fields: [] };
          }
          for (const field of (def.fields || [])) {
            if (!fullTypeMap[typeName].fields.includes(field.name.value)) {
              fullTypeMap[typeName].fields.push(field.name.value);
            }
          }
        }
      }
    } catch (_) {}
  }
  console.log(`  Schema: ${Object.keys(fullTypeMap).length} types loaded from ${schemaFiles.length} files`);
}

loadSchemaFiles();

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

// ── GraphQL field-selection filter ───────────────────────────────────────

function extractSelectionSet(queryStr) {
  try {
    const doc = gqlParse(queryStr);
    const def = doc.definitions[0];
    if (!def || !def.selectionSet) return null;
    return buildSelectionMap(def.selectionSet);
  } catch (_) {
    return null;
  }
}

function buildSelectionMap(selectionSet) {
  if (!selectionSet || !selectionSet.selections) return null;
  const map = {};
  for (const sel of selectionSet.selections) {
    if (sel.kind !== 'Field') continue;
    const name = sel.name.value;
    map[name] = sel.selectionSet ? buildSelectionMap(sel.selectionSet) : true;
  }
  return Object.keys(map).length > 0 ? map : null;
}

function filterResponseBySelection(data, selectionMap) {
  if (!selectionMap || data === null || data === undefined) return data;
  if (Array.isArray(data)) {
    return data.map(item => filterResponseBySelection(item, selectionMap));
  }
  if (typeof data !== 'object') return data;

  const filtered = {};
  for (const key of Object.keys(selectionMap)) {
    const subSel = selectionMap[key];
    if (!(key in data)) {
      filtered[key] = subSel === true ? null : {};
    } else if (subSel === true) {
      filtered[key] = data[key];
    } else {
      filtered[key] = filterResponseBySelection(data[key], subSel);
    }
  }
  return filtered;
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

// ── Server-side schema introspection cache ──────────────────────────────

const serverSchemaCache = {};
const SCHEMA_CACHE_TTL = 120_000;

async function getServiceSchema(service) {
  const cached = serverSchemaCache[service];
  if (cached && Date.now() - cached.ts < SCHEMA_CACHE_TTL) return cached.schema;

  try {
    const introspectionQuery = '{ __schema { types { name kind fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } queryType { name } mutationType { name } } }';
    const resp = await fetchFromMicrocks(`/graphql/${service}/1.0`, { query: introspectionQuery });
    if (resp.status === 200) {
      const parsed = JSON.parse(resp.body);
      if (parsed.data && parsed.data.__schema) {
        const schema = parsed.data.__schema;
        serverSchemaCache[service] = { schema, ts: Date.now() };
        return schema;
      }
    }
  } catch (_) {}
  return null;
}

function resolveTypeName(typeObj) {
  if (!typeObj) return null;
  if (typeObj.name) return typeObj.name;
  if (typeObj.ofType) return resolveTypeName(typeObj.ofType);
  return null;
}

function validateFieldsAgainstSchema(schema, queryStr, fullSchemaTypes) {
  if (!schema) return [];
  try {
    const doc = gqlParse(queryStr);
    const def = doc.definitions[0];
    if (!def || !def.selectionSet) return [];
    const isMutation = def.operation === 'mutation';
    const rootName = isMutation ? (schema.mutationType || {}).name : (schema.queryType || {}).name;
    const rootType = schema.types.find(t => t.name === rootName);
    if (!rootType || !rootType.fields) return [];

    const errors = [];
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== 'Field') continue;
      const opField = rootType.fields.find(f => f.name === sel.name.value);
      if (!opField) continue;
      if (sel.selectionSet) {
        const retTypeName = resolveTypeName(opField.type);
        const retType = fullSchemaTypes ? fullSchemaTypes[retTypeName] : null;
        if (retType) {
          collectInvalidFields(fullSchemaTypes, retType, sel.selectionSet, sel.name.value, errors);
        }
      }
    }
    return errors;
  } catch (_) { return []; }
}

function collectInvalidFields(typeMap, parentType, selectionSet, path, errors) {
  if (!parentType || !parentType.fields || !selectionSet) return;
  for (const sel of selectionSet.selections) {
    if (sel.kind !== 'Field') continue;
    const fieldName = sel.name.value;
    if (!parentType.fields.includes(fieldName)) {
      errors.push({
        message: `Cannot query field "${fieldName}" on type "${parentType.name}".`,
        locations: sel.loc ? [{ line: sel.loc.startToken.line, column: sel.loc.startToken.column }] : [],
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
      });
    }
  }
}

// ── GraphQL proxy to Microcks (with field filtering) ────────────────────

function extractOperationName(queryStr) {
  try {
    const doc = gqlParse(queryStr);
    const def = doc.definitions[0];
    if (!def || !def.selectionSet) return null;
    const firstField = def.selectionSet.selections.find(s => s.kind === 'Field');
    return firstField ? firstField.name.value : null;
  } catch (_) { return null; }
}

app.post('/graphql/:service', async (req, res) => {
  const service = req.params.service;
  const microcksPath = `/graphql/${service}/1.0`;
  const queryStr = req.body?.query || '';

  if (queryStr.includes('__schema') || queryStr.includes('__type')) {
    return proxyToMicrocks(req, res, microcksPath);
  }

  // Check for AI override
  const isProbe = req.headers['x-probe'] === 'true';
  const opName = extractOperationName(queryStr);
  if (opName) {
    const overrideKey = `${service}:${opName}`;
    const override = responseOverrides[overrideKey];
    if (override && override.remaining > 0) {
      if (!isProbe) {
        override.remaining--;
        if (override.remaining <= 0) delete responseOverrides[overrideKey];
      }
      res.setHeader('X-Source', 'ai-override');
      res.setHeader('X-Override-Remaining', override.remaining);
      return res.json(override.data);
    }
  }

  // Validate fields against real schema
  const schema = await getServiceSchema(service);
  const hasFullSchema = Object.keys(fullTypeMap).length > 0;
  if (schema && hasFullSchema) {
    const validationErrors = validateFieldsAgainstSchema(schema, queryStr, fullTypeMap);
    if (validationErrors.length > 0) {
      return res.json({ errors: validationErrors });
    }
  }

  const selectionMap = extractSelectionSet(queryStr);

  try {
    let resp = await fetchFromMicrocks(microcksPath, req.body);

    if (resp.status === 500 && selectionMap) {
      const opName = extractOperationName(queryStr);
      if (opName) {
        const isM = queryStr.trimStart().startsWith('mutation');
        const bareQuery = (isM ? 'mutation' : '') + `{ ${opName} }`;
        resp = await fetchFromMicrocks(microcksPath, { query: bareQuery });
      }
    }

    if (resp.status !== 200 || !selectionMap) {
      res.status(resp.status);
      res.setHeader('Content-Type', resp.headers['content-type'] || 'application/json');
      return res.send(resp.body);
    }

    const parsed = JSON.parse(resp.body);
    if (parsed.data) {
      parsed.data = filterResponseBySelection(parsed.data, selectionMap);
    }
    res.json(parsed);
  } catch (err) {
    res.status(502).json({ error: 'Microcks proxy error', detail: err.message });
  }
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

  const { query, variables, operationName } = req.body;
  const selectionMap = (query && !query.includes('__schema')) ? extractSelectionSet(query) : null;

  for (const svc of graphqlSvcs) {
    try {
      const resp = await fetchFromMicrocks(`/graphql/${svc.name}/${svc.version}`, { query, variables, operationName });
      if (resp.status !== 200) continue;
      const parsed = JSON.parse(resp.body);
      if (parsed.errors && parsed.errors.length > 0) continue;
      if (parsed.data && selectionMap) {
        parsed.data = filterResponseBySelection(parsed.data, selectionMap);
      }
      return res.json(parsed);
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

// ── AI Agent — LLM-powered mock data generation ─────────────────────────

const AI_API_KEY = process.env.AI_API_KEY || process.env.GROQ_API_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';
const AI_MODEL = process.env.AI_MODEL || 'llama-3.3-70b-versatile';

const responseOverrides = {};

function getOperationReturnType(opName) {
  const artifactsDir = path.join(__dirname, 'artifacts');
  const files = fs.readdirSync(artifactsDir).filter(f => f.endsWith('.graphql'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(artifactsDir, file), 'utf-8');
      const doc = gqlParse(content);
      for (const def of doc.definitions) {
        if ((def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
            (def.name.value === 'Query' || def.name.value === 'Mutation')) {
          for (const field of (def.fields || [])) {
            if (field.name.value === opName) return extractReturnType(field.type);
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function extractReturnType(typeNode) {
  if (typeNode.kind === 'NamedType') return typeNode.name.value;
  if (typeNode.kind === 'ListType') return extractReturnType(typeNode.type);
  if (typeNode.kind === 'NonNullType') return extractReturnType(typeNode.type);
  return null;
}

function buildTypeSchema(typeName, depth = 0) {
  if (depth > 1 || !fullTypeMap[typeName]) return typeName;
  const t = fullTypeMap[typeName];
  return `type ${typeName} {\n${t.fields.map(f => '  ' + f).join('\n')}\n}`;
}

async function callLLM(systemPrompt, userPrompt) {
  if (!AI_API_KEY) {
    throw new Error('No AI_API_KEY set. Export GROQ_API_KEY or AI_API_KEY.');
  }
  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
  };
  return new Promise((resolve, reject) => {
    const url = new URL(`${AI_BASE_URL}/chat/completions`);
    const postData = JSON.stringify(payload);
    const opts = {
      hostname: url.hostname, port: url.port || 443, path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 30000,
    };
    const r = https.request(opts, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'LLM error'));
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) return reject(new Error('Empty LLM response'));
          resolve(JSON.parse(content));
        } catch (e) { reject(new Error('LLM parse error: ' + e.message)); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('LLM timeout')); });
    r.write(postData);
    r.end();
  });
}

const FAILURE_SCENARIOS = {
  'wrong-types': { name: 'Wrong Data Types', prompt: 'Generate data where field values have WRONG types: strings where numbers expected, numbers where strings expected, objects where arrays expected. Make it look like a provider API regression.' },
  'missing-fields': { name: 'Missing Required Fields', prompt: 'Generate data with several important fields completely missing (not null, but absent from the JSON). Simulate a provider removing fields in a breaking change.' },
  'null-values': { name: 'Unexpected Nulls', prompt: 'Generate data where fields that should have values are null. Simulate a database issue or incomplete data load.' },
  'empty-arrays': { name: 'Empty Collections', prompt: 'Generate data where all array/list fields are empty []. Simulate an upstream data source returning no items.' },
  'malformed-dates': { name: 'Malformed Dates', prompt: 'Generate data where date/time fields have wrong formats: Unix timestamps instead of ISO strings, "N/A", epoch 0, or invalid strings like "not-a-date".' },
  'deprecated-fields': { name: 'Deprecated Field Changes', prompt: 'Generate data where deprecated fields are removed and replaced with new unexpected field names. Simulate an API migration the consumer was not notified about.' },
  'extra-fields': { name: 'Extra Unknown Fields', prompt: 'Generate valid data but add many extra unexpected fields that the consumer schema does not define. Simulate a provider adding new fields.' },
  'encoding-issues': { name: 'Encoding/Special Chars', prompt: 'Generate data with special characters, unicode, HTML entities, and XSS payloads in string fields. Test consumer input sanitization.' },
  'boundary-values': { name: 'Boundary Values', prompt: 'Generate data with extreme values: very long strings (500+ chars), negative numbers, zero, MAX_INT, empty strings, single character strings.' },
  'partial-response': { name: 'Partial/Truncated', prompt: 'Generate data that looks like a truncated API response — some objects missing, arrays with only 1 item, strings cut off mid-sentence.' },
};

const AI_SYSTEM_PROMPT = `You are a mock data generator for a sports GraphQL/REST API.
RULES:
- Return ONLY valid JSON in format: {"data": {"operationName": {fields...}}}
- Use the schema fields provided as guidance
- Follow instructions precisely about data quality
- For "bad data": make it look realistic but subtly broken
- For arrays: include 2-3 items unless specified
- Use real sports content (NFL, NBA, MLB teams/players)`;

app.post('/ai/generate', async (req, res) => {
  const { type, operation, prompt, scenario } = req.body;
  if (!prompt && !scenario) return res.status(400).json({ error: 'Provide "prompt" or "scenario"' });

  let schemaCtx = '';
  let targetType = type;
  if (operation) {
    const ret = getOperationReturnType(operation);
    if (ret) { targetType = ret; schemaCtx += `Operation: ${operation} → ${ret}\n`; }
  }
  if (targetType && fullTypeMap[targetType]) schemaCtx += buildTypeSchema(targetType) + '\n';

  const scenarioDef = scenario ? FAILURE_SCENARIOS[scenario] : null;
  const opLabel = operation || targetType || 'result';
  const userMsg = (scenarioDef ? scenarioDef.prompt : prompt) +
    `\n\nSchema:\n${schemaCtx}\nReturn JSON as {"data": {"${opLabel}": {...}}}`;

  try {
    const result = await callLLM(AI_SYSTEM_PROMPT, userMsg);
    res.json({ generated: result, schema: targetType, scenario: scenarioDef?.name || 'custom' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/ai/override', async (req, res) => {
  const { service, operation, data, prompt, scenario, fields, count = 1 } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation"' });

  let overrideData = data;
  if (!overrideData && (prompt || scenario)) {
    const scenarioDef = scenario ? FAILURE_SCENARIOS[scenario] : null;
    const retType = getOperationReturnType(operation);
    let schemaCtx = retType ? buildTypeSchema(retType) : '';

    let fieldsConstraint = '';
    if (fields && fields.length > 0) {
      fieldsConstraint = `\n\nIMPORTANT: The response MUST contain ONLY these fields: ${fields.join(', ')}. Do NOT include any other fields. The object should have exactly these keys and nothing else.`;
    }

    const opMsg = (scenarioDef ? scenarioDef.prompt : prompt) +
      `\n\nSchema:\n${schemaCtx}${fieldsConstraint}\nReturn as {"data": {"${operation}": {${fields ? fields.map(f => `"${f}": ...`).join(', ') : '...'}}}}`;
    try {
      overrideData = await callLLM(AI_SYSTEM_PROMPT, opMsg);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  if (!overrideData) return res.status(400).json({ error: 'Provide "data", "prompt", or "scenario"' });

  const key = `${service}:${operation}`;
  responseOverrides[key] = { data: overrideData, remaining: count };
  res.json({ message: `Override active for ${key} (${count} request${count > 1 ? 's' : ''})`, key, remaining: count, preview: overrideData });
});

app.get('/ai/overrides', (req, res) => {
  const active = {};
  for (const [k, v] of Object.entries(responseOverrides)) { if (v.remaining > 0) active[k] = { remaining: v.remaining }; }
  res.json({ overrides: active });
});

app.delete('/ai/overrides', (req, res) => {
  Object.keys(responseOverrides).forEach(k => delete responseOverrides[k]);
  res.json({ message: 'All overrides cleared' });
});

app.get('/ai/scenarios', (req, res) => {
  res.json({ scenarios: Object.entries(FAILURE_SCENARIOS).map(([id, s]) => ({ id, name: s.name, description: s.prompt.split('.')[0] + '.' })) });
});

app.get('/ai/types', (req, res) => {
  const types = Object.entries(fullTypeMap)
    .filter(([n]) => !n.startsWith('__'))
    .map(([n, t]) => ({ name: n, fieldCount: t.fields.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ types });
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
    <div class="sidebar-section" style="border-top:1px solid #30363d;margin-top:auto">
      <button class="svc-btn" data-type="ai" onclick="showAI()" style="color:#a371f7;font-weight:600">
        ⚡ AI Agent
        <span class="cnt" style="background:#8957e522;color:#a371f7">LLM</span>
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
          <span class="badge graphql">GraphQL</span>
          <strong id="editor-svc"></strong>
          <span class="timing" id="editor-timing"></span>
          <div style="display:flex;gap:.4rem;align-items:center;margin-left:auto">
            <select id="inline-ai-scenario" style="background:#21262d;color:#a371f7;border:1px solid #8957e544;border-radius:4px;padding:3px 6px;font-size:.72rem;cursor:pointer;display:none">
              <option value="">AI Inject...</option>
              <option value="bad_data">Bad Data</option>
              <option value="missing_fields">Missing Fields</option>
              <option value="wrong_types">Wrong Types</option>
              <option value="deprecated_fields">Deprecated Fields</option>
              <option value="null_values">Null Values</option>
              <option value="empty_arrays">Empty Arrays</option>
              <option value="malformed_json">Malformed JSON</option>
              <option value="stale_data">Stale/Cached Data</option>
              <option value="type_coercion">Type Coercion Errors</option>
              <option value="extra_fields">Extra Unknown Fields</option>
            </select>
            <input id="inline-ai-prompt" placeholder="or describe..." style="background:#21262d;color:#c9d1d9;border:1px solid #8957e544;border-radius:4px;padding:3px 6px;font-size:.72rem;width:180px;display:none">
            <button id="inline-ai-btn" onclick="inlineAIInject()" style="background:#8957e5;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:.72rem;font-weight:600;display:none">Inject</button>
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

    <div id="ai-view" class="rest-section">
      <h2 style="color:#c9d1d9;margin-bottom:.5rem">AI Mock Data Agent <span class="badge" style="background:#a371f722;color:#a371f7">Groq LLM</span></h2>
      <p style="color:#8b949e;font-size:.85rem;margin-bottom:1.5rem">Generate realistic or broken mock data using natural language. Inject it into any operation on-demand.</p>

      <div style="display:flex;gap:1rem;flex-wrap:wrap">
        <div style="flex:1;min-width:400px">
          <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem">
            <h3 style="color:#c9d1d9;font-size:.95rem;margin-bottom:.8rem">Generate Data</h3>
            <div style="display:flex;gap:.5rem;margin-bottom:.5rem;flex-wrap:wrap">
              <select id="ai-service" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:5px 8px;font-size:.82rem">
                ${graphqlSvcs.map(s => '<option value="' + s.name + '">' + s.name + '</option>').join('')}
              </select>
              <input id="ai-operation" placeholder="Operation (e.g. getGamecastBySlug)" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:5px 8px;font-size:.82rem;flex:1;min-width:200px">
            </div>
            <textarea id="ai-prompt" rows="3" placeholder="Describe what data you want...&#10;e.g. 'Generate a failed NFL game with missing scores and wrong date format'" style="width:100%;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:inherit;font-size:.82rem;resize:vertical;margin-bottom:.5rem"></textarea>
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
              <button onclick="aiGenerate()" style="background:#238636;color:#fff;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:.82rem;font-weight:600">Generate</button>
              <button onclick="aiGenAndOverride()" style="background:#8957e5;color:#fff;border:none;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:.82rem;font-weight:600">Generate & Override</button>
              <span style="color:#484f58;font-size:.75rem">Override replaces next response for the operation</span>
            </div>
          </div>

          <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-top:1rem">
            <h3 style="color:#c9d1d9;font-size:.95rem;margin-bottom:.8rem">Failure Scenarios</h3>
            <div id="ai-scenarios" style="display:flex;flex-wrap:wrap;gap:.4rem"></div>
          </div>
        </div>

        <div style="flex:1;min-width:400px">
          <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;height:100%">
            <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">
              <h3 style="color:#c9d1d9;font-size:.95rem">Result</h3>
              <span id="ai-status" style="color:#484f58;font-size:.75rem"></span>
              <button onclick="aiCopyResult()" style="margin-left:auto;background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:.75rem">Copy</button>
            </div>
            <pre id="ai-result" style="background:#0d1117;border:1px solid #21262d;border-radius:4px;padding:.8rem;font-family:'SF Mono',Menlo,monospace;font-size:.8rem;color:#7ee787;max-height:500px;overflow:auto;white-space:pre-wrap">AI-generated data will appear here...</pre>
          </div>
        </div>
      </div>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem;margin-top:1rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">
          <h3 style="color:#c9d1d9;font-size:.95rem">Active Overrides</h3>
          <button onclick="aiClearOverrides()" style="margin-left:auto;background:#da363322;color:#f85149;border:1px solid #da363344;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:.75rem">Clear All</button>
        </div>
        <div id="ai-overrides" style="color:#8b949e;font-size:.85rem">None</div>
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
const SVC_DATA = ${svcDataJson};
let currentService = '';
let currentOpName = '';
let currentOpType = '';

function hideAll() {
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('explorer').classList.remove('active');
  document.getElementById('rest-view').classList.remove('active');
  document.getElementById('event-view').classList.remove('active');
  document.getElementById('ai-view').classList.remove('active');
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

  currentOpName = name;
  currentOpType = type;

  const editor = document.getElementById('editor-query');
  const result = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  const srcLabel = document.getElementById('response-source');
  result.textContent = 'Loading...';
  result.className = '';
  timingEl.innerHTML = '';
  srcLabel.style.color = '#30363d';
  srcLabel.textContent = '(from Microcks)';

  ['inline-ai-scenario','inline-ai-prompt','inline-ai-btn','inline-ai-clear'].forEach(id => {
    document.getElementById(id).style.display = '';
  });
  document.getElementById('inline-ai-scenario').value = '';
  document.getElementById('inline-ai-prompt').value = '';

  const schema = await fetchSchema(currentService);
  const prefix = type === 'MUTATION' ? 'mutation ' : '';

  let fieldsStr = null;
  if (schema) {
    const retType = getReturnTypeName(schema, name, type);
    fieldsStr = retType ? buildFieldsQuery(schema, retType) : null;
  }

  if (fieldsStr) {
    editor.value = prefix + '{\\n  ' + name + ' {\\n    ' + fieldsStr.split(' ').join('\\n    ') + '\\n  }\\n}';
  } else {
    editor.value = prefix + '{\\n  ' + name + '\\n}';
  }

  result.textContent = 'Click Run (Cmd+Enter) to execute, or select an AI scenario and click Inject.';
  timingEl.innerHTML = '';
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
  const cleanQuery = query.replace(/^#.*\\n/gm, '').trim();
  try {
    const r = await fetch('/graphql/' + currentService, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({query: cleanQuery})
    });
    const ms = Math.round(performance.now() - start);
    const isAI = r.headers.get('X-Source') === 'ai-override';
    const aiLeft = parseInt(r.headers.get('X-Override-Remaining') || '0', 10);
    const text = await r.text();
    let parsed = null;
    let display;
    try { parsed = JSON.parse(text); display = JSON.stringify(parsed,null,2); } catch(_) { display = text; }
    const srcLabel = document.getElementById('response-source');
    if (isAI) {
      timingEl.innerHTML = '<span class="pg-status ai">AI</span> '+ms+'ms <span style="color:#a371f7;font-size:.72rem">'+aiLeft+' override(s) left</span>';
      el.textContent = display;
      el.className = '';
      srcLabel.textContent = '(from AI Agent)';
      srcLabel.style.color = '#a371f7';
    } else {
      srcLabel.textContent = '(from Microcks)';
      srcLabel.style.color = '#30363d';
      const hasErrors = parsed && parsed.errors && parsed.errors.length > 0;
      const hasData = parsed && parsed.data && Object.keys(parsed.data).length > 0;
      let logicalStatus = r.status;
      if (r.status === 200 && hasErrors && !hasData) logicalStatus = 400;
      if (r.status === 200 && hasErrors && hasData) logicalStatus = 206;
      const sc = logicalStatus === 206 ? 's206' : (logicalStatus < 300 ? 's2' : (logicalStatus < 500 ? 's4' : 's5'));
      timingEl.innerHTML = '<span class="pg-status '+sc+'">'+logicalStatus+'</span> '+ms+'ms';
      el.textContent = display;
      if (hasErrors) el.className = 'error';
    }
  } catch(e) { el.textContent = 'Error: '+e.message; el.className = 'error'; }
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
  if (!currentOpName || !currentService) return;
  const scenario = document.getElementById('inline-ai-scenario').value;
  const prompt = document.getElementById('inline-ai-prompt').value;
  if (!scenario && !prompt) { document.getElementById('editor-result').textContent = 'Select a scenario or type a prompt, then click Inject'; return; }

  const result = document.getElementById('editor-result');
  const timingEl = document.getElementById('editor-timing');
  const srcLabel = document.getElementById('response-source');
  const editor = document.getElementById('editor-query');

  const fields = extractFieldsFromQuery(editor.value);

  result.textContent = 'AI generating bad data for: ' + (fields.length ? fields.join(', ') : 'all fields') + '...';
  result.className = '';
  timingEl.innerHTML = '<span class="pg-status ai">AI</span> generating...';
  srcLabel.textContent = '(generating...)';
  srcLabel.style.color = '#a371f7';

  try {
    const payload = { service: currentService, operation: currentOpName, count: 5 };
    if (scenario) payload.scenario = scenario;
    if (prompt) payload.prompt = prompt;
    if (fields.length > 0) payload.fields = fields;

    const r = await fetch('/ai/override', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    const d = await r.json();

    if (d.error) {
      result.textContent = 'AI Error: ' + d.error;
      result.className = 'error';
      timingEl.innerHTML = '<span class="pg-status s4">ERR</span>';
      srcLabel.textContent = '(AI error)';
      return;
    }

    const prefix = currentOpType === 'MUTATION' ? 'mutation ' : '';
    const fieldsBlock = fields.length > 0 ? ' {\\n    ' + fields.join('\\n    ') + '\\n  }' : '';
    editor.value = prefix + '{\\n  ' + currentOpName + fieldsBlock + '\\n}';

    await runQuery();
  } catch(e) {
    result.textContent = 'Error: ' + e.message;
    result.className = 'error';
  }
}

async function inlineAIClear() {
  if (!currentOpName || !currentService) return;
  const key = currentService + ':' + currentOpName;
  await fetch('/ai/overrides', { method: 'DELETE' });

  const srcLabel = document.getElementById('response-source');
  srcLabel.textContent = '(from Microcks)';
  srcLabel.style.color = '#30363d';

  document.getElementById('inline-ai-scenario').value = '';
  document.getElementById('inline-ai-prompt').value = '';

  selectOp(currentOpName, currentOpType);
}

function showAI() {
  hideAll();
  document.getElementById('ai-view').classList.add('active');
  document.querySelector('.svc-btn[data-type="ai"]').classList.add('active');
  loadAIScenarios();
  loadAIOverrides();
}

async function loadAIScenarios() {
  try {
    const r = await fetch('/ai/scenarios');
    const d = await r.json();
    const el = document.getElementById('ai-scenarios');
    el.innerHTML = d.scenarios.map(s =>
      '<button onclick="aiRunScenario(\\x27'+s.id+'\\x27)" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:.78rem" title="'+s.description+'">'+s.name+'</button>'
    ).join('');
  } catch(_) {}
}

async function loadAIOverrides() {
  try {
    const r = await fetch('/ai/overrides');
    const d = await r.json();
    const el = document.getElementById('ai-overrides');
    const entries = Object.entries(d.overrides);
    if (entries.length === 0) { el.textContent = 'None'; return; }
    el.innerHTML = entries.map(([k,v]) =>
      '<span style="background:#8957e522;color:#a371f7;padding:2px 8px;border-radius:4px;font-size:.82rem;margin-right:.5rem">'+k+' ('+v.remaining+' left)</span>'
    ).join('');
  } catch(_) { }
}

async function aiGenerate() {
  const operation = document.getElementById('ai-operation').value;
  const prompt = document.getElementById('ai-prompt').value;
  const statusEl = document.getElementById('ai-status');
  const resultEl = document.getElementById('ai-result');

  if (!prompt) { resultEl.textContent = 'Enter a prompt first'; resultEl.style.color = '#f85149'; return; }
  resultEl.style.color = '#7ee787';
  statusEl.textContent = 'Generating...';
  resultEl.textContent = 'Calling AI...';

  try {
    const r = await fetch('/ai/generate', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ operation: operation || undefined, prompt })
    });
    const d = await r.json();
    if (d.error) { resultEl.textContent = 'Error: ' + d.error; resultEl.style.color = '#f85149'; }
    else { resultEl.textContent = JSON.stringify(d.generated, null, 2); }
    statusEl.textContent = d.schema ? 'Type: ' + d.schema : '';
  } catch(e) { resultEl.textContent = 'Error: ' + e.message; resultEl.style.color = '#f85149'; }
}

async function aiGenAndOverride() {
  const service = document.getElementById('ai-service').value;
  const operation = document.getElementById('ai-operation').value;
  const prompt = document.getElementById('ai-prompt').value;
  const statusEl = document.getElementById('ai-status');
  const resultEl = document.getElementById('ai-result');

  if (!operation) { resultEl.textContent = 'Enter an operation name'; resultEl.style.color = '#f85149'; return; }
  if (!prompt) { resultEl.textContent = 'Enter a prompt'; resultEl.style.color = '#f85149'; return; }
  resultEl.style.color = '#7ee787';
  statusEl.textContent = 'Generating & setting override...';
  resultEl.textContent = 'Calling AI...';

  try {
    const r = await fetch('/ai/override', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ service, operation, prompt, count: 3 })
    });
    const d = await r.json();
    if (d.error) { resultEl.textContent = 'Error: ' + d.error; resultEl.style.color = '#f85149'; }
    else {
      resultEl.textContent = JSON.stringify(d.preview, null, 2);
      statusEl.textContent = 'Override set — next 3 requests to ' + d.key + ' will return this data';
    }
    loadAIOverrides();
  } catch(e) { resultEl.textContent = 'Error: ' + e.message; resultEl.style.color = '#f85149'; }
}

async function aiRunScenario(scenarioId) {
  const service = document.getElementById('ai-service').value;
  const operation = document.getElementById('ai-operation').value;
  const statusEl = document.getElementById('ai-status');
  const resultEl = document.getElementById('ai-result');

  resultEl.style.color = '#7ee787';

  if (!operation) {
    statusEl.textContent = 'Generating preview...';
    resultEl.textContent = 'Calling AI...';
    try {
      const r = await fetch('/ai/generate', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ operation: 'getGamecastBySlug', scenario: scenarioId })
      });
      const d = await r.json();
      if (d.error) { resultEl.textContent = 'Error: ' + d.error; resultEl.style.color = '#f85149'; }
      else { resultEl.textContent = JSON.stringify(d.generated, null, 2); statusEl.textContent = 'Scenario: ' + d.scenario; }
    } catch(e) { resultEl.textContent = 'Error: ' + e.message; resultEl.style.color = '#f85149'; }
    return;
  }

  statusEl.textContent = 'Injecting scenario...';
  resultEl.textContent = 'Calling AI...';
  try {
    const r = await fetch('/ai/override', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ service, operation, scenario: scenarioId, count: 3 })
    });
    const d = await r.json();
    if (d.error) { resultEl.textContent = 'Error: ' + d.error; resultEl.style.color = '#f85149'; }
    else {
      resultEl.textContent = JSON.stringify(d.preview, null, 2);
      statusEl.textContent = 'Scenario injected into ' + d.key + ' for next 3 requests';
    }
    loadAIOverrides();
  } catch(e) { resultEl.textContent = 'Error: ' + e.message; resultEl.style.color = '#f85149'; }
}

async function aiClearOverrides() {
  await fetch('/ai/overrides', { method: 'DELETE' });
  loadAIOverrides();
  document.getElementById('ai-status').textContent = 'All overrides cleared';
}

function aiCopyResult() {
  const text = document.getElementById('ai-result').textContent;
  navigator.clipboard.writeText(text);
  document.getElementById('ai-status').textContent = 'Copied!';
}
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
  console.log(`  Health:     GET /health`);
  console.log(`  AI Agent:   POST /ai/generate, /ai/override`);
  console.log(`  AI Key:     ${AI_API_KEY ? 'Configured (' + AI_MODEL + ')' : '⚠ Not set (export GROQ_API_KEY)'}\n`);

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
