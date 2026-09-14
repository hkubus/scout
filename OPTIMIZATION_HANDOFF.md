# Scout optimization handoff

Performance review of the Scout codebase, completed 2026-09-01 against commit `e1d0113` (clean tree on `main`). Everything below was verified by reading the code and by running read-only queries against the live database at `data/scout.sqlite` — the numbers and query plans in this document are measured, not assumed. Read `NEXT_AGENT.md` first for posture and boundaries; this file only covers the optimization work.

## Ground rules

- The working tree is user-owned. Inspect `git status` before editing.
- Do **not** restart the user's running Scout process or write to `data/scout.sqlite` — it belongs to a live deployment. For any experiment, copy the database or use a temp `SCOUT_DB_PATH`.
- Never edit an existing file under `migrations/` — `openDatabase` (`server/db.ts:63-98`) records a SHA-256 checksum per file and refuses to start on mismatch. All schema work goes into a new `migrations/014_<name>.sql` (a `VACUUM INTO` backup is taken automatically before each migration).
- Preserve fail-closed behavior in connectors and the manual-only AI normalization posture. None of the work below should change what users see, except where a semantic change is explicitly called out in "Needs a product decision".
- Verification before declaring done: `npm run typecheck`, `npm test`, `npm run build` (see `NEXT_AGENT.md`). Existing tests live in `tests/` and cover service behavior including triggers — keep them green.

## Verified baseline (2026-09-01)

- Node `v26.7.0`, `node:sqlite` bundles SQLite **3.53.4** (`RETURNING` and everything else suggested here is supported).
- Live DB row counts: `observations` 10,569 · `listings` 791 · `watch_listings` 453 · `connector_runs` 639 · `scans` 81 · `listing_relevance` 80.
- Growth at current usage: **observations ≈ 1,190/day**, connector_runs ≈ 72/day, scans ≈ 10/day (measured over the 8.9-day window Aug 22 → Aug 31). Retention prunes operational history at 180 days (`pruneRetention`, `server/service.ts:2626`), so steady state is roughly **200k+ observation rows** even at today's modest watch count. The whole point of this work: several per-request queries and write loops scale with exactly that table.
- Current pragmas: `journal_mode=wal`, **`synchronous=2` (FULL)**, `cache_size=-2000` (2 MB), `mmap_size=0`.

---

## Work items, in recommended order

### P0-1 — WAL is running with `synchronous=FULL` (one line)

**Where:** `server/db.ts:99` sets `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;` and nothing else.

**Problem:** In WAL mode the standard pairing is `synchronous=NORMAL`: commits don't fsync (durability across process crashes is retained; only OS/power loss can lose the last commits — acceptable for this app's data). Today every commit fsyncs, and the codebase has many small per-row commits (see P0-2), so this multiplies across the whole write path.

**Fix:** `db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')`. Optionally also `PRAGMA cache_size = -16000;` (16 MB) and `PRAGMA mmap_size = 268435456;` — modest, safe wins for a dedicated app; keep them on the same line/block with a comment.

**Risk:** Near zero. Mention the durability trade-off in the commit message.

### P0-2 — Batch the per-row autocommit writes on hot loops

**Where:**
- `server/service.ts:1485` — `storeManualListing` called per listing, up to 100 individual upsert commits per manual search.
- `server/service.ts:538-610` — `filterListingsByAiRelevance` calls `saveListingRelevance` (one upsert) per listing per scan.
- `server/service.ts:2647-2667` — `enrichShipping` calls `cacheShipping` per listing.

**Problem:** Each `.run()` outside an explicit transaction is its own implicit commit. With P0-1 unfixed that's 100 fsyncs per manual search.

**Fix:** Wrap each batch in the existing `this.transaction(...)` helper (`server/service.ts:309-319`). Care: `filterListingsByAiRelevance` interleaves awaits of AI calls with DB writes — batch only the pure-DB write paths (e.g. collect results, then write the relevance rows in one transaction), don't hold a `BEGIN IMMEDIATE` open across a network call. The transaction is synchronous SQLite, so holding it during `await` would also block the single-threaded scheduler tick.

**Risk:** Low. Tests exercise these paths (`tests/service.test.ts`).

### P1-1 — `getConnectors()` scans all of `connector_runs` per call

**Where:** window-function query at `server/service.ts:1965-1971`; called from `dashboard()` (`server/service.ts:1999`), `/api/connectors`, and `readiness()` (`server/service.ts:384`, i.e. every `/api/ready` probe).

**Problem:** `COUNT(*) OVER (PARTITION BY source)`, `MAX(CASE...) OVER`, and `ROW_NUMBER() OVER` materialize the entire table — `EXPLAIN QUERY PLAN` shows three full `SCAN` co-routines. This runs on every `/api/dashboard` (the frontend refetches on ~8 distinct SSE event types, debounced at 100 ms in `src/App.tsx:195-220`) and on every readiness probe.

**Fix:** Latest row per source via the existing `connector_runs_source_latest` index (`(source, started_at DESC, id DESC)`, migration 011). Either 5 tiny indexed lookups (one per entry of `connectorDefinitions`) or a top-1-per-source subquery (e.g. `WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC, id DESC) rn FROM connector_runs) WHERE rn = 1)` — verify the plan actually uses the index and doesn't re-scan; per-source lookups are the simplest provable option). The run count per source can be a cheap `SELECT source, COUNT(*) ... GROUP BY source` or tracked separately; do not compute it with a full-table window function.

**Risk:** Low. Output shape of `getConnectors()` must stay identical (status/detail/lastSuccess/requests/latency fields drive `src/ConnectorsPage.tsx`).

### P1-2 — `watches()` stats query aggregates the whole `observations` table per request

**Where:** `server/service.ts:975-984`. Runs on every `/api/watches`, `getWatches()` → `/api/dashboard`, `dashboard()`, and inside `listingsPage` via `knownWatches` fallback.

**Problem:** `COUNT(DISTINCT o.listing_id)` + `MIN(o.observed_at)` over every observation, plus a temp b-tree for the distinct (confirmed by plan). This is the heaviest recurring read and it re-runs per dashboard refresh; it scales with the 200k-row steady state while the answer it needs already exists in `watch_listings` (453 rows, one per watch×listing, with `first_seen_at` maintained by `storeListing`).

**Fix:** Rewrite against `watch_listings` joined to `listings`:

```sql
SELECT wl.watch_id, COUNT(*) AS samples, MIN(wl.first_seen_at) AS first_observed
FROM watch_listings wl
JOIN listings l ON l.id = wl.listing_id
JOIN watches w ON w.id = wl.watch_id
WHERE (? = 1 OR w.archived_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM listing_relevance r
    WHERE r.watch_id = wl.watch_id AND r.marketplace = l.marketplace
      AND r.listing_id = l.listing_id
      AND (r.relevance_status = 'irrelevant' OR (r.relevance_status IS NULL AND r.relevant = 0))
      AND w.ai_relevance = 1)
  AND (w.shipping_only = 0 OR l.shipping_available = 1)
  AND (w.min_price_pln IS NULL OR l.price_pln >= w.min_price_pln)
  AND (w.max_price_pln IS NULL OR l.price_pln <= w.max_price_pln)
GROUP BY wl.watch_id
```

**Risk / semantic note:** The current query filters price per **observation** (`o.price_pln`); the rewrite filters on the listing's **current** price (`l.price_pln`, kept in sync by `storeListing`'s upsert). Difference: a listing whose historical observations were in range but whose current price left the range would drop out of `samples`. This changes the readiness computation (`watchFromRow`, `server/service.ts:876-907`). This is arguably more correct ("samples = listings currently in range") but **it is a behavior change — see "Needs a product decision" before implementing.** A no-semantics-change alternative: keep the observations query but cache the result per (watch set, prune state) with a short TTL.

### P1-3 — Prepared-statement memoization on `ScoutService`

**Where:** Every method calls `this.db.prepare(sql)` per invocation; `node:sqlite` has no internal statement cache. Hot loops: `storeListing` (~7 statements per listing per scan, `server/service.ts:2719-2754`), `filterListingsByAiRelevance` (2 SELECTs + 1 upsert per listing), `storeMarketListing` (4 per listing, `server/service.ts:1808-1816`), `enrichShipping`.

**Fix:** Add a private memo on `ScoutService`:

```ts
private statements = new Map<string, any>();
private stmt(sql: string) {
  let statement = this.statements.get(sql);
  if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
  return statement;
}
```

`StatementSync` objects are reusable with fresh bindings per `.get/.all/.run` call. Mechanically replace `this.db.prepare(` with `this.stmt(` in the hot paths (start with the loops above; converting everything is fine too). Statement lifetime is tied to the single `DatabaseSync` handle, which is opened once.

**Risk:** Low. Note dynamic SQL built by string concatenation (e.g. `listingsPage` predicates, `marketResearch` filters) must NOT be cached per call-site with interpolated filters — the memo is keyed by the full SQL string, so those are naturally distinct keys, but confirm no unbounded key growth from user-influenced fragments (`q` is parameterized — verify).

### P1-4 — `storeListing` round trips + redundant observation triggers

**Where:** `server/service.ts:2719-2754`; triggers `observations_create_watch_listing` / `observations_link_watch_listing` in `migrations/002_correctness.sql`.

**Problem:** Per listing per scan: upsert `listings`, UPDATE normalization-hash reset, `SELECT id` (after upsert), upsert `watch_listings`, `SELECT` association id, INSERT observation, 1–2 UPDATEs on the observation. Additionally, `observations_link_watch_listing` fires on **every** observation insert and runs a correlated `watch_listing_id` UPDATE plus a `watch_listings` MIN/MAX UPDATE — both redundant on the current write path because `storeListing` already upserts `watch_listings` with the same timestamps and passes `association.id` explicitly. (SQLite does not skip the trigger's writes even when values don't change.)

**Fix (two parts):**
1. Use `INSERT ... ON CONFLICT ... RETURNING id` (SQLite 3.53.4 supports it; verify `node:sqlite` surfaces `RETURNING` rows via `.get()`) to eliminate both follow-up SELECTs. Fallback if awkward: after an upsert, `lastInsertRowid` on the insert result reflects the rowid for both the insert and update branches — verify with a test before relying on it.
2. For the triggers: new migrations can't alter old ones, so add `migrations/014_drop_observation_link_trigger.sql` with `DROP TRIGGER IF EXISTS observations_link_watch_listing;` (and evaluate whether `observations_create_watch_listing` is still needed — `storeListing` is the only observation-insert path in the codebase, and it pre-creates the association; grep to confirm, and check `tests/` for trigger-dependent assertions). Keep the migration checksum discipline.

**Risk:** Medium — triggers were a legacy/backfill mechanism. The `014` migration runs against existing DBs; after it, confirm a full watch scan still populates `watch_listings.first_seen_at/last_seen_at` correctly (run against a **copy** of the DB, never the live one).

### P1-5 — `watchBaseline` sorts the watch's full history per scan

**Where:** `server/service.ts:2695-2717`, executed once per watch scan inside the store transaction (`server/service.ts:2312`).

**Problem:** Plan shows `USE TEMP B-TREE FOR ORDER BY` and the planner picked `observations_watch_time (watch_id, observed_at)` instead of the purpose-built covering index `observations_watch_listing (watch_id, listing_id, observed_at, id)` added in migration 012 *specifically for this query*. The window function therefore sorts the watch's entire filtered history every scan.

**Fix:** Force the covering index with `FROM observations o INDEXED BY observations_watch_listing` (verify with `EXPLAIN QUERY PLAN` on a copy: expect the index search and no temp b-tree for the window). Also consider sourcing `firstObservedAt` from `watch_listings` (`MIN(first_seen_at)`) instead of a second full history pass.

**Risk:** Low. `INDEXED BY` makes startup fail if the index is missing — it is created by migration 012, which all existing DBs have applied (checksum-verified), so this is safe.

### P2-1 — `watchAnalytics` pulls up to 180 days of raw observations into JS

**Where:** `server/service.ts:997-1068`; the per-observation query at 1002-1011 loads every row and dedupes to last-per-listing-per-day in JS.

**Fix:** Do the daily reduction in SQL: `GROUP BY date(observed_at), listing_id` with `MAX(observed_at)` (ISO-8601 UTC strings sort correctly with `date()`), then run the existing `analyticsPriceStats` on the reduced set. This returns ~100× fewer rows; percentile math stays in JS. Keep the current WHERE semantics (relevance/shipping/price filters) identical.

**Risk:** Low-medium; `sources` aggregation uses the "current day" rows — preserve the exact definition of "latest day" (last date key in the sorted map).

### P2-2 — Notification path repeats config work per deal + serial candidate processing

**Where:**
- `notifyDeal` reads `getSetting('discord_webhook')`, `ntfyConfig()` (AES-GCM decrypt), `dailyDigestConfig()` per candidate (`server/service.ts:3011-3014`); `verifyHighPriorityDealOnce` decrypts again via `deepSeekConfig()` per candidate (`server/service.ts:695`).
- `runWatch` processes candidates strictly sequentially (`server/service.ts:2326-2330`), and each high-priority verification can cost ~12 s (marketplace fetch) + ~30 s (OpenRouter).

**Fix:** Hoist the config reads once per scan and pass them down (or memoize decrypts with a short TTL). For concurrency, process candidates with a bounded pool of 2–3 — keep it small to stay polite to marketplaces and preserve deterministic alert ordering per listing (the `descriptionVerificationInFlight` map and `messagingInFlight` guards must keep working; they already key per listing).

**Risk:** Medium. The per-channel alert sequencing (`alertState`, `latestDeliveryForAlert`, `shouldAlert`) has subtle ordering logic — parallelizing candidates must not parallelize two candidates for the **same** listing.

### P2-3 — Marketplace session decrypted on every page fetch

**Where:** `fetchPublicPage` → `readMarketplaceSession` (`server/service.ts:2517`, implementation 821-830): AES-GCM decrypt + JSON parse + validation per call. Happens for detail checks (up to 100 per research scan), shipping enrichment (8/scan), snapshot capture (8/scan), and AI verification fetches.

**Fix:** Cache the parsed `MarketplaceStorageState` in memory keyed on the encrypted row's ciphertext (or a short TTL), invalidated by `saveMarketplaceSession`/`deleteMarketplaceSession`/`setMarketplaceSessionError`.

**Risk:** Low. Errors must still mark the session row (`setMarketplaceSessionError`) on read failure.

### P2-4 — `marketResearch()` loads all ended prices twice

**Where:** `server/service.ts:1554-1557` (per-watch ended prices, always all watches) and `1575-1580` (aggregate, same rows again, optionally watch-filtered). Both feed JS medians on every market-research page load.

**Fix:** One fetch serves both: pull `market_watch_id, last_price_pln` once (respecting the watchId filter when present), build the per-watch arrays and the aggregate from it. Also note the correlated per-row `(SELECT COUNT(*) ...)` for observations at 1594-1599 — fine today, revisit if research observation counts grow.

**Risk:** Low. `estimatedMedianPrice` and `aggregates` values must be byte-identical for existing data.

### P3 — Small polish

- `filterListings` (`server/service.ts:3135-3165`): `normalize(options.location)`, `normalize(options.condition)` and the `conditionAliases` object are rebuilt per listing — hoist above the loop. Runs twice per source per scan and in manual search.
- `settings()` calls `deepSeekConfig()` twice (two decrypts) — `server/service.ts:2056-2058`.
- `openDatabase` duplicates the legacy-column ensure block — `server/db.ts:28-57` vs `125-145`; consolidate (startup-only).

---

## Needs a product decision — do NOT implement unilaterally

1. **P1-2's price-filter semantics** (per-observation vs current listing price in the `watches()` samples query). Recommend the `watch_listings` rewrite but confirm with the user first, or ship the TTL-cached no-change alternative.
2. **Observation dedup (the big structural lever).** Every scan appends an observation per listing per watch even when the price is unchanged (~288 rows/listing/day at 5-min polling), yet every consumer needs only price *changes*: the baseline uses latest-per-listing, analytics dedupes to last-per-day, history charts show changes, and liveness is already tracked by `watch_listings.last_seen_at` / `listings.last_seen_at` (updated every scan). Skipping unchanged-price inserts (optionally with a daily heartbeat row) would cut observation volume ~90–95% and shrink P1-2/P1-5/P2-1 proportionally. Changes `totalObservations`-style metrics — requires user sign-off. If approved, implement inside `storeListing` (`server/service.ts:2734`): skip the INSERT when the newest observation for `(watch_id, listing_id)` has the same price — check before insert, not after.

## Suggested execution order

P0-1 → P0-2 → P1-1 → P1-3 → P1-5 → P2-4 → P3 (all low-risk, no semantics) → pause for the user decision on P1-2 and the observation dedup → then P1-4, P2-1, P2-2, P2-3. Commit each item separately so a perf regression is bisectable.

## Re-verifying the analysis (read-only, safe)

```bash
# Row counts, pragmas, query plans — inspect a READ-ONLY copy/connection only:
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/scout.sqlite', { readOnly: true });
for (const t of ['observations','watch_listings','connector_runs']) console.log(t, db.prepare('SELECT COUNT(*) c FROM ' + t).get().c);
for (const row of db.prepare('EXPLAIN QUERY PLAN <paste any query from this doc>').all()) console.log(row.detail);
"
```

After each change, re-run the relevant `EXPLAIN QUERY PLAN` and confirm the expected plan (index search, no temp b-tree / full scans), plus `npm run typecheck && npm test && npm run build`.
