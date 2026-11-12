# NovaOS AI — v4.1 Hardened Workspace Build

NovaOS AI is a browser-based AI workspace that combines streaming chat, approval-gated database tools, local document retrieval, multi-model comparison, voice input/output, and IndexedDB persistence.

This build is an engineering upgrade to the supplied v3 project. It intentionally preserves the existing UI and adds stronger retrieval, storage, tool execution, memory summarization, and proxy protections.

## Run locally

```bash
npm test
npm start
```

Open `http://localhost:8000`. Configure an OpenAI-compatible endpoint and API key in Settings to use a live model. Without a key, the app runs its clearly simulated demo experience.

## Live API options

### Direct provider connection

Enter the provider endpoint, model, and API key in Settings. This is convenient for local experiments, but the key is stored in browser-managed app configuration. Do not use this mode on a shared or public deployment.

### Server-side proxy (recommended for hosted use)

Deploy `server/proxy.js` as an edge/serverless handler and configure these environment variables:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Required upstream provider key; server-side only |
| `UPSTREAM_LLM_URL` | Optional OpenAI-compatible upstream URL; HTTPS required except localhost development |
| `ALLOWED_ORIGINS` | Comma-separated exact production origins; wildcard is rejected |
| `FIREBASE_PROJECT_ID` | Firebase project ID used to verify Firebase Auth ID tokens |
| `ALLOWED_MODELS` | Optional comma-separated model allow-list |
| `DEFAULT_MODEL` | Optional default model |
| `MAX_TOKENS_CAP` | Maximum output token request; defaults to 2048 |
| `RATE_LIMIT_PER_MIN` | Fallback per-instance rate limit; defaults to 30 |
| `RATE_LIMITER` | Optional distributed rate-limit binding (platform-specific) |
| `REQUIRE_FIREBASE_AUTH` | Set `true` to require Firebase auth even on localhost; `false` only for controlled testing |
| `ENVIRONMENT` | Set to `production` to disable the localhost-origin development exception |
| `ALLOW_LOCAL_ORIGINS` | Set to `false` to disable localhost origins explicitly |

For non-localhost origins, the proxy requires a valid Firebase Authentication ID token by default. The browser obtains this token from the active Firebase Auth session and sends it to the proxy; the proxy verifies its signature and project claims using Google's published signing keys. Configure Firebase in NovaOS Settings, sign in with Firebase, and enable **Authenticate this endpoint with Firebase** in the API settings. A local offline profile is not a server-verifiable identity.

A `wrangler.toml` starter is included. Edit its `ALLOWED_ORIGINS` and `FIREBASE_PROJECT_ID`, then set the upstream key as a Worker secret:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
```

For local Worker testing, copy `.dev.vars.example` to `.dev.vars` and add your own values. `.dev.vars` is ignored by Git.

Localhost origins are allowed without Firebase auth for development. Set `ENVIRONMENT=production` (and preferably `ALLOW_LOCAL_ORIGINS=false`) on deployment to disable that exception. Do not expose the local-development exception as a production endpoint. Requests without an Origin header are rejected unless `ALLOW_NO_ORIGIN=true` is explicitly set. CORS is not authentication; production Firebase token verification is the authentication boundary.

**Important:** `FIREBASE_PROJECT_ID` on the proxy must exactly match the Firebase project configured in the browser. Firebase web configuration values are identifiers, not server secrets. Never place the upstream LLM API key in `config.js`, `firebase-config.js`, or a committed file.

## What changed in v4.1

1. **Proxy authentication and hardening**
   - Verifies Firebase Auth ID-token signatures (RS256), issuer, audience, subject, expiry, issue time, and auth time.
   - Hosted origins fail closed unless Firebase proxy auth is configured.
   - Rejects missing/unapproved origins by default and rejects wildcard CORS.
   - Validates request shape, limits request size, messages, tool definitions, model identifiers, temperature, and output token budget.
   - Restricts upstream URLs to HTTPS (HTTP is accepted only for localhost development) to reduce SSRF risk.
   - Supports a platform-provided distributed rate limiter; the in-memory fallback is explicitly best-effort per instance.
   - Avoids returning detailed upstream exception strings to clients.

2. **RAG retrieval and persistence**
   - Replaces the misleading 128-dimensional hash-vector description with BM25-style lexical ranking, inverse document frequency, and phrase/match boosts.
   - Splits long files into bounded overlapping chunks instead of truncating each paragraph to 600 characters.
   - Persists parsed document chunks in IndexedDB and rehydrates them when the app starts.
   - Re-uploading a file with the same name replaces its prior index instead of duplicating it.
   - Upload size is capped at 12 MB per document and 5 MB per image; PDF parsing remains capped at 25 pages.
   - RAG excerpts and editable memory facts are explicitly marked as untrusted/context data, not instructions.
   - This is still lexical search, not neural semantic embeddings. Add a real embedding model/provider for concept-level semantic retrieval.

3. **Multi-round tool orchestration**
   - Supports up to four read/chart tool rounds in a single turn.
   - Supplies tool outputs back to the model and lets it continue with another read-only tool call.
   - Stops the chain when a mutation proposal is created; a mutation is never auto-approved or chained into another mutation.
   - Preserves the approval diff workflow.

4. **Database safeguards**
   - The reference transaction module now rejects unscoped updates, empty-ID deletes, duplicate collection creation, duplicate record IDs, and unsupported tools.
   - The in-app tool validation refuses to overwrite an existing collection and filters unsafe/protected record fields.

5. **Storage reliability**
   - IndexedDB writes expose completion/failure via promises and transaction events.
   - Large values (including RAG indexes) bypass the small localStorage compatibility cache.
   - The visible storage meter now uses the same 250 MB denominator that its label advertises.
   - Version-change handling closes stale database connections.

6. **Conversation memory**
   - “Summarize Old Turns” now requests a grounded AI summary when live mode is configured.
   - When offline/demo mode is active, it falls back to extractive sentence selection rather than inserting a generic, fabricated placeholder.
   - The latest two messages remain intact.

7. **Local profile password storage**
   - New device-local profiles use a random salt and PBKDF2-HMAC-SHA-256 (310,000 iterations) rather than a fast unsalted hash.
   - Existing v3 SHA-256 local password hashes are upgraded on successful sign-in.
   - The local profile remains a browser convenience feature, not production identity or a substitute for Firebase Auth.

8. **Tests**
   - Added coverage for safe DB operations, long-file chunking, RAG rehydration, hosted-origin auth, Firebase token verification, model allow-list, input validation, upstream URL restrictions, and rate limiting.

## Project structure

- `index.html` — main workspace and client-side application logic
- `config.js` — optional default LLM settings (do not commit real keys)
- `firebase-config.js` — Firebase web app configuration
- `manifest.json`, `sw.js` — PWA metadata and service worker
- `modules/db-tools.js` — testable approval-gated transaction manager
- `modules/rag-engine.js` — testable BM25-style local retrieval engine
- `modules/storage.js` — standalone IndexedDB key/value engine reference
- `server/proxy.js` — hardened Cloudflare Worker-style provider proxy
- `wrangler.toml`, `.dev.vars.example`, `.gitignore` — deployment starter and secret hygiene
- `tests/*.test.js` — Node.js regression/security tests

The main HTML still contains its own inline browser implementation for compatibility with the current no-build setup. The modules are separately tested reference implementations; they are not automatically imported into the page.

## Current limitations / next engineering steps

- BM25 is keyword retrieval, not semantic embedding search; a true embedding endpoint and reranker remain future work.
- The fallback in-memory rate limiter is per runtime instance. Use a platform-distributed rate-limiting binding for production scale.
- The local account vault is a convenience profile mechanism, not production authentication. Use Firebase Auth for any hosted setup.
- Direct provider mode stores a key in browser-managed storage. Use the proxy for shared/public deployments.
- End-to-end browser tests against real Firebase and a deployed upstream provider are not part of the local Node test suite.
- The app is still a single large HTML entry point. A future migration to a modular TypeScript frontend and API backend would improve maintainability.
