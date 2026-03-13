# WM Sports Mock Server — Demo Script

**Duration**: ~12 minutes
**Audience**: Director / management
**Live URL**: https://wmsports-mock-server.onrender.com
**Microcks**: https://microcks-uber-latest.onrender.com

---

## Pre-Demo (2 min before)

1. Open https://wmsports-mock-server.onrender.com in a browser tab — this wakes the mock server
2. Open https://microcks-uber-latest.onrender.com in a second tab — this wakes Microcks
3. Wait until the dashboard shows **"Microcks Connected"** in the green badge
4. Keep both tabs open

---

## Scene 1: The Big Picture (2 min)

### What to show
- The dashboard at https://wmsports-mock-server.onrender.com

### What to say
> "This is a single URL that mocks our entire WM Sports API surface — every GraphQL subgraph, every REST endpoint, every async event channel. Teams can develop and test against it without any backend dependencies."

### Steps
1. Point to the header bar: **"Microcks Connected"**, **14 GraphQL**, **3 REST**, **3 Event**, **442 ops**
2. Scroll the sidebar — name each section:
   - "Here are all 14 GraphQL subgraphs — StatsAPI, UserAPI, CmsAPI, and so on"
   - "Below that, 3 REST APIs — Census, Push Notifications, StatMilk"
   - "And 3 Event/Async APIs — Kafka, RabbitMQ, WebSocket"
3. Click **Mock API Routes** in the sidebar
4. Show the tables of URLs:
   > "These are the live mock endpoints. Any team can copy these URLs into their tests, curl, or Postman. The GraphQL endpoints accept standard queries, the REST endpoints match the real API paths."
5. Click **Health** in the footer
   > "There's also a health endpoint teams can use for readiness checks in CI/CD."

---

## Scene 2: GraphQL Explorer (2 min)

### What to say
> "Let me show you the GraphQL explorer. Any team can browse the schema, build queries, and test them against real mock data."

### Steps
1. Click **StatsAPI** in the sidebar
2. In the operations panel, click **getGamecastBySlug**
3. Point to the query editor:
   > "The fields are auto-populated from the schema — slug, gameDate, sport, status, jsonResponse. This matches our real supergraph."
4. Click **Run**
5. Point to the response:
   > "200 OK, and here's the mock data from Microcks — realistic values like a real game date, sport type, and status."
6. Point to the status badge and timing
7. Switch to **UserAPI** in the sidebar
8. Click **findTagByMatchTerm**
   > "This operation returns a list of Tags — notice the fields auto-populate here too: id, name, permalink, abbreviation, and so on. The explorer handles nested types like [Tag!]! correctly."

---

## Scene 3: REST API Testing (2 min)

### What to say
> "REST APIs work the same way. Let me show you how path parameters are handled."

### Steps
1. Click **Census API** in the sidebar
2. Find `GET /v3/{tenant}/push_notifications/{id}` and click **Try**
3. Point to the left panel:
   > "The path parameters are automatically substituted with real values from our examples — {tenant} becomes 'bleacherReport', {id} becomes '237'."
4. Point to the resolved URL in the editor textarea
5. Click **Run**
6. Show the 200 response:
   > "We get back a real push notification object. These are the exact same URLs and data shapes that teams use in their contract tests."
7. (Optional) Edit the URL in the textarea to change a param value, click Run again:
   > "The URL is editable — teams can change any parameter and re-run."

---

## Scene 4: AI Agent — The Key Differentiator (4 min)

### What to say
> "This is where it gets powerful. We have an AI agent powered by a large language model that can generate bad data on demand — wrong types, missing fields, boundary values — and inject it directly into Microcks. This means the mock API actually serves the bad data. Teams can test how their code handles provider regressions without touching any real service."

### 4a. Inject bad data

1. Click **StatsAPI** in sidebar, then **getGamecastBySlug**
2. From the **AI Inject** dropdown (top-right), select **"Wrong Types"**
3. Click **Inject**
4. Wait for the response (5-10 seconds — the AI generates data, then the server deletes and re-creates the service in Microcks with only the AI example)
5. Point to the response:
   > "Look at the data — slug is now a number instead of a string, gameDate is a boolean, sport is an array. Every field has the wrong type. This is exactly the kind of regression that breaks consumer code."
6. Click **Run** again:
   > "And it persists — this isn't an in-memory override. The data is in Microcks. Any team hitting this endpoint right now would get this bad data."

### 4b. Show another scenario

1. Select **"Boundary Values"** from the dropdown
2. Click **Inject**
3. Point to the response:
   > "Now we have extreme values — 200+ character strings, negative numbers, MAX_INT. We have 10 scenarios in total: wrong types, missing fields, null values, empty arrays, malformed dates, deprecated fields, extra fields, encoding issues, boundary values, and partial responses."

### 4c. Restore original data

1. Click **Clear**
2. Wait for "Original examples restored" message
3. Click **Run**
4. Point to the response:
   > "One click and the original data is back. No artifacts were permanently changed. The server deletes the service from Microcks and re-imports the original schema and examples."

---

## Scene 5: How Teams Use This (2 min)

### What to say
> "Let me tie it all together with the workflow."

### Steps
1. Click **Mock API Routes** in the sidebar
2. Walk through the workflow:
   > "Step 1: Point your tests at any of these mock URLs — they work with curl, Postman, any HTTP client, or directly in your test framework."
   >
   > "Step 2: Use the explorer to verify the data shape matches what your code expects."
   >
   > "Step 3: When you want to test edge cases — like what happens when the provider sends wrong types or removes a field — use the AI agent to inject bad data."
   >
   > "Step 4: Clear when done. The mock server is shared infrastructure."

3. Summarize the architecture:
   > "Under the hood, this is an Express server in front of Microcks. Microcks holds 442 operations imported from our real GraphQL schemas, OpenAPI specs, AsyncAPI specs, and Postman collections. The AI agent uses Groq's LLM to generate scenario-specific bad data, then does a clean delete-and-reimport cycle in Microcks so the mock API serves it natively."

---

## Key Talking Points (if asked)

| Topic | Answer |
|-------|--------|
| **Scale** | 442 operations across 20 services — GraphQL, REST, Kafka, RabbitMQ |
| **Backend dependency** | Zero. Teams develop and test without any real services running |
| **AI scenarios** | 10 built-in failure scenarios. AI generates field-specific bad data based on the actual query fields |
| **Persistence** | AI data is injected into Microcks natively (delete + reimport), not an in-memory hack |
| **Restore** | One-click restore. No permanent artifact changes |
| **Deployment** | Live on Render. Docker Compose available for local development |
| **Cost** | Render free tier + Groq free tier. No infrastructure cost currently |
| **Contract testing** | This complements Pact — Pact validates provider contracts, this mock server simulates provider failures for consumer resilience testing |

---

## Risk Mitigation During Demo

| Risk | Symptom | Recovery |
|------|---------|----------|
| Render cold start | Dashboard shows "Offline" | Wait 30-60 seconds, refresh. Both services need to wake independently |
| Microcks data loss | Queries return 404 or empty | The import script runs on server startup. Click Clear to re-import for a specific service |
| AI rate limit (Groq) | Inject returns "LLM error" | Switch to the AI Agent page, use "Generate" (preview-only) to show the capability without injecting |
| Slow response | Inject takes >15 seconds | Explain: "The AI generates the data, then the server deletes and re-creates the service in Microcks — this takes a few seconds but ensures clean state" |
