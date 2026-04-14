const { SCALAR_TYPES } = require('./graphql-utils.cjs');

function buildPostmanCollection(serviceName, operationName, responseBody, fields) {
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  const selSet = (fields && fields.length > 0) ? fields.join(' ') : '';
  const queryStr = selSet ? `${operationName} { ${selSet} }` : operationName;
  const fullQuery = `{ ${queryStr} }`;
  return {
    info: {
      _postman_id: `ai-inject-${serviceName}-${operationName}`,
      name: serviceName,
      description: `version=1.0 - AI injected example for ${operationName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: operationName,
      request: {
        method: 'POST',
        url: `http://${operationName}`,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify({ query: fullQuery }) },
      },
      response: [{
        name: 'ai-injected',
        originalRequest: {
          method: 'POST',
          url: `http://${operationName}`,
          body: { mode: 'raw', raw: JSON.stringify({ query: fullQuery }) },
        },
        code: 200,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: bodyStr,
      }],
    }],
  };
}

function buildSingleOpRestCollection(serviceName, operationName, responseBody, details) {
  const bodyStr = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
  const method = details.method || 'GET';
  const url = details.url || `http://example.com${operationName}`;
  const statusCode = details.statusCode || 200;

  return {
    info: {
      _postman_id: `ai-inject-rest-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=1.0 - AI injected example for ${operationName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{
      name: operationName,
      request: {
        method,
        url,
        header: [{ key: 'Content-Type', value: 'application/json' }],
      },
      response: [{
        name: 'ai-injected',
        originalRequest: {
          method,
          url,
          header: [{ key: 'Content-Type', value: 'application/json' }],
        },
        code: statusCode,
        _postman_previewlanguage: 'json',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: bodyStr,
      }],
    }],
  };
}

function buildFieldsForType(types, typeName, depth = 0) {
  if (depth > 2 || !types[typeName]) return null;
  const fields = types[typeName];
  const parts = [];
  for (const [fname, typeInfo] of Object.entries(fields)) {
    if (SCALAR_TYPES.has(typeInfo.name) || !types[typeInfo.name]) {
      parts.push(fname);
    } else {
      const nested = buildFieldsForType(types, typeInfo.name, depth + 1);
      if (nested) parts.push(fname + ' { ' + nested + ' }');
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

function buildFullTypeDesc(typeName, types, depth = 0, visited = null) {
  if (!visited) visited = new Set();
  if (depth > 2 || !types[typeName] || visited.has(typeName)) return '';
  visited.add(typeName);
  const fields = types[typeName];
  const lines = [];
  const queue = [];
  for (const [fname, typeInfo] of Object.entries(fields)) {
    const typeStr = typeInfo.isList ? `[${typeInfo.name}]` : typeInfo.name;
    lines.push(`  ${fname}: ${typeStr}`);
    if (!SCALAR_TYPES.has(typeInfo.name) && types[typeInfo.name] && !visited.has(typeInfo.name)) {
      queue.push(typeInfo.name);
    }
  }
  let result = `type ${typeName} {\n${lines.join('\n')}\n}`;
  for (const t of queue) {
    const sub = buildFullTypeDesc(t, types, depth + 1, visited);
    if (sub) result += '\n' + sub;
  }
  return result;
}

function buildVariablesForArgs(args) {
  const vars = {};
  for (const arg of args) {
    const defaults = {
      'String': 'example', 'Int': 1, 'Float': 1.0, 'Boolean': true, 'ID': 'id-001',
      'Tenant': 'bleacherReport', 'DateTime': '2026-03-01T00:00:00Z',
    };
    if (arg.type.isList) {
      vars[arg.name] = [defaults[arg.type.name] || 'example'];
    } else {
      vars[arg.name] = defaults[arg.type.name] || 'example';
    }
  }
  return vars;
}

function buildAutoPostmanCollection(serviceName, operations, types, generatedData, version = '1.0') {
  const items = [];

  for (const op of operations) {
    const fieldsStr = buildFieldsForType(types, op.returnType);

    const argDefs = op.args.map(a => {
      let gqlType = a.type.name;
      if (a.type.isList) gqlType = '[' + gqlType + ']';
      return '$' + a.name + ': ' + gqlType;
    }).join(', ');
    const argPass = op.args.map(a => a.name + ': $' + a.name).join(', ');

    const prefix = op.method === 'MUTATION' ? 'mutation' : 'query';
    const sigPart = argDefs ? `${prefix} ${op.name}(${argDefs})` : `${prefix} ${op.name}`;
    const callPart = argPass ? `${op.name}(${argPass})` : op.name;
    const queryStr = fieldsStr
      ? `${sigPart} { ${callPart} { ${fieldsStr} } }`
      : `${sigPart} { ${callPart} }`;
    const variables = buildVariablesForArgs(op.args);

    const bodyRaw = JSON.stringify({ query: queryStr, variables });

    const responseData = generatedData[op.name];
    const responses = [];

    if (Array.isArray(responseData) && responseData.length > 0) {
      for (let i = 0; i < responseData.length; i++) {
        const example = responseData[i];
        const exampleBody = example && example.data
          ? JSON.stringify(example)
          : JSON.stringify({ data: { [op.name]: example } });
        responses.push({
          name: `example-${i + 1}`,
          originalRequest: {
            method: 'POST',
            url: `http://${op.name}`,
            body: { mode: 'raw', raw: bodyRaw },
          },
          code: 200,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: exampleBody,
        });
      }
    } else {
      let responseBody;
      if (responseData) {
        responseBody = responseData.data
          ? JSON.stringify(responseData)
          : JSON.stringify({ data: { [op.name]: responseData } });
      } else {
        responseBody = JSON.stringify({ data: { [op.name]: null } });
      }
      responses.push({
        name: 'ai-generated',
        originalRequest: {
          method: 'POST',
          url: `http://${op.name}`,
          body: { mode: 'raw', raw: bodyRaw },
        },
        code: 200,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: responseBody,
      });
    }

    items.push({
      name: op.name,
      request: {
        method: 'POST',
        url: `http://${op.name}`,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: bodyRaw },
      },
      response: responses,
    });
  }

  return {
    info: {
      _postman_id: `ai-setup-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=${version} - AI-generated mock examples for ${serviceName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

function buildRestPostmanCollection(serviceName, version, operations, generatedData) {
  const items = [];
  for (const op of operations) {
    const responses = [];
    const data = generatedData[op.name];

    // Extract path parameter names (e.g. {id}, {userId})
    const pathParams = [];
    op.path.replace(/\{(\w+)\}/g, (_, name) => { pathParams.push(name); });

    if (Array.isArray(data) && data.length > 0) {
      for (let i = 0; i < data.length; i++) {
        let exampleUrl = op.path;
        for (const param of pathParams) {
          const val = (data[i] && data[i][param]) || `val-${i + 1}`;
          exampleUrl = exampleUrl.replace(`{${param}}`, val);
        }
        responses.push({
          name: `example-${i + 1}`,
          originalRequest: { method: op.method, url: exampleUrl },
          code: op.responseCode,
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: JSON.stringify(data[i]),
        });
      }
    } else {
      let exampleUrl = op.path;
      for (const param of pathParams) {
        exampleUrl = exampleUrl.replace(`{${param}}`, 'default');
      }
      responses.push({
        name: 'ai-generated',
        originalRequest: { method: op.method, url: exampleUrl },
        code: op.responseCode,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: JSON.stringify(data || {}),
      });
    }

    items.push({
      name: op.name,
      request: {
        method: op.method,
        header: [{ key: 'Content-Type', value: 'application/json' }],
        url: op.path,
      },
      response: responses,
    });
  }

  return {
    info: {
      _postman_id: `ai-setup-rest-${serviceName}-${Date.now()}`,
      name: serviceName,
      description: `version=${version} - AI-generated REST mock examples for ${serviceName}`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items,
  };
}

function injectExamplesIntoOpenAPI(spec, operations, generatedData) {
  const updated = JSON.parse(JSON.stringify(spec));
  for (const op of operations) {
    const methodDef = updated.paths?.[op.path]?.[op.method.toLowerCase()];
    if (!methodDef) continue;

    const data = generatedData[op.name];
    if (!data) continue;

    // Add FALLBACK dispatcher so any parameter values return a response
    const pathParams = [];
    op.path.replace(/\{(\w+)\}/g, (_, name) => { pathParams.push(name); });
    const queryParams = (op.parameters || [])
      .filter(p => p.in === 'query')
      .map(p => p.name);

    if (pathParams.length > 0) {
      methodDef['x-microcks-operation'] = {
        dispatcher: 'FALLBACK',
        dispatcherRules: JSON.stringify({
          dispatcher: 'URI_PARTS',
          dispatcherRules: pathParams.join(' && '),
          fallback: 'example-1',
        }),
      };
    } else if (queryParams.length > 0) {
      methodDef['x-microcks-operation'] = {
        dispatcher: 'FALLBACK',
        dispatcherRules: JSON.stringify({
          dispatcher: 'URI_PARAMS',
          dispatcherRules: queryParams.join(' && '),
          fallback: 'example-1',
        }),
      };
    } else {
      methodDef['x-microcks-operation'] = {
        dispatcher: 'FALLBACK',
        dispatcherRules: JSON.stringify({ fallback: 'example-1' }),
      };
    }

    const successCode = String(op.responseCode);
    if (!methodDef.responses) methodDef.responses = {};
    if (!methodDef.responses[successCode]) methodDef.responses[successCode] = { description: 'OK' };
    const resp = methodDef.responses[successCode];
    if (!resp.content) resp.content = { 'application/json': {} };
    const ct = resp.content['application/json'] || (resp.content[Object.keys(resp.content)[0]]);

    const examples = {};
    if (Array.isArray(data)) {
      data.forEach((d, i) => { examples[`example-${i + 1}`] = { summary: `AI generated example ${i + 1}`, value: d }; });
    } else {
      examples['example-1'] = { summary: 'AI generated example', value: data };
    }
    ct.examples = examples;
  }
  return updated;
}

module.exports = {
  buildPostmanCollection,
  buildSingleOpRestCollection,
  buildAutoPostmanCollection,
  buildRestPostmanCollection,
  injectExamplesIntoOpenAPI,
  buildFieldsForType,
  buildFullTypeDesc,
  buildVariablesForArgs,
};
