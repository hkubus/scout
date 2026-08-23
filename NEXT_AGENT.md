# Scout handoff

This file is the handoff for the next agent continuing work in `/home/kubus/scout`.

## Current state

Scout is a React/Vite frontend with a Fastify + SQLite API/scheduler. It is currently running:

- Frontend: http://127.0.0.1:4173 (Vite PID 710988)
- API: http://127.0.0.1:3001 (the `tsx server/index.ts` launcher/child are around PIDs 790072/790083; inspect before restarting)
- Health currently returns `status: ok`, database `ok`, scheduler `running`.
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

### Separate market research watches (latest work)

The new sidebar item is **Market research** (`market-research`). It is separate from alerting watches.

- A research watch stores a phrase, selected marketplaces, and a cadence in hours (UI defaults to 24; API allows 6–168 hours).
- Each due scan saves normalized listing snapshots and price observations in separate tables.
- Price history tracks first, latest, and lowest observed asking price.
- A listing is marked `ended` only after it is absent from three consecutive successful scans for its marketplace. The last public asking price is shown as `estimated sold`; it is not a confirmed checkout price.
- Connector failures do not mark listings missing. A successful source scan is required before missing-scan counts advance.
- Research UI supports create, pause/resume, scan now, delete, active/ended filtering, and saved listing history.
- The UI deliberately explains the estimate limitation because public pages generally do not expose final transaction prices.

Important implementation locations:

- Schema: [migrations/001_init.sql](/home/kubus/scout/migrations/001_init.sql:78)
- Types/API client: [src/types.ts](/home/kubus/scout/src/types.ts:1), [src/api.ts](/home/kubus/scout/src/api.ts:1)
- Research service/scheduler: [server/service.ts](/home/kubus/scout/server/service.ts:224)
- Research API routes: [server/index.ts](/home/kubus/scout/server/index.ts:132)
- Research UI/dialog/table: [src/App.tsx](/home/kubus/scout/src/App.tsx:1503)
- Research styles/responsive layout: [src/styles.css](/home/kubus/scout/src/styles.css:281)

## Research API

- `GET /api/market-watches` → `{ watches, listings }`
- `POST /api/market-watches` body `{ name, query, sources, intervalHours? }`
- `PATCH /api/market-watches/:id` body `{ enabled?, intervalHours? }`
- `POST /api/market-watches/:id/scan`
- `DELETE /api/market-watches/:id`

Creating a research watch schedules its first scan immediately in the background. The response can arrive before the first listing snapshot is complete; the UI refreshes through the SSE `market-watch` event.

## Verification already completed

From `/home/kubus/scout`:

```text
npm run typecheck   # passed
npm test            # 19/19 passed
npm run build       # passed
```

Unit coverage includes research table aggregation, separate persistence/cascade deletion, median ended-price estimate, and the three-missed-scan threshold. A Playwright fallback smoke test (Browser plugin unavailable) covered:

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

1. Run a controlled live research-watch smoke test with a temporary phrase, then delete it after confirming OLX/Vinted/Allegro source behavior. Avoid leaving invented user watches in the persistent database.
2. Add integration tests around `runMarketWatch` with mocked public-page HTML to prove: price updates, reappearance after a missed scan, source failure isolation, and exactly-three-misses ending.
3. Consider adding a simple price-history chart or observation drawer if the user wants deeper market analysis. Keep it within the existing table-driven design.
4. Consider moving the new research tables into a numbered migration file if the migration system grows; the current project intentionally executes the idempotent `001_init.sql` plus runtime column checks on startup.
5. Keep the sale estimate wording explicit. Do not represent disappearance or last asking price as a verified sale unless a reliable public sold-price signal is added.

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
