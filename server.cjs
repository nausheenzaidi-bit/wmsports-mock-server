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
 *
 * FUTURE ENHANCEMENT:
 *   This server's mock generation logic (@faker-js/faker, @graphql-tools/mock, LLM integration)
 *   can be extracted as an npm package to support inline mocking in resolvers, where developers
 *   can call generateMockData() directly without endpoint changes. See ENHANCEMENT.md.
 */

const app = require('./src/app.cjs');
const { PORT, MICROCKS_URL, AI_API_KEY, AI_MODEL } = require('./src/config.cjs');
const { fetchMicrocksServices } = require('./src/lib/microcks-service.cjs');

app.listen(PORT, async () => {
  console.log(`\n  WM Sports Mock Server (Microcks-Powered)`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Microcks:   ${MICROCKS_URL}`);
  console.log(`  GraphQL:    POST /graphql/:service`);
  console.log(`  REST:       /rest/:service/:version/...`);
  console.log(`  Health:     GET /health`);
  console.log(`  AI Setup:   POST /ai/setup (schema + prompt → auto-deploy)`);
  console.log(`  AI Scenario: POST /ai/scenario (apply failure scenarios to Microcks)`);
  console.log(`  AI Key:     ${AI_API_KEY ? 'Configured (' + AI_MODEL + ')' : '⚠ Not set (export GROQ_API_KEY)'}`);
  console.log(`  Scoping:    Pass X-User header to isolate overrides + scenarios per person`);
  console.log('');

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
