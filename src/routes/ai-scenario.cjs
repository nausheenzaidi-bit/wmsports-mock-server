const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse: gqlParse, Kind } = require('graphql');
const { MICROCKS_URL } = require('../config.cjs');
const { SCALAR_TYPES } = require('../lib/graphql-utils.cjs');
const { httpGet } = require('../lib/http-helpers.cjs');
const { responseOverrides, aiRemovedFields, scenarioStore, getUserScope, markDirty } = require('../state.cjs');
const {
  callLLM,
  AI_SYSTEM_PROMPT,
  REST_AI_SYSTEM_PROMPT,
  FAILURE_SCENARIOS,
  buildScenarioPrompt,
  extractFieldsToRemove,
} = require('../lib/ai-client.cjs');
const { queryServiceMap, richTypeMap, serviceRichTypeMap } = require('../lib/schema-loader.cjs');
const {
  getMicrocksServiceId,
  importArtifactToMicrocks,
  deleteServiceFromMicrocks,
  clearServiceDispatchers,
  invalidateCache,
  configureOperationDispatcher,
} = require('../lib/microcks-service.cjs');
const { buildPostmanCollection, buildSingleOpRestCollection } = require('../lib/postman-builder.cjs');
const { ARTIFACTS_DIR } = require('../config.cjs');

function findMainArtifact(serviceName) {
  const norm = serviceName.toLowerCase().replace(/api$/i, '').replace(/[^a-z0-9]/g, '');

  // Pass 1: exact match only
  const schemaFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-schema.graphql'));
  for (const file of schemaFiles) {
    const fn = file.toLowerCase().replace(/-schema\.graphql$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }
  const openapiFiles = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-openapi.json') || f.endsWith('-openapi.yaml'));
  for (const file of openapiFiles) {
    const fn = file.toLowerCase().replace(/-openapi\.(json|yaml)$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }

  // Pass 2: substring match (but only if the normalized names are the same length to avoid cross-matching)
  for (const file of schemaFiles) {
    const fn = file.toLowerCase().replace(/-schema\.graphql$/, '').replace(/-/g, '');
    if (fn.length === norm.length && (fn.includes(norm) || norm.includes(fn))) return file;
  }
  for (const file of openapiFiles) {
    const fn = file.toLowerCase().replace(/-openapi\.(json|yaml)$/, '').replace(/-/g, '');
    if (fn.length === norm.length && (fn.includes(norm) || norm.includes(fn))) return file;
  }
  return null;
}

function findExamplesFile(serviceName) {
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-examples.postman.json'));
  const norm = serviceName.toLowerCase().replace(/api$/i, '').replace(/[^a-z0-9]/g, '');

  // Exact match first
  for (const file of files) {
    const fn = file.toLowerCase().replace(/-examples\.postman\.json$/, '').replace(/-/g, '');
    if (fn === norm) return file;
  }
  // Substring match only for same-length names
  for (const file of files) {
    const fn = file.toLowerCase().replace(/-examples\.postman\.json$/, '').replace(/-/g, '');
    if (fn.length === norm.length && (fn.includes(norm) || norm.includes(fn))) return file;
  }
  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      if (coll.info && coll.info.name === serviceName) return file;
    } catch(_) {}
  }
  return null;
}

async function uploadPostmanCollection(collection) {
  const tmpFile = path.join(os.tmpdir(), `microcks-inject-${Date.now()}.postman_collection.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(collection, null, 2));
  try {
    const result = await importArtifactToMicrocks(tmpFile, false);
    fs.unlinkSync(tmpFile);
    return result;
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch(_) {}
    throw err;
  }
}

async function restoreOriginalExamples(serviceName) {
  const serviceId = await getMicrocksServiceId(serviceName);
  if (serviceId) {
    await deleteServiceFromMicrocks(serviceId);
    await new Promise(r => setTimeout(r, 1000));
  }

  const mainFile = findMainArtifact(serviceName);
  if (!mainFile) return { restored: false, reason: 'No main artifact found for ' + serviceName };
  await importArtifactToMicrocks(path.join(ARTIFACTS_DIR, mainFile), true);
  await new Promise(r => setTimeout(r, 2000));

  const examplesFile = findExamplesFile(serviceName);
  if (!examplesFile) return { restored: false, reason: 'No examples file found for ' + serviceName };
  await importArtifactToMicrocks(path.join(ARTIFACTS_DIR, examplesFile), false);

  invalidateCache();

  // Clear dispatchers to ensure Microcks serves the restored examples
  try {
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const result = await clearServiceDispatchers(serviceName);
      if (result.cleared > 0) break;
    }
  } catch (e) {
    // Continue even if dispatcher clear fails
  }

  return { restored: true, mainFile, examplesFile };
}

function getRestExampleBody(serviceName, operationName) {
  const norm = serviceName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-examples.postman.json'));

  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      if (coll.info && coll.info.name !== serviceName) continue;
      for (const item of (coll.item || [])) {
        if (item.name === operationName) {
          const resp = (item.response || [])[0];
          if (resp && resp.body) return JSON.parse(resp.body);
        }
      }
    } catch (_) {}
  }

  for (const file of files) {
    const fn = file.toLowerCase().replace(/-examples\.postman\.json$/, '').replace(/-/g, '');
    const normSvc = norm.replace(/-/g, '');
    if (fn !== normSvc && !fn.includes(normSvc) && !normSvc.includes(fn)) continue;
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      for (const item of (coll.item || [])) {
        if (item.name === operationName) {
          const resp = (item.response || [])[0];
          if (resp && resp.body) return JSON.parse(resp.body);
        }
      }
    } catch (_) {}
  }
  return null;
}

async function getRestOperationDetails(serviceName, operationName) {
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('-examples.postman.json'));

  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8'));
      if (coll.info && coll.info.name !== serviceName) continue;
      for (const item of (coll.item || [])) {
        if (item.name === operationName) {
          const req = item.request || {};
          const resp = (item.response || [])[0] || {};
          let url = req.url || '';
          if (typeof url === 'object') url = url.raw || '';
          return {
            method: req.method || 'GET',
            url,
            exampleName: resp.name || 'example',
            statusCode: resp.code || resp.status || 200,
            body: resp.body ? JSON.parse(resp.body) : null,
          };
        }
      }
    } catch (_) {}
  }

  // Fallback: fetch from Microcks when no local artifact exists
  try {
    const serviceId = await getMicrocksServiceId(serviceName);
    if (serviceId) {
      const raw = await httpGet(`${MICROCKS_URL}/api/services/${serviceId}`);
      const data = JSON.parse(raw);
      const svc = data.service || {};
      const msgs = data.messagesMap || {};
      const opMessages = msgs[operationName];
      if (opMessages && opMessages.length > 0) {
        const msg = opMessages[0];
        const resp = msg.response || {};
        const op = (svc.operations || []).find(o => o.name === operationName) || {};
        const parts = operationName.split(' ');
        const method = parts[0] || 'GET';
        const opPath = parts.slice(1).join(' ') || '/';
        let body = null;
        try { body = JSON.parse(resp.content || '{}'); } catch (_) {}
        return {
          method,
          url: `${MICROCKS_URL}/rest/${serviceName}/${svc.version || '1.0'}${opPath}`,
          exampleName: resp.name || 'example-1',
          statusCode: resp.status ? parseInt(resp.status, 10) : 200,
          body,
        };
      }
    }
  } catch (_) {}

  return null;
}

function describeJsonStructure(obj, depth = 0) {
  if (depth > 2) return typeof obj;
  if (obj === null) return 'null';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${describeJsonStructure(obj[0], depth + 1)}]`;
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj).slice(0, 20);
    const fields = entries.map(([k, v]) => {
      if (v === null) return `  ${k}: nullable`;
      if (Array.isArray(v)) return `  ${k}: array`;
      if (typeof v === 'object') return `  ${k}: object`;
      return `  ${k}: ${typeof v}`;
    });
    return `{\n${fields.join('\n')}\n}`;
  }
  return typeof obj;
}

function extractReturnType(typeNode) {
  if (typeNode.kind === 'NamedType') return typeNode.name.value;
  if (typeNode.kind === 'ListType') return extractReturnType(typeNode.type);
  if (typeNode.kind === 'NonNullType') return extractReturnType(typeNode.type);
  return null;
}

function getOperationReturnType(opName) {
  const files = fs.readdirSync(ARTIFACTS_DIR).filter(f => f.endsWith('.graphql'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(ARTIFACTS_DIR, file), 'utf-8');
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

function buildTypeSchema(typeName, depth = 0, visited = new Set(), svcName = null) {
  const typeMap = (svcName && serviceRichTypeMap[svcName]) || richTypeMap;
  if (depth > 3 || !typeMap[typeName] || visited.has(typeName)) return '';
  visited.add(typeName);

  const fields = typeMap[typeName];
  const lines = [];
  const nested = [];
  for (const [fname, typeInfo] of Object.entries(fields)) {
    if (fname.startsWith('_')) continue;
    const typeStr = typeInfo.isList ? `[${typeInfo.name}]` : typeInfo.name;
    lines.push(`  ${fname}: ${typeStr}`);
    if (!SCALAR_TYPES.has(typeInfo.name) && typeMap[typeInfo.name] && !visited.has(typeInfo.name)) {
      const sub = buildTypeSchema(typeInfo.name, depth + 1, new Set(visited), svcName);
      if (sub) nested.push(sub);
    }
  }
  let result = `type ${typeName} {\n${lines.join('\n')}\n}`;
  if (nested.length > 0) result += '\n\n' + nested.join('\n\n');
  return result;
}

const router = express.Router();

router.post('/ai/scenario', async (req, res) => {
  const { service, operation, prompt, scenario, fields, apiType, preview, resolvedOperation } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation"' });
  if (!prompt && !scenario) return res.status(400).json({ error: 'Provide "prompt" or "scenario"' });

  const isRest = apiType === 'rest';
  const fieldList = (fields && fields.length > 0) ? fields : null;

  if (isRest) {
    const details = await getRestOperationDetails(service, operation);
    const exampleBody = details ? details.body : null;
    const structureDesc = exampleBody ? describeJsonStructure(exampleBody) : '{}';
    const restFields = fieldList || (exampleBody ? Object.keys(exampleBody) : []);
    const fNames = restFields.join(', ') || 'all fields';
    const scenarioPrompt = buildScenarioPrompt(scenario, restFields, fNames, 'response');

    const isCustomRestPrompt = !!prompt && !scenario;
    const userPrompt = prompt || scenarioPrompt || '';
    let opMsg;
    if (isCustomRestPrompt) {
      opMsg = `USER INSTRUCTION (follow this EXACTLY): ${userPrompt}\n\nThe response has these fields: ${fNames}.\nFollow the user instruction above precisely. If they say to remove/delete fields, those fields must be COMPLETELY ABSENT from the JSON (not null, not empty — the key itself must not exist). If they say to set fields to null, set them to null. Do exactly what is asked.\n\nOriginal response structure:\n${structureDesc}\n\nExample body:\n${JSON.stringify(exampleBody, null, 2).slice(0, 1500)}\n\nReturn ONLY valid JSON matching this REST response structure. Do NOT wrap in {"data": ...}.`;
    } else {
      opMsg = userPrompt + `\n\nOriginal response structure:\n${structureDesc}\n\nExample body:\n${JSON.stringify(exampleBody, null, 2).slice(0, 1500)}\n\nReturn ONLY valid JSON matching this REST response structure. Do NOT wrap in {"data": ...}.`;
    }

    let aiData;
    try {
      aiData = await callLLM(REST_AI_SYSTEM_PROMPT, opMsg);
    } catch (err) { return res.status(500).json({ error: 'LLM error: ' + err.message }); }

    if (isCustomRestPrompt) {
      const toRemove = extractFieldsToRemove(userPrompt, restFields);
      if (toRemove.length > 0 && typeof aiData === 'object') {
        toRemove.forEach(field => delete aiData[field]);
      }
    }

    if (preview) {
      return res.json({ preview: aiData, scenario: scenario || 'custom', apiType: 'rest', service, operation });
    }

    const userScope = req.body.global ? 'global' : getUserScope(req);
    const storeOp = resolvedOperation || operation;
    const key = `${userScope}:${service}:${storeOp}`;
    scenarioStore[key] = { data: aiData, scenario: scenario || 'custom', apiType: 'rest' };
    markDirty();
    res.json({
      message: `Scenario active for REST ${service}/${storeOp}`,
      appliedTo: 'server',
      key,
      user: userScope,
      preview: aiData,
      scenario: scenario || 'custom',
      apiType: 'rest',
    });
    return;
  }

  // GraphQL scenario
  const retType = getOperationReturnType(operation);
  const svcForSchema = queryServiceMap[operation] || service || null;
  const schemaCtx = retType ? buildTypeSchema(retType, 0, new Set(), svcForSchema) : '';
  const fNames = fieldList ? fieldList.join(', ') : 'all fields';
  const scenarioPrompt = buildScenarioPrompt(scenario, fieldList, fNames, 'query');

  const isCustomPrompt = !!(prompt && String(prompt).trim());
  const userPrompt = prompt || scenarioPrompt || '';
  let fieldsConstraint = '';
  if (!isCustomPrompt && fieldList && !['missing-fields', 'extra-fields', 'deprecated-fields', 'partial-response'].includes(scenario)) {
    fieldsConstraint = `\nThe response object MUST contain ONLY these fields: ${fNames}.`;
  }

  const toNull = isCustomPrompt ? extractFieldsToRemove(userPrompt, fieldList) : [];
  const explicitNullFields = toNull.length > 0
    ? `\n\nSET THESE FIELDS TO null (not empty object, not omitted): ${toNull.join(', ')}.`
    : '';

  // Extract example number from request (if provided) to generate diverse data
  const exampleNum = req.body.example || req.body.exchangeName || '';
  const diversityHint = exampleNum ? `\nIMPORTANT: This is ${exampleNum}. Generate DIFFERENT realistic data from other examples. Vary: team names, dates, scores, show titles, episode numbers, league info, etc. Make each example distinct.` : '';

  let opMsg;
  if (isCustomPrompt) {
    opMsg = `USER INSTRUCTION (follow this EXACTLY): ${userPrompt}\n\nThe query has these fields: ${fNames}.\nCRITICAL: Follow the user instruction above precisely. When they say "remove", "delete", or "omit" specific fields, set those fields to null — do NOT use empty objects {} or omit the keys (GraphQL requires all requested fields present). All other fields: return realistic values.${explicitNullFields}${diversityHint}\n\nSchema for reference:\n${schemaCtx}\nReturn ONLY valid JSON as: {"data": {"${operation}": {...}}}`;
  } else {
    opMsg = userPrompt + `\n\nSchema (use EXACT field names and types below):\n${schemaCtx}${fieldsConstraint}\nCRITICAL: Every nested object must use the EXACT sub-field names from the schema above. Do NOT invent field names.${diversityHint}\nReturn ONLY valid JSON as: {"data": {"${operation}": {...}}}`;
  }

  let aiData;
  try {
    aiData = await callLLM(AI_SYSTEM_PROMPT, opMsg);
  } catch (err) { return res.status(500).json({ error: 'LLM error: ' + err.message }); }

  if (isCustomPrompt && fieldList) {
    const toRemove = extractFieldsToRemove(userPrompt, fieldList);
    if (toRemove.length > 0 && aiData?.data?.[operation]) {
      toRemove.forEach(field => delete aiData.data[operation][field]);
      const userScope = getUserScope(req);
      aiRemovedFields[`${userScope}:${service}:${operation}`] = toRemove;
    }
  }

  if (preview) {
    return res.json({ preview: aiData, scenario: scenario || 'custom', apiType: 'graphql', service, operation, example: exampleNum });
  }

  const userScope = req.body.global ? 'global' : getUserScope(req);
  // Key by both operation AND example to store different data for each example
  const key = exampleNum ? `${userScope}:${service}:${operation}:${exampleNum}` : `${userScope}:${service}:${operation}`;
  scenarioStore[key] = { data: aiData, scenario: scenario || 'custom', apiType: 'graphql', example: exampleNum };
  markDirty();
  res.json({
    message: `Scenario active for ${service}/${operation}${exampleNum ? ` (${exampleNum})` : ''}`,
    appliedTo: 'server',
    key,
    user: userScope,
    preview: aiData,
    scenario: scenario || 'custom',
    example: exampleNum,
  });
});

router.post('/ai/restore', async (req, res) => {
  const { service } = req.body;
  if (!service) return res.status(400).json({ error: 'Provide "service"' });
  try {
    const result = await restoreOriginalExamples(service);
    invalidateCache();
    const userScope = getUserScope(req);
    for (const key of Object.keys(aiRemovedFields)) {
      if (key.startsWith(`${userScope}:${service}:`)) delete aiRemovedFields[key];
    }
    for (const key of Object.keys(scenarioStore)) {
      if (key.startsWith(`${userScope}:${service}:`)) delete scenarioStore[key];
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Restore failed: ' + err.message });
  }
});

router.get('/ai/scenarios', (req, res) => {
  res.json({ scenarios: Object.entries(FAILURE_SCENARIOS).map(([id, s]) => ({ id, name: s.name, description: s.prompt.split('.')[0] + '.' })) });
});

router.get('/ai/scenarios/active', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  const active = {};
  for (const [k, v] of Object.entries(scenarioStore)) {
    if (k.startsWith(userPrefix)) {
      active[k.slice(userPrefix.length)] = { scenario: v.scenario, apiType: v.apiType };
    }
  }
  res.json({ scenarios: active });
});

router.delete('/ai/scenarios/active', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  let cleared = 0;
  Object.keys(scenarioStore).forEach(k => {
    if (k.startsWith(userPrefix)) { delete scenarioStore[k]; cleared++; }
  });
  markDirty();
  res.json({ message: `${cleared} scenario(s) cleared` });
});

router.post('/ai/scenario/clear', (req, res) => {
  const { service, operation } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide service and operation' });

  const userScope = getUserScope(req);
  const wsId = req.headers['x-workspace'] || null;
  let cleared = 0;

  const keysToCheck = [
    `${userScope}:${service}:${operation}`,
    `global:${service}:${operation}`,
  ];
  if (wsId) {
    keysToCheck.unshift(`ws:${wsId}:${userScope}:${service}:${operation}`);
  }

  for (const key of keysToCheck) {
    if (scenarioStore[key]) { delete scenarioStore[key]; cleared++; }
    if (responseOverrides[key]) { delete responseOverrides[key]; cleared++; }
    if (aiRemovedFields[key]) { delete aiRemovedFields[key]; cleared++; }
  }

  for (const k of Object.keys(scenarioStore)) {
    if (k.startsWith(`${userScope}:${service}:${operation}:`)) { delete scenarioStore[k]; cleared++; }
    if (wsId && k.startsWith(`ws:${wsId}:${userScope}:${service}:${operation}:`)) { delete scenarioStore[k]; cleared++; }
  }

  markDirty();
  res.json({ cleared, service, operation });
});

router.post('/ai/scenario-inject', async (req, res) => {
  const { service, operation, data, apiType, scenarioName, variables, resolvedOperation } = req.body;
  if (!service || !operation || !data) {
    return res.status(400).json({ error: 'Provide service, operation, and data' });
  }

  try {
    let collection;
    if (apiType === 'rest') {
      const parts = operation.split(' ');
      const method = parts[0] || 'GET';
      const templatePath = parts.slice(1).join(' ') || '/';

      let resolvedPath = null;
      if (resolvedOperation) {
        const rParts = resolvedOperation.split(' ');
        resolvedPath = rParts.slice(1).join(' ') || null;
      }

      collection = buildSingleOpRestCollection(service, operation, data, {
        method,
        url: resolvedPath ? `http://example.com${resolvedPath}` : `http://example.com${templatePath}`,
        statusCode: 200,
        resolvedPath,
        templatePath,
      });
    } else {
      collection = buildPostmanCollection(service, operation, data, null, variables);
    }
    await uploadPostmanCollection(collection);
    invalidateCache();

    if (apiType === 'rest') {
      const parts = operation.split(' ');
      const templatePath = parts.slice(1).join(' ') || '/';
      const pathParams = [];
      templatePath.replace(/\{(\w+)\}/g, (_, name) => { pathParams.push(name); });

      let fallbackName = 'default';
      if (resolvedOperation && pathParams.length > 0) {
        const rParts = (resolvedOperation.split(' ').slice(1).join(' ') || '/').split('/');
        const tParts = templatePath.split('/');
        const vals = [];
        for (let i = 0; i < tParts.length; i++) {
          if (tParts[i] && tParts[i].startsWith('{') && rParts[i]) vals.push(rParts[i]);
        }
        if (vals.length > 0) fallbackName = vals.join('-');
      }

      if (pathParams.length > 0) {
        try {
          await configureOperationDispatcher(
            service,
            operation,
            'FALLBACK',
            JSON.stringify({
              dispatcher: 'URI_PARTS',
              dispatcherRules: pathParams.join(' && '),
              fallback: fallbackName,
            })
          );
        } catch (_) {}
      }
    }

    res.json({ injected: true, service, operation, scenarioName: scenarioName || 'custom' });
  } catch (err) {
    res.json({ injected: false, error: err.message, service, operation });
  }
});

module.exports = router;
