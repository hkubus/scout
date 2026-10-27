# Scout — CLAUDE.md

This repository is `/home/kubus/Projects/apps/scout`. Treat the current working tree as user-owned and inspect `git status` before making overlapping edits.

## Current release posture

Scout is a React/Vite frontend with a Fastify + SQLite API and a scheduled marketplace monitor. The server supports internet deployment behind a TLS reverse proxy: password sign-in with server-side sessions, bearer tokens (`SCOUT_API_TOKENS`) for MCP/scripts, same-origin CSRF checks, and sign-in throttling (see README "Authentication and internet deployment"). It refuses to start without credentials when listening beyond loopback, when configured for a reverse proxy (`SCOUT_TRUST_PROXY`/`SCOUT_PUBLIC_ORIGIN`), or with `SCOUT_AUTH=on`, unless `SCOUT_AUTH=off`; without credentials it rejects proxied requests and pins the Host header. It also has secure response headers, per-IP rate limits, SQLite recovery/migration checksums, scheduler leasing, bounded retention, export/backup endpoints, and truthful `/api/health`/`/api/ready` probes.

Research watches use immutable criteria versions, bounded detail checks, price refreshes when a missing listing is live, connector backoff, paginated history, and in-flight version checks. Archived ordinary watches are available through the Watches archive filter.

## Verification

Run the following from this directory:

```bash
npm run typecheck   # ~4 s
npm test            # ~5 s, 350 tests
npm run build       # ~7 s
npm audit --omit=dev
```

While iterating, run `npm run typecheck` and only the affected test files (`node --import tsx --test tests/flips.test.ts`); run the full `npm test` and `npm run build` once before finishing. `npm audit` hits the network, so run it only when dependencies change. Run each step as its own command rather than chaining them with `&&`: one long chain can hit the 10-minute command timeout and lose every result. If a step takes much longer than the times above, the host is loaded by other agents, not stuck; do not add sleeps or retries around it.

For a controlled local smoke test, use a temporary `SCOUT_DB_PATH`, loopback binding, a temporary `SCOUT_SECRET`, and a temporary `SCOUT_PASSWORD`/`SCOUT_API_TOKENS`; never restart the user's persistent process or delete its database without explicit direction. Docker Compose requires `SCOUT_SECRET`, and its readiness check waits for the Browserless health check.

## Inspecting live data

The running app exposes read-only database access at `/api/debug/*` (schema, table rows, read-only SQL with a 5 s limit, runtime/logs, full redacted SQLite snapshot) and as `scout_debug_*` MCP tools; see README "Debug API". It is on by default only while auth is off; an authenticated instance needs `SCOUT_DEBUG_API=true`. Use it to check real listings, scores, and scan history before changing behavior.

## Important boundaries

- Treat public marketplace prices as asking prices, not completed-sale prices.
- Authentication is single-operator by design (one password plus static API tokens). Do not propose per-user accounts or roles unless the user asks.
- Every new `/api/*` route is protected automatically by the `onRequest` auth hook in `server/index.ts`; only add paths to `publicApiPaths` if they expose no data.
- Do not commit `.env`, SQLite databases, backups, or browser storage-state files.
- Prefer `npm run build` plus `node dist-server/index.js` for production; do not run TypeScript through `tsx` in production.
