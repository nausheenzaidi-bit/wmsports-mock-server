const path = require('path');

const PORT = process.env.PORT || 4010;
const MICROCKS_URL = process.env.MICROCKS_URL || 'http://localhost:8585';

// Directory where API spec/example artifacts live. Read at boot by
// schema-loader and at runtime by the AI flows. In production (EC2) this
// resolves to a path on a persistent EBS-backed volume; locally it falls
// back to the repo's `artifacts/` directory.
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR
  ? path.resolve(process.env.ARTIFACTS_DIR)
  : path.resolve(__dirname, '..', 'artifacts');

// Optional Keycloak (OAuth2 client-credentials) auth for shared Microcks.
// When all three are present, every outgoing Microcks call gets a Bearer token.
// When any is missing, the server runs in "no-auth" mode (local Microcks).
const MICROCKS_AUTH_TOKEN_URL = process.env.MICROCKS_KEYCLOAK_TOKEN_URL || '';
const MICROCKS_CLIENT_ID = process.env.MICROCKS_CLIENT_ID || '';
const MICROCKS_CLIENT_SECRET = process.env.MICROCKS_CLIENT_SECRET || '';
const MICROCKS_AUTH_ENABLED = Boolean(
  MICROCKS_AUTH_TOKEN_URL && MICROCKS_CLIENT_ID && MICROCKS_CLIENT_SECRET
);

// Namespace isolation in a shared Microcks catalog.
// All service names we create/mutate are prefixed; deletes outside the prefix are refused.
// Set to empty string to disable (e.g. local dev with a private Microcks).
const MICROCKS_SERVICE_PREFIX = process.env.MICROCKS_SERVICE_PREFIX ?? 'wmsports-';

const AI_PROVIDER = process.env.AI_PROVIDER || 'groq';

const AI_CONFIG = {
  groq: {
    apiKey: process.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  together: {
    apiKey: process.env.TOGETHER_API_KEY,
    baseURL: 'https://api.together.xyz/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct'
  },
  ollama: {
    // OpenAI-compatible local server; install from https://ollama.com
    apiKey: process.env.OLLAMA_API_KEY || 'ollama',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    model: process.env.OLLAMA_MODEL || 'llama3.2'
  }
};

const { apiKey: AI_API_KEY, baseURL: AI_BASE_URL, model: AI_MODEL } =
  AI_CONFIG[AI_PROVIDER];

// Persistent state file. When set, workspace/scenario data survives restarts.
// On EC2: /data/wmsports/state.json. Locally: leave unset for in-memory only.
const STATE_FILE_PATH = process.env.STATE_FILE_PATH || '';

// ─── Dashboard auth (Okta SAML + service API key) ────────────────────────────
// Auth is opt-in: existing deployments keep working until AUTH_ENABLED=true.
// When enabled, browser users are redirected to Okta over SAML; service-to-
// service callers (mobile apps, CI runners, monitoring) send X-API-Key.
const AUTH_ENABLED = String(process.env.AUTH_ENABLED || 'false').toLowerCase() === 'true';

// Our SP identity. Must match the "Audience URI / SP Entity ID" the Okta
// admin configured on the SAML app.
const SAML_ENTITY_ID = process.env.SAML_ENTITY_ID || 'wmsports-mock-server';

// Where Okta POSTs the SAML response. Must match the ACS URL registered on
// the Okta SAML app (e.g. http://172.16.46.240:4010/auth/saml/callback or
// https://mock-server.gqa.discomax.com/auth/saml/callback once the ALB lands).
const SAML_CALLBACK_URL = process.env.SAML_CALLBACK_URL || '';

// Easiest IdP config: paste the metadata URL from Okta. The app fetches it
// on first login and derives entryPoint/cert/issuer automatically.
const SAML_IDP_METADATA_URL = process.env.SAML_IDP_METADATA_URL || '';

// Manual fallback when no metadata URL is available — set ALL of SSO_URL +
// CERT (ENTITY_ID is optional but recommended for strict issuer matching).
const SAML_IDP_ENTITY_ID = process.env.SAML_IDP_ENTITY_ID || '';
const SAML_IDP_SSO_URL = process.env.SAML_IDP_SSO_URL || '';
const SAML_IDP_CERT = process.env.SAML_IDP_CERT || '';

// Name of the SAML attribute that carries group memberships. Okta's default
// is `groups`; some tenants use `memberOf`. Stays unused until the Okta admin
// adds a Group Attribute Statement to the SAML app.
const SAML_GROUP_ATTRIBUTE = process.env.SAML_GROUP_ATTRIBUTE || 'groups';

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const MOCK_API_KEY = process.env.MOCK_API_KEY || '';
const AUTH_ALLOWED_GROUPS = (process.env.AUTH_ALLOWED_GROUPS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (AUTH_ENABLED) {
  // Fail fast at boot rather than discovering misconfiguration on the first
  // login attempt. SESSION_SECRET is required even for API-key-only callers
  // so express-session can sign its cookie.
  const missing = [];
  if (!SAML_CALLBACK_URL) missing.push('SAML_CALLBACK_URL');
  if (!SESSION_SECRET) missing.push('SESSION_SECRET');
  // Either metadata URL OR (sso_url + cert) — not both required.
  if (!SAML_IDP_METADATA_URL) {
    if (!SAML_IDP_SSO_URL) missing.push('SAML_IDP_SSO_URL (or SAML_IDP_METADATA_URL)');
    if (!SAML_IDP_CERT) missing.push('SAML_IDP_CERT (or SAML_IDP_METADATA_URL)');
  }
  if (missing.length) {
    console.error(`AUTH_ENABLED=true but missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

const CACHE_TTL = 30_000;
const SCHEMA_CACHE_TTL = 120_000;

module.exports = {
  PORT,
  MICROCKS_URL,
  MICROCKS_AUTH_TOKEN_URL,
  MICROCKS_CLIENT_ID,
  MICROCKS_CLIENT_SECRET,
  MICROCKS_AUTH_ENABLED,
  MICROCKS_SERVICE_PREFIX,
  ARTIFACTS_DIR,
  STATE_FILE_PATH,
  AI_PROVIDER,
  AI_CONFIG,
  AI_API_KEY,
  AI_BASE_URL,
  AI_MODEL,
  CACHE_TTL,
  SCHEMA_CACHE_TTL,
  AUTH_ENABLED,
  SAML_ENTITY_ID,
  SAML_CALLBACK_URL,
  SAML_IDP_METADATA_URL,
  SAML_IDP_ENTITY_ID,
  SAML_IDP_SSO_URL,
  SAML_IDP_CERT,
  SAML_GROUP_ATTRIBUTE,
  SESSION_SECRET,
  MOCK_API_KEY,
  AUTH_ALLOWED_GROUPS,
};
