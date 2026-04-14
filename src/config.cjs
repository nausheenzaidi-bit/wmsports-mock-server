const PORT = process.env.PORT || 4010;
const MICROCKS_URL = process.env.MICROCKS_URL || 'http://localhost:8585';

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
  }
};

const { apiKey: AI_API_KEY, baseURL: AI_BASE_URL, model: AI_MODEL } =
  AI_CONFIG[AI_PROVIDER];

const CACHE_TTL = 30_000;
const SCHEMA_CACHE_TTL = 120_000;

module.exports = {
  PORT,
  MICROCKS_URL,
  AI_PROVIDER,
  AI_CONFIG,
  AI_API_KEY,
  AI_BASE_URL,
  AI_MODEL,
  CACHE_TTL,
  SCHEMA_CACHE_TTL,
};
