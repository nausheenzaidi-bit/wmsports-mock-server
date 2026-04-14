const express = require('express');
const router = express.Router();
const { MICROCKS_URL, SCHEMA_CACHE_TTL } = require('../config.cjs');
const { responseOverrides, aiRemovedFields, scenarioStore, getUserScope } = require('../state.cjs');
const { httpGet, fetchFromMicrocks, proxyToMicrocks } = require('../lib/http-helpers.cjs');
const { extractSelectionSet, filterResponseBySelection, extractOperationName } = require('../lib/graphql-utils.cjs');
const { fullTypeMap } = require('../lib/schema-loader.cjs');
const { fetchMicrocksServices } = require('../lib/microcks-service.cjs');
const { resolveTypeName, validateFieldsAgainstSchema } = require('../lib/validation.cjs');

const serverSchemaCache = {};

async function getServiceSchema(service) {
  const cached = serverSchemaCache[service];
  if (cached && Date.now() - cached.ts < SCHEMA_CACHE_TTL) return cached.schema;

  try {
    let serviceVersion = '1.0';
    try {
      const data = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
      const services = JSON.parse(data);
      const svc = services.find(s => s.name.toLowerCase() === service.toLowerCase());
      if (svc) serviceVersion = svc.version;
    } catch (e) {}
    
    const introspectionQuery = '{ __schema { types { name kind fields { name type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } } queryType { name } mutationType { name } } }';
    const resp = await fetchFromMicrocks(`/graphql/${service}/${serviceVersion}`, { query: introspectionQuery });
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

router.post('/graphql/:service', async (req, res) => {
  const service = req.params.service;
  
  let serviceVersion = '1.0';
  try {
    const data = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(data);
    const svc = services.find(s => s.name.toLowerCase() === service.toLowerCase());
    if (svc) serviceVersion = svc.version;
  } catch (e) {}
  
  const microcksPath = `/graphql/${service}/${serviceVersion}`;
  const queryStr = req.body?.query || '';

  if (queryStr.includes('__schema') || queryStr.includes('__type')) {
    return proxyToMicrocks(req, res, microcksPath);
  }

  const isProbe = req.headers['x-probe'] === 'true';
  const opName = extractOperationName(queryStr);
  if (opName) {
    const userScope = getUserScope(req);
    const wsKey = `${userScope}:${service}:${opName}`;
    const globalKey = `global:${service}:${opName}`;
    const override = responseOverrides[wsKey] || responseOverrides[globalKey];
    const activeKey = responseOverrides[wsKey] ? wsKey : globalKey;
    if (override && override.remaining > 0) {
      if (!isProbe) {
        override.remaining--;
        if (override.remaining <= 0) delete responseOverrides[activeKey];
      }
      res.setHeader('X-Source', 'ai-override');
      res.setHeader('X-Override-Remaining', override.remaining);
      return res.json(override.data);
    }

    const scenarioWsKey = `${userScope}:${service}:${opName}`;
    const scenarioGlobalKey = `global:${service}:${opName}`;
    const scenarioEntry = scenarioStore[scenarioWsKey] || scenarioStore[scenarioGlobalKey];
    if (scenarioEntry) {
      res.setHeader('X-Source', 'ai-scenario');
      return res.json(scenarioEntry.data);
    }
  }

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
      const userScope = getUserScope(req);
      const removedKey = opName ? `${userScope}:${service}:${opName}` : null;
      const globalRemovedKey = opName ? `global:${service}:${opName}` : null;
      const removedFields = removedKey ? (aiRemovedFields[removedKey] || aiRemovedFields[globalRemovedKey] || []) : [];
      parsed.data = filterResponseBySelection(parsed.data, selectionMap, removedFields);
    }
    res.json(parsed);
  } catch (err) {
    res.status(502).json({ error: 'Microcks proxy error', detail: err.message });
  }
});

router.post('/graphql', async (req, res) => {
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

module.exports = router;
