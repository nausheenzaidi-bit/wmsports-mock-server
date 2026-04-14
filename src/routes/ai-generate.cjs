const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse: gqlParse, Kind } = require('graphql');
const { SCALAR_TYPES } = require('../lib/graphql-utils.cjs');
const { responseOverrides, getUserScope } = require('../state.cjs');
const { callLLM, AI_SYSTEM_PROMPT, FAILURE_SCENARIOS, buildScenarioPrompt } = require('../lib/ai-client.cjs');
const { fullTypeMap, queryServiceMap, richTypeMap, serviceRichTypeMap } = require('../lib/schema-loader.cjs');

const ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'artifacts');

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

function extractReturnType(typeNode) {
  if (typeNode.kind === 'NamedType') return typeNode.name.value;
  if (typeNode.kind === 'ListType') return extractReturnType(typeNode.type);
  if (typeNode.kind === 'NonNullType') return extractReturnType(typeNode.type);
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

router.post('/ai/generate', async (req, res) => {
  const { type, operation, prompt, scenario } = req.body;
  if (!prompt && !scenario) return res.status(400).json({ error: 'Provide "prompt" or "scenario"' });

  let schemaCtx = '';
  let targetType = type;
  if (operation) {
    const ret = getOperationReturnType(operation);
    if (ret) { targetType = ret; schemaCtx += `Operation: ${operation} → ${ret}\n`; }
  }
  if (targetType && fullTypeMap[targetType]) schemaCtx += buildTypeSchema(targetType, 0, new Set()) + '\n';

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

router.post('/ai/override', async (req, res) => {
  const { service, operation, data, prompt, scenario, fields, count = 1 } = req.body;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation"' });

  let overrideData = data;
  if (!overrideData && (prompt || scenario)) {
    const retType = getOperationReturnType(operation);
    const svcForSchema = queryServiceMap[operation] || service || null;
    const schemaCtx = retType ? buildTypeSchema(retType, 0, new Set(), svcForSchema) : '';
    const fieldList = (fields && fields.length > 0) ? fields : null;
    const fNames = fieldList ? fieldList.join(', ') : 'all fields';
    const scenarioPrompt = buildScenarioPrompt(scenario, fieldList, fNames, 'query');

    const userPrompt = scenarioPrompt || prompt || '';
    const opMsg = userPrompt + `\n\nSchema context:\n${schemaCtx}\n\nReturn ONLY valid JSON as: {"data": {"${operation}": {...}}}`;
    try {
      overrideData = await callLLM(AI_SYSTEM_PROMPT, opMsg);
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }
  if (!overrideData) return res.status(400).json({ error: 'Provide "data", "prompt", or "scenario"' });

  const userScope = getUserScope(req);
  const key = `${userScope}:${service}:${operation}`;
  responseOverrides[key] = { data: overrideData, remaining: count };
  res.json({ message: `Override active for ${service}:${operation} (${count} request${count > 1 ? 's' : ''})`, key, user: userScope, remaining: count, preview: overrideData });
});

router.get('/ai/overrides', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  const active = {};
  for (const [k, v] of Object.entries(responseOverrides)) {
    if (v.remaining > 0 && k.startsWith(userPrefix)) {
      active[k.slice(userPrefix.length)] = { remaining: v.remaining };
    }
  }
  res.json({ overrides: active });
});

router.delete('/ai/overrides', (req, res) => {
  const userPrefix = getUserScope(req) + ':';
  let cleared = 0;
  Object.keys(responseOverrides).forEach(k => {
    if (k.startsWith(userPrefix)) { delete responseOverrides[k]; cleared++; }
  });
  res.json({ message: `${cleared} override(s) cleared` });
});

module.exports = router;
