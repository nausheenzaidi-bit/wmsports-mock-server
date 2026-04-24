const PORT = process.env.PORT || 4010;
const MICROCKS_URL = process.env.MICROCKS_URL || 'http://localhost:8585';

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
  STATE_FILE_PATH,
  AI_PROVIDER,
  AI_CONFIG,
  AI_API_KEY,
  AI_BASE_URL,
  AI_MODEL,
  CACHE_TTL,
  SCHEMA_CACHE_TTL,
};
