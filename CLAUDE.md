# Scout — CLAUDE.md

This repository is `/home/kubus/Projects/apps/scout`. Treat the current working tree as user-owned and inspect `git status` before making overlapping edits.

## Current release posture

Scout is a React/Vite frontend with a Fastify + SQLite API and a scheduled marketplace monitor. The server is intentionally unauthenticated for trusted LAN/VPN use, with secure response headers, per-IP rate limits, SQLite recovery/migration checksums, scheduler leasing, bounded retention, export/backup endpoints, and truthful `/api/health`/`/api/ready` probes.

Research watches use immutable criteria versions, bounded detail checks, price refreshes when a missing listing is live, connector backoff, paginated history, and in-flight version checks. Archived ordinary watches are available through the Watches archive filter.

## Verification

Run the following from this directory:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

For a controlled local smoke test, use a temporary `SCOUT_DB_PATH`, loopback binding, and a temporary `SCOUT_SECRET`; never restart the user's persistent process or delete its database without explicit direction. Docker Compose requires `SCOUT_SECRET`, and its readiness check waits for the Browserless health check.

## Inspecting live data

The running app exposes read-only database access at `/api/debug/*` (schema, table rows, read-only SQL, runtime/logs, full redacted SQLite snapshot) and as `scout_debug_*` MCP tools; see README "Debug API". Use it to check real listings, scores, and scan history before changing behavior.

## Important boundaries

- Treat public marketplace prices as asking prices, not completed-sale prices.
- Keep the API restricted to the trusted LAN/VPN; there is no built-in authentication. Missing API auth is an intentional design decision — do NOT report it as a bug, security issue, or functionality improvement.
- Do not propose adding bearer tokens, login screens, per-user auth, or API tokens unless the user explicitly reverses this decision.
- Do not commit `.env`, SQLite databases, backups, or browser storage-state files.
- Prefer `npm run build` plus `node dist-server/index.js` for production; do not run TypeScript through `tsx` in production.
