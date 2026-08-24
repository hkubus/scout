# Scout handoff

This file is the handoff for the next agent continuing work in `/home/kubus/scout`.

## Current state

Scout is a React/Vite frontend with a Fastify + SQLite API/scheduler. It is currently running:

- Frontend: http://127.0.0.1:4173 (Vite PID 710988)
- API: http://127.0.0.1:3001 (the `tsx server/index.ts` launcher/child are around PIDs 790072/790083; inspect before restarting)
- `/api/health` is lightweight liveness; `/api/ready` probes SQLite and reports scheduler age, interrupted scans, migration state, and connector degradation.
- The live database currently has no market-research watches (`GET /api/market-watches` returns empty); do not assume seeded research data exists.
- This directory is not a Git worktree. Preserve all existing files and user data.

## Features already implemented

### Main deal watches

- OLX, Allegro Lokalnie, and Vinted public-page adapters with URL/domain validation.
- OLX Chromium fallback and Vinted card parsing were fixed in earlier work.
- Shipping-only filtering, cached shipping checks, connector degradation handling, and source isolation.
- Manual cross-platform Search screen (`View = search`) with source, shipping, condition, location, included/excluded terms, and minimum/maximum price filters.
- Main watches now support persisted `minPrice`/`maxPrice` values. Their observations, baseline samples, dashboard listings, and deal scoring are scoped to those ranges.
- Existing watch price ranges can be changed from Watches → More actions → Edit price filter.

### Correctness release

The correctness release is implemented on top of the existing AI and negotiation work. It preserves the original tables and adds the numbered migration [migrations/002_correctness.sql](/home/kubus/scout/migrations/002_correctness.sql:1). The migration runner discovers sorted SQL files, applies each missing migration in its own transaction, upgrades databases already marked with `001_init`, and marks running scans interrupted on restart.

- Notification deliveries are watch-aware, claimed transactionally, retried with capped backoff, reclaimed after 15 minutes when pending, and limited to five attempts. Alert state is stored per watch, listing, and channel.
- Global listing facts remain in `listings`; watch-owned baselines, deal labels, association timestamps, and observation snapshots live in `watch_listings`/`observations`. UI listings expose a marketplace key plus a unique watch association ID.
- Normal and research scans create per-source `scans` rows and commit snapshot writes atomically. AI provider failures are stored as `unknown` and remain visible instead of becoming semantic exclusions.
- Research disappearance is verified through detail pages. Only terminal checks advance the three-check threshold; live checks reset it and unknown checks do not advance it. Research criteria edits create immutable versions and supersede the old series.
- Normal watches support archive/unarchive through `PATCH /api/watches/:id`; archival hides a watch and disables scans without deleting history. `DELETE` remains permanent deletion.
- Research responses include server-side aggregates and paginated listings. `/api/health` is liveness and `/api/ready` is the internal readiness probe.

### Separate market research watches (latest work)

The new sidebar item is **Market research** (`market-research`). It is separate from alerting watches.

- A research watch stores a phrase, selected marketplaces, and a cadence in hours (UI defaults to 24; API allows 6–168 hours).
- Each due scan saves normalized listing snapshots and price observations in separate tables.
- Price history tracks first, latest, and lowest observed asking price.
- A listing is marked `no longer available` only after three verified terminal detail checks. Search absence, blocked pages, and ambiguous detail markup do not advance the count; the retained last asking price is not a confirmed checkout price.
- Connector failures do not mark listings missing. A successful source scan is required before missing-scan counts advance.
- Research UI supports create, pause/resume, scan now, delete, active/ended/previous-series filtering, and saved listing history. Criteria edits create immutable research versions; old rows are marked `superseded`.
- The UI deliberately explains the availability and estimate limitations because public pages generally do not expose final transaction prices.

Important implementation locations:

- Schema: [server/db.ts](/home/kubus/scout/server/db.ts:1), [migrations/001_init.sql](/home/kubus/scout/migrations/001_init.sql:1), [migrations/002_correctness.sql](/home/kubus/scout/migrations/002_correctness.sql:1)
- Types/API client: [src/types.ts](/home/kubus/scout/src/types.ts:1), [src/api.ts](/home/kubus/scout/src/api.ts:1)
- Research service/scheduler: [server/service.ts](/home/kubus/scout/server/service.ts:224)
- Research API routes: [server/index.ts](/home/kubus/scout/server/index.ts:132)
- Research UI/dialog/table: [src/App.tsx](/home/kubus/scout/src/App.tsx:1503)
- Research styles/responsive layout: [src/styles.css](/home/kubus/scout/src/styles.css:281)

## Research API

- `GET /api/market-watches` → `{ watches, listings, aggregates, pagination }` (supports `page`, `pageSize`, `watchId`, and `status`; watch selection uses IDs, not names)
- `POST /api/market-watches` body `{ name, query, sources, intervalHours? }`
- `PATCH /api/market-watches/:id` body `{ enabled?, intervalHours? }`
- `POST /api/market-watches/:id/scan`
- `DELETE /api/market-watches/:id`

Creating a research watch schedules its first scan immediately in the background. The response can arrive before the first listing snapshot is complete; the UI refreshes through the SSE `market-watch` event.

## Verification already completed

From `/home/kubus/scout`:

```text
npm run typecheck   # passed
npm test            # 59/59 passed
npm run build       # passed
```

Unit coverage includes migration replay/restart recovery, watch-owned listing state, archive/delete semantics, deterministic filters, AI unknowns, transactional scan records, detail-page availability verification, notification retry/deduplication, immutable research versions, complete medians, and readiness probes. A Playwright fallback smoke test (Browser plugin unavailable) covered:

- Navigate to Market research.
- Create a research watch.
- Filter to ended listings.
- Pause/resume a watch.
- Trigger scan-now.
- Check desktop rendering and 390px mobile rendering with no horizontal overflow or console errors.

Accepted dashboard concept references used for visual review:

- `/home/kubus/.codex/generated_images/01a02b16-c8fd-7a43-acd5-4c7d072037e9/exec-48d1a205-7ece-4f99-9089-312e3cab977e.png`
- `/home/kubus/.codex/generated_images/01a02b16-c8fd-7a43-acd5-4c7d072037e9/exec-1783c971-b111-4b09-a94f-30728b816cf2.png`

## Suggested next work

1. If Docker Compose is available in the deployment environment, run `docker compose up -d --build` followed by `npm run test:compose`; the current environment has Docker but no Compose subcommand installed, so this gate was not runnable here.
2. If desired, run a controlled live research-watch smoke test with a temporary phrase, then delete it after confirming source behavior. Avoid leaving invented user watches in the persistent database.
3. Keep the sale estimate wording explicit. Do not represent disappearance or last asking price as a verified sale unless a reliable public sold-price signal is added.

## Safe continuation commands

```bash
cd /home/kubus/scout
npm run typecheck
npm test
npm run build
curl -sS http://127.0.0.1:3001/api/health
curl -sS http://127.0.0.1:3001/api/market-watches
```

When restarting the API, inspect the process tree first because `npm run start` leaves a launcher and a child `tsx` process. Do not kill the Vite process unless intentionally restarting the frontend.
