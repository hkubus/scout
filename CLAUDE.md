# Scout — CLAUDE.md

This repository is `/home/kubus/Projects/apps/scout`. Treat the current working tree as user-owned and inspect `git status` before making overlapping edits.

## Current release posture

Scout is a React/Vite frontend with a Fastify + SQLite API and a scheduled marketplace monitor. The server supports internet deployment behind a TLS reverse proxy: password sign-in with server-side sessions, bearer tokens (`SCOUT_API_TOKENS`) for MCP/scripts, same-origin CSRF checks, and sign-in throttling (see README "Authentication and internet deployment"). It refuses to listen beyond loopback without credentials unless `SCOUT_AUTH=off`. It also has secure response headers, per-IP rate limits, SQLite recovery/migration checksums, scheduler leasing, bounded retention, export/backup endpoints, and truthful `/api/health`/`/api/ready` probes.

Research watches use immutable criteria versions, bounded detail checks, price refreshes when a missing listing is live, connector backoff, paginated history, and in-flight version checks. Archived ordinary watches are available through the Watches archive filter.

## Verification

Run the following from this directory:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

For a controlled local smoke test, use a temporary `SCOUT_DB_PATH`, loopback binding, a temporary `SCOUT_SECRET`, and a temporary `SCOUT_PASSWORD`/`SCOUT_API_TOKENS`; never restart the user's persistent process or delete its database without explicit direction. Docker Compose requires `SCOUT_SECRET`, and its readiness check waits for the Browserless health check.

## Inspecting live data

The running app exposes read-only database access at `/api/debug/*` (schema, table rows, read-only SQL, runtime/logs, full redacted SQLite snapshot) and as `scout_debug_*` MCP tools; see README "Debug API". Use it to check real listings, scores, and scan history before changing behavior.

## Important boundaries

- Treat public marketplace prices as asking prices, not completed-sale prices.
- Authentication is single-operator by design (one password plus static API tokens). Do not propose per-user accounts or roles unless the user asks.
- Every new `/api/*` route is protected automatically by the `onRequest` auth hook in `server/index.ts`; only add paths to `publicApiPaths` if they expose no data.
- Do not commit `.env`, SQLite databases, backups, or browser storage-state files.
- Prefer `npm run build` plus `node dist-server/index.js` for production; do not run TypeScript through `tsx` in production.
