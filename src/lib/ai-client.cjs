const https = require('https');
const { AI_API_KEY, AI_BASE_URL, AI_MODEL } = require('../config.cjs');

const FAILURE_SCENARIOS = {
  'success': { name: 'Success (Happy Path)', prompt: 'Generate correct, realistic data with ALL fields present, proper types, and realistic values. This should be a perfect, valid API response with no issues — real team names, correct scores, valid dates, proper nested structures, and all arrays populated with 1-2 items.' },
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
  'mixed-good-bad': { name: 'Mixed Good & Bad', prompt: 'Generate data where SOME fields have correct, realistic values and OTHER fields have wrong types, null values, or are missing. Mix it up — roughly half the fields should be correct and half should be broken. This simulates a partial API regression where only some fields are affected.' },
};

const AI_SYSTEM_PROMPT = `You are a mock data generator for a sports GraphQL/REST API.

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON in format: {"data": {"operationName": {fields...}}}
- You MUST use the EXACT field names from the schema provided. Do NOT rename, abbreviate, or invent field names. If the schema says "name", use "name" — not "team", "player", "title", or any other synonym.
- For nested types, include ALL the sub-fields defined in the schema with their correct names and types. If the schema defines "type ScoreLeaderboard { name: String, subName: String, id: String }", you MUST use those exact field names.
- You MUST follow the scenario instructions LITERALLY. If told "wrong types", EVERY field must have the wrong type. If told "missing fields", fields must be ABSENT from the JSON. If told "null values", fields must be null. If told "empty arrays", array fields must be [].
- Do NOT generate correct/valid data when asked for bad data. The ENTIRE POINT is to produce broken data that will cause consumer tests to fail.
- WRONG TYPES means: use integers where strings are expected, use strings where numbers are expected, use booleans where objects are expected, use arrays where scalars are expected.
- MISSING FIELDS means: remove 2-3 fields entirely from the JSON object. They should NOT appear at all.
- NULL VALUES means: set every field value to null.
- EMPTY ARRAYS means: set any field that could be an array to [], and set string fields to "".
- Only return the fields you are told to return. Do NOT add extra fields.
- Use real sports content (NFL, NBA, MLB teams/players) when generating valid-looking values.`;

const REST_AI_SYSTEM_PROMPT = `You are a mock data generator for a sports REST API.

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON matching the response structure provided.
- Do NOT wrap the response in {"data": {...}}. Return the raw REST response object directly.
- You MUST follow the scenario instructions LITERALLY. If told "wrong types", EVERY field must have the wrong type. If told "missing fields", fields must be ABSENT from the JSON. If told "null values", fields must be null. If told "empty arrays", array fields must be [].
- Do NOT generate correct/valid data when asked for bad data. The ENTIRE POINT is to produce broken data that will cause consumer tests to fail.
- WRONG TYPES means: use integers where strings are expected, use strings where numbers are expected, use booleans where objects are expected, use arrays where scalars are expected.
- MISSING FIELDS means: remove 2-3 fields entirely from the JSON object. They should NOT appear at all.
- NULL VALUES means: set every field value to null.
- EMPTY ARRAYS means: set any field that could be an array to [], and set string fields to "".
- Use real sports content (NFL, NBA, MLB teams/players) when generating valid-looking values.

NULL vs EMPTY OBJECT (CRITICAL):
- For optional/empty nested objects (podium, race_info, score_leaderboard, ad_placement, etc.), ALWAYS use null — NEVER use an empty object {}.
- Empty objects {} crash downstream parsers that call .map() or access nested fields. null is safely handled.
- For empty arrays, use [] (not null).`;

const ASYNC_AI_SYSTEM_PROMPT = `You are a mock data generator for async message payloads (Kafka / RabbitMQ).

CRITICAL RULES — FOLLOW EXACTLY:
- Return ONLY valid JSON matching the message payload structure provided.
- Do NOT wrap in any extra object — return the raw message payload.
- Do NOT include markdown, backticks, or explanations.
- Your entire response must be parseable by JSON.parse().
- Follow the exact field names from the schema provided.
- If a scenario is specified, apply it precisely to ALL fields.`;

const SETUP_SYSTEM_PROMPT = `You are an API mock data generator. Given a schema and a prompt, generate realistic mock data.

CRITICAL RULES:
- Return ONLY valid JSON. No markdown, no backticks, no explanations.
- Your entire response must be parseable by JSON.parse().
- Use realistic data: real team names, player names, dates, scores, etc.
- If asked for N examples, generate exactly N examples per operation.
- Follow the schema types precisely: strings for String, integers for Int, etc.

STRUCTURE AND NAMING RULES:
- PRESERVE the exact field naming convention from the schema. If fields are snake_case (e.g. game_date, team_one), your output MUST use snake_case. If camelCase, use camelCase.
- Generate ALL levels of nesting shown in the schema description. Do NOT flatten or skip nested objects.
- For arrays, generate 1-2 items to show the structure without excessive data.
- Every field in the schema must appear in the output with a realistic value of the correct type.
- If a field name suggests a specific domain (e.g. permalink, slug), generate url-friendly kebab-case strings.

NULL vs EMPTY OBJECT RULES (CRITICAL for parser compatibility):
- If a field is optional or represents data that may not exist (e.g. podium, race_info, score_leaderboard, ad_placement), use null — NEVER use an empty object {}.
- Empty objects or arrays will crash parsers that try to access nested properties. Always use null for "no data".
- Only use {} when the schema explicitly requires a non-null object with no required fields AND the consumer code handles empty objects.
- For arrays that have no data, use [] (empty array), not null — unless the field is truly optional.
- When in doubt, prefer null over {}.

SPORTS DOMAIN RULES:
- Use real league names: NFL, NBA, MLB, NHL, MLS, Premier League, etc.
- Use real team names: Kansas City Chiefs, Buffalo Bills, Golden State Warriors, etc.
- Use realistic scores, records (e.g. "12-5"), dates, and permalinks (e.g. "kansas-city-chiefs").
- For logo/image URLs, use placeholder URLs like "https://example.com/team-name.png".
- For game status fields, use values like "closed", "in_progress", "scheduled".

SCENARIO SUPPORT:
When the user requests scenarios or failure cases, generate examples that match. Available scenarios:
- "success" / "happy path": Correct, realistic data with all fields present and valid.
- "wrong-types": Field values have WRONG types (strings where numbers expected, numbers where strings expected, etc.)
- "missing-fields": Important fields completely ABSENT from the JSON (not null, just missing keys).
- "null-values": Fields that should have values are null.
- "empty-arrays": All array/list fields are empty [].
- "malformed-dates": Date fields have wrong formats (Unix timestamps, "N/A", epoch 0, "not-a-date").
- "extra-fields": Valid data but with many extra unexpected fields added.
- "encoding-issues": Special characters, unicode, HTML entities in string fields.
- "boundary-values": Extreme values (very long strings, negative numbers, MAX_INT, empty strings).
- "partial-response": Truncated data, incomplete objects, arrays with only 1 item.
- "mixed-good-bad": Half the fields correct, half broken (wrong types, nulls, missing).

When mixing scenarios, LABEL each example clearly by using the requested pattern. For instance, if asked for "3 success, 2 wrong-types, 1 null-values", produce exactly that mix.`;

async function callLLM(systemPrompt, userPrompt) {
  if (!AI_API_KEY) {
    throw new Error('No AI_API_KEY set. Export GROQ_API_KEY or AI_API_KEY.');
  }
  const keyPreview = AI_API_KEY.substring(0, 20) + '...' + AI_API_KEY.substring(AI_API_KEY.length - 10);
  console.log(`🔑 Using API Key: ${keyPreview}`);
  
  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 4096,
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

async function callLLMWithHighTokens(systemPrompt, userPrompt, maxTokens = 4000) {
  if (!AI_API_KEY) throw new Error('No AI_API_KEY set.');
  const payload = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };
  return new Promise((resolve, reject) => {
    const url = new URL(`${AI_BASE_URL}/chat/completions`);
    const postData = JSON.stringify(payload);
    const opts = {
      hostname: url.hostname, port: url.port || 443, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_API_KEY}`, 'Content-Length': Buffer.byteLength(postData) },
      timeout: maxTokens > 8000 ? 120000 : 60000,
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

function buildScenarioPrompt(scenario, fieldList, fNames, apiLabel) {
  if (!scenario || !FAILURE_SCENARIOS[scenario]) return '';
  const base = FAILURE_SCENARIOS[scenario].prompt;
  if (!fieldList) return base;

  const label = apiLabel || 'query';
  const examples = {
    'wrong-types': `The ${label} has these fields: ${fNames}. For ONLY these specific fields, return the WRONG type. String fields → return NUMBER/BOOLEAN. Number fields → return STRING. Do NOT apply this to other fields.`,
    'missing-fields': `The ${label} has these fields: ${fNames}. REMOVE at least 2 of these fields entirely from the JSON. The response must have FEWER keys than requested.`,
    'null-values': `The ${label} has these fields: ${fNames}. Set EVERY single one to null.`,
    'empty-arrays': `The ${label} has these fields: ${fNames}. Set every field to an empty value: strings become "", arrays become [], numbers become 0.`,
    'extra-fields': `The ${label} has these fields: ${fNames}. Include all with valid data, BUT also add 3-4 EXTRA unexpected fields like "__internal_id", "_debug_trace", "legacyScore".`,
    'deprecated-fields': `The ${label} has these fields: ${fNames}. Rename 2-3 of them (e.g. "slug" → "slug_v2"). Original names must be ABSENT.`,
    'malformed-dates': `The ${label} has these fields: ${fNames}. For date fields return "not-a-date" or 0. Other fields can be valid.`,
    'boundary-values': `The ${label} has these fields: ${fNames}. Use extreme values: 200+ char strings, -99999, MAX_INT (2147483647), empty strings.`,
    'encoding-issues': `The ${label} has these fields: ${fNames}. Put special chars: unicode, HTML entities, <script> tags, emojis.`,
    'partial-response': `The ${label} has these fields: ${fNames}. Only include 1-2 of the ${fieldList.length} fields. Rest must be ABSENT.`,
    'mixed-good-bad': `The ${label} has these fields: ${fNames}. For roughly HALF, return correct values. For the OTHER HALF, introduce problems: wrong types, null, or empty. Leave unlisted fields correct.`,
  };
  return (examples[scenario] || base) + '\n\n' + base;
}

function extractFieldsToRemove(prompt, fieldList) {
  if (!prompt || !fieldList || !/remove|delete|omit/i.test(prompt)) return [];
  const words = prompt.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  return fieldList.filter(f => {
    const fn = f.toLowerCase();
    return words.some(w => fn.includes(w) || w.includes(fn)) || prompt.toLowerCase().includes(fn);
  });
}

module.exports = {
  FAILURE_SCENARIOS,
  AI_SYSTEM_PROMPT,
  REST_AI_SYSTEM_PROMPT,
  ASYNC_AI_SYSTEM_PROMPT,
  SETUP_SYSTEM_PROMPT,
  callLLM,
  callLLMWithHighTokens,
  buildScenarioPrompt,
  extractFieldsToRemove,
};
