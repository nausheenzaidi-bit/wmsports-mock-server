'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { MICROCKS_URL } = require('../config.cjs');
const { httpGet } = require('../lib/http-helpers.cjs');
const {
  queryFieldMap,
  queryServiceMap,
  queryArgsMap,
  serviceRichTypeMap,
  fullTypeMap,
} = require('../lib/schema-loader.cjs');
const { serverBuildFieldsQuery } = require('../lib/graphql-utils.cjs');
const { compareTypes, describeType } = require('../lib/validation.cjs');

const router = express.Router();

const artifactsDir = () => path.join(__dirname, '..', '..', 'artifacts');

function getRestExampleBody(serviceName, operationName) {
  const dir = artifactsDir();
  const norm = serviceName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-examples.postman.json'));

  for (const file of files) {
    try {
      const coll = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
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
      const coll = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
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

router.get('/ai/rest-fields', (req, res) => {
  const { service, operation } = req.query;
  if (!service || !operation) return res.status(400).json({ error: 'Provide "service" and "operation" query params' });
  const body = getRestExampleBody(service, operation);
  if (!body) return res.json({ fields: [], structure: null });
  const fields = typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  res.json({ fields, structure: describeJsonStructure(body) });
});

router.post('/ai/validate', (req, res) => {
  const { service, operation, response, apiType, queryFields } = req.body;
  if (!service || !operation || !response) return res.status(400).json({ error: 'Provide service, operation, response' });

  const violations = [];

  if (apiType === 'rest') {
    const originalBody = getRestExampleBody(service, operation);
    if (originalBody) {
      compareTypes(originalBody, response, '', violations);
    }
  } else {
    const opName = operation;
    const respData = response?.data?.[opName];
    if (!respData || typeof respData !== 'object') {
      res.json({ violations: [], count: 0, valid: true });
      return;
    }

    let origData = null;
    const dir = artifactsDir();
    const exFiles = fs.readdirSync(dir).filter(f => f.endsWith('-examples.postman.json'));
    for (const file of exFiles) {
      try {
        const coll = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        for (const item of (coll.item || [])) {
          if (item.name === opName) {
            const resp = (item.response || [])[0];
            if (resp && resp.body) {
              const origParsed = JSON.parse(resp.body);
              origData = origParsed?.data?.[opName] || origParsed;
            }
          }
        }
      } catch (_) {}
    }

    const origItem = Array.isArray(origData) ? origData[0] : origData;
    const respItem = Array.isArray(respData) ? respData[0] : respData;

    const fieldsToCheck = (queryFields && queryFields.length > 0) ? queryFields : (respItem ? Object.keys(respItem) : []);

    if (origItem && typeof origItem === 'object' && respItem && typeof respItem === 'object') {
      for (const field of fieldsToCheck) {
        const expected = origItem[field];
        const actual = respItem[field];

        if (actual === undefined || actual === null) {
          if (expected !== undefined && expected !== null) {
            violations.push({ field, expected: describeType(expected), got: actual === null ? 'null' : 'missing', message: `"${field}" expected ${describeType(expected)}, got ${actual === null ? 'null' : 'missing'}` });
          }
        } else if (expected !== undefined && expected !== null) {
          if (Array.isArray(expected) && !Array.isArray(actual)) {
            violations.push({ field, expected: 'array', got: describeType(actual), message: `"${field}" expected array, got ${describeType(actual)}` });
          } else if (!Array.isArray(expected) && Array.isArray(actual)) {
            violations.push({ field, expected: describeType(expected), got: 'array', message: `"${field}" expected ${describeType(expected)}, got array` });
          } else if (typeof expected !== typeof actual) {
            violations.push({ field, expected: describeType(expected), got: describeType(actual), message: `"${field}" expected ${describeType(expected)}, got ${describeType(actual)}` });
          }
        }
      }

      for (const key of Object.keys(respItem)) {
        if (!(key in origItem)) {
          violations.push({ field: key, expected: 'absent', got: describeType(respItem[key]), message: `"${key}" is unexpected (not in original schema)` });
        }
      }
    }
  }

  res.json({ violations, count: violations.length, valid: violations.length === 0 });
});

router.get('/schema/query-fields', (req, res) => {
  const { operation, service } = req.query;
  if (!operation) return res.status(400).json({ error: 'Provide "operation" query param' });

  const opInfo = queryFieldMap[operation];
  if (!opInfo) return res.json({ fields: null, returnType: null });

  const svcName = service || queryServiceMap[operation] || null;
  const svcTypeMap = svcName ? serviceRichTypeMap[svcName] : null;
  const fieldsStr = serverBuildFieldsQuery(opInfo.returnType, 0, new Set(), svcTypeMap);
  res.json({ fields: fieldsStr, returnType: opInfo.returnType, method: opInfo.method, service: svcName });
});

router.get('/schema/query-variables', (req, res) => {
  const { operation } = req.query;
  if (!operation) return res.status(400).json({ error: 'Provide "operation" query param' });

  const args = queryArgsMap[operation];
  if (!args || args.length === 0) return res.json({ variables: {}, variableDefs: '', argumentRefs: '' });

  const variables = {};
  const listDefaults = { String: ['example'], Int: [1], Float: [1.0], ID: ['id-001'] };
  const variableDefs = [];
  const argumentRefs = [];
  for (const a of args) {
    variableDefs.push('$' + a.name + ': ' + (a.typeStr || (a.isList ? '[' + a.typeName + ']!' : a.typeName)));
    argumentRefs.push(a.name + ': $' + a.name);
    if (a.isList) {
      variables[a.name] = (listDefaults[a.typeName] || ['example']);
    } else {
      const scalarDefaults = { String: 'example', Int: 1, Float: 1.0, Boolean: true, ID: 'id-001', Tenant: 'bleacherReport', DateTime: '2026-03-01T00:00:00Z', Date: '2026-03-01' };
      variables[a.name] = scalarDefaults[a.typeName] ?? 'example';
    }
  }
  res.json({
    variables,
    variableDefs: '(' + variableDefs.join(', ') + ')',
    argumentRefs: '(' + argumentRefs.join(', ') + ')',
  });
});

router.get('/ai/types', (req, res) => {
  const types = Object.entries(fullTypeMap)
    .filter(([n]) => !n.startsWith('__'))
    .map(([n, t]) => ({ name: n, fieldCount: t.fields.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ types });
});

router.get('/ai/service-schema', async (req, res) => {
  const { service } = req.query;
  if (!service) return res.status(400).json({ error: 'Provide "service" query param' });

  const dir = artifactsDir();
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'No artifacts directory' });

  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const allFiles = fs.readdirSync(dir);

  const candidates = allFiles.filter(f => {
    const fl = f.toLowerCase();
    return (fl.includes(slug) || fl.includes(service.toLowerCase())) &&
      (fl.endsWith('.graphql') || fl.endsWith('.gql') ||
       (fl.endsWith('.json') && !fl.includes('postman')) ||
       fl.endsWith('.yaml') || fl.endsWith('.yml'));
  });

  const schemaFile = candidates.find(f => f.includes('schema') || f.endsWith('.graphql') || f.endsWith('.gql'))
    || candidates.find(f => f.includes('openapi'))
    || candidates[0];

  if (schemaFile) {
    const content = fs.readFileSync(path.join(dir, schemaFile), 'utf-8');
    return res.json({ schema: content, file: schemaFile, size: content.length });
  }

  try {
    const svcData = await httpGet(`${MICROCKS_URL}/api/services?page=0&size=200`);
    const services = JSON.parse(svcData);
    const norm = service.toLowerCase().replace(/[^a-z0-9]/g, '');
    const svc = services.find(s => s.name === service)
      || services.find(s => s.name.toLowerCase() === service.toLowerCase())
      || services.find(s => s.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    if (svc) {
      const resData = await httpGet(`${MICROCKS_URL}/api/resources/service/${svc.id}`);
      const resources = JSON.parse(resData);
      const gqlSchema = resources.find(r => r.type === 'GRAPHQL_SCHEMA');
      if (gqlSchema && gqlSchema.content) {
        return res.json({ schema: gqlSchema.content, file: `${svc.name}-schema.graphql (from Microcks)`, size: gqlSchema.content.length });
      }
    }
  } catch (_) {}

  return res.status(404).json({ error: 'No schema file found for service: ' + service });
});

module.exports = router;
