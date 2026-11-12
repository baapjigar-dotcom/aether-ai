# NovaOS AI v4.1 — Engineering Changelog

## Security
- Added Firebase ID-token verification to the hosted proxy using Google's published RS256 JWKs.
- Hosted origins fail closed when auth is not configured; production can disable localhost-origin access.
- Added exact origin allow-listing, request body streaming limits, payload/model/tool validation, HTTPS-only upstream validation, bounded fallback rate-limit state, and generic upstream error handling.
- Changed local offline profiles to salted PBKDF2-HMAC-SHA-256 (310k iterations), with v3 SHA-256 hash migration after a valid sign-in.

## Intelligence and data
- Replaced RAG hash-vector ranking with BM25-style lexical retrieval and phrase boosts (not neural semantic embeddings).
- Added bounded overlapping chunking, same-name document replacement, RAG index persistence, and reload hydration.
- Added prompt-injection guard language around uploaded excerpts and user-editable memory facts.
- Added a four-round cap for read/chart tool orchestration; mutation proposals stop further mutation chaining until user approval.
- Improved conversation summarization with live-model summary and extractive offline fallback.

## Reliability and maintenance
- Improved IndexedDB completion/error handling, large-value localStorage bypass, and the storage meter denominator.
- Blocked empty-ID collection-wide deletion, unscoped updates, duplicate collection overwrite, duplicate record IDs, and unsupported DB tools in the reference transaction module.
- Added RAG file size caps and updated the service worker cache version.
- Added Wrangler deployment starter, `.dev.vars.example`, `.gitignore`, and expanded regression tests.

## Verification
- `npm test` passes.
- Inline HTML script syntax and HTML parsing pass.
- No live Firebase deployment, upstream provider, or interactive browser acceptance test was performed in this build session.
