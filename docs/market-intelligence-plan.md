# Scout — Market Intelligence implementation plan

Handoff plan for an implementing agent. Written 2026-09-01 against the current tree (main @ e1d0113).
Read `NEXT_AGENT.md` and the README sections on market research and preserved copies before starting.
All line references were verified against the tree at planning time; expect drift — re-grep before editing.

## Ground rules (non-negotiable)

- **Language boundary:** Scout never claims confirmed/completed-sale prices. Everything derived from disappeared listings is a **"probable sale"** estimate. UI copy, API field names, and docs must say "probable sale" / "estimated band", never "sold price".
- **One page per source per scan.** Any new search fetches (typo variants) must respect the single-page budget (`fetchSearchPages()`, service.ts:1459-1471) and stay within connector backoff rules.
- **Deterministic scoring first.** AI output never changes price scoring. Band-based scoring changes are deterministic and gated behind explicit opt-ins (Milestone 5).
- **Migrations:** files are `migrations/NNN_description.sql`, auto-discovered and checksummed (`openDatabase()`, server/db.ts:10-155; checksum mismatch throws, db.ts:71-76). **Never edit an already-applied migration** — allocate the next number in implementation order and renumber the plan's suggestions accordingly (this plan proposes 014–016 in milestone order 2, 5, 6).
- **Verification for every milestone:** `npm run typecheck && npm test && npm run build`. Never restart the user's persistent Scout process or touch `data/scout.sqlite`; if you need a live smoke test, use a temp `SCOUT_DB_PATH`, loopback bind, and temp `SCOUT_SECRET` as NEXT_AGENT.md prescribes.

## What exists today (the parts this plan builds on)

| Concern | Where |
|---|---|
| Research (market) watches, immutable criteria versions `<watchId>:v<n>` | `market_watches`, `market_watch_versions` (migration 002); version churn in `updateMarketWatch()` service.ts:1671-1710 |
| Research listings + price observations per version | `market_listings` (`first_price_pln`/`last_price_pln`/`lowest_price_pln`, `status` active/ended/superseded, `missing_scans`, `ended_at`, `ended_reason`, `availability_status`), `market_price_observations` (`version_id`, `scan_id`, `price_pln`, `observed_at`) |
| Missing-listing verification (3-check threshold) | `marketStatusAfterMiss()` service.ts:118-121; terminal rows get `status='ended'`, `availability_status='terminal'`, `ended_reason` (service.ts:1780) |
| **Existing median estimate (crude)** | `estimatedMedianPrice` = median of `last_price_pln` of **all** ended listings, no staleness filter — service.ts:1552-1580 (`marketResearchData()`) |
| Deal scoring | `scoreDeal()` scoring.ts:21-39 (median typical, robust deviation, `qualifies` gate); deal labels service.ts:2738-2739; baseline from `watchBaseline()` service.ts:2689-2717; typical stored in `watch_listings.typical_pln` |
| Normalized connector listing | `NormalizedListing` marketplaces.ts:3-16 (marketplace, listingId, title, price, url, imageUrl?, condition?, location?, shippingAvailable?, priceNegotiable?, observedAt); image CDN identity key `imageIdentityKey()` marketplaces.ts:482 |
| Deal-watch analytics UI (the chart/band reference) | `WatchAnalyticsDialog` + `AnalyticsTrendChart` WatchesPage.tsx:411-549 (SVG, shaded p25–p75 band, median polyline); data from `GET /api/watches/:id/analytics` (index.ts:182) |
| Drawer sparkline reference | `PriceSparkline` ListingDetailDrawer.tsx:49-76, fed by `detail.history` (`PriceHistoryPoint[]`) |
| Research UI | `MarketResearchPage.tsx` — cards with Tracked/Ended/Median-estimate metrics (:232-242), saved-listings table (:270-313), snapshot modal (:315-434), `MarketWatchDialog` (:443-511, **no preset mechanism yet**) |
| Deal-watch prefill mechanism | `WatchPreset` type (Dialogs.tsx:18-28) + SearchPage "Save as watch" → App.tsx:493 `setWatchPreset` → `LazyWatchDialog preset=` (App.tsx:568); dialog state falls back to preset fields (Dialogs.tsx:44-60) |
| API conventions | Flat `/api/...` in server/index.ts, zod-validated; expensive-route rate-limit regex index.ts:54; SSE via `emit` callback (events incl. `market-watch`, `watch`) |
| Tests | `node:test` via tsx (`npm test`); integration pattern tests/service.test.ts:7-14 (tmpdir + `openDatabase` + `ScoutService` with injectable fakes) |

---

## Milestone 1 — Watch-from-listing prefill (no migration, frontend-mostly)

**Goal:** one click from any listing to a pre-filled deal watch or research watch.

1. New pure builders in `src/presets.ts`:
   - `watchPresetFromListing(listing: Listing): WatchPreset` — query from `listing.title` (strip price/location-looking tokens, collapse whitespace); `sources: [listing.marketplace]`; `location` from listing; `minPrice/maxPrice` = ±25% around `listing.price` rounded to 5; `shippingOnly: listing.shippingAvailable === true`.
   - `marketWatchInputFromListing(listing: MarketTrackedListing): MarketWatchInput` — same shape for research watches.
   - Builders are deterministic and side-effect free; never call the API to enrich.
2. Deal-watch path: add optional `onCreateWatch?: (preset: WatchPreset) => void` prop to `ListingDetailDrawer` (ListingDetailDrawer.tsx:78-86), render a "Save as watch" action near the triage section; wire in App.tsx:595-603 to the existing `setWatchPreset(preset); setShowWatchDialog(true)` flow (same as App.tsx:493).
3. Research-watch path: give `MarketWatchDialog` (MarketResearchPage.tsx:443-511) a `preset?: MarketWatchInput | null` prop and fall back to it in form-state init (copy the pattern from Dialogs.tsx:44-60). Add a row action in `MarketResearchTable` and a button in `MarketListingSnapshotModal` footer that opens the dialog with the preset. Keep the dialog's existing "changing criteria starts a new series" copy.

**Tests:** no server surface; verify via `npm run build` and manual dialog walkthrough. Keep builders deterministic and side-effect free.

**Files:** src/presets.ts (new), ListingDetailDrawer.tsx, MarketResearchPage.tsx, App.tsx.

---

## Milestone 2 — Typo-variant scanning (migration 014)

**Goal:** catch mispriced listings whose titles misspell the product.

1. Migration `014_typo_variants.sql`:
   - `ALTER TABLE watches ADD COLUMN typo_variants INTEGER NOT NULL DEFAULT 0;`
   - `ALTER TABLE market_watches ADD COLUMN typo_variants INTEGER NOT NULL DEFAULT 0;`
   - `ALTER TABLE market_watch_versions ADD COLUMN typo_variants INTEGER NOT NULL DEFAULT 0;`
2. New pure module `server/typos.ts`:
   - `typoVariants(query: string, opts?: { max?: number }): string[]` — deterministic, default `max = 3`. Operate on whitespace tokens ≥ 6 chars: adjacent transposition, single-vowel deletion, doubled-letter removal. Skip variants equal to the original or to each other; preserve Polish diacritics verbatim (do not normalize them).
   - `pickVariantBatch(variants: string[], scanOrdinal: number, max: number): string[]` — deterministic rotation so each scan fetches at most `max` variant queries without ever exceeding the one-page-per-search budget (variant set rotates across scans).
3. Scan integration:
   - Deal watches: in `runWatch()` (service.ts:2268), when `typo_variants = 1`, append `pickVariantBatch(...)` pages after the main page per source; results flow through the existing dedupe + `filterListings()` pipeline unchanged. Use a stable scan ordinal (count of `scans` rows for the watch, or watch `next_scan_at` sequence — pick one and document).
   - Research watches: read `typo_variants` from the **criteria version row** (like all other criteria, via `marketWatchVersion()` service.ts:1511). Variant listings enter `storeMarketListing()` unchanged.
   - **Criteria immutability:** add `typo_variants` to the criteria-change comparison and snapshot in `updateMarketWatch()` (service.ts:1671-1710) so toggling it on a research watch starts a new series.
4. API/types: include `typoVariants` in `Watch` (src/types.ts:155-179), the full-object payload in WatchDialog (Dialogs.tsx:92-118), PATCH patch-keys (src/api.ts:80), `MarketWatch` + `MarketWatchInput` (types.ts:244-267), and `updateMarketWatch` zod schema.
5. UI: checkbox in `WatchDialog` and `MarketWatchDialog` ("Scan typo variants — up to 2 extra searches per scan").

**Tests:** `tests/typos.test.ts` (purity, cap, no self/duplicate variants, diacritics unchanged, rotation covers all variants over k scans); criteria-version churn test in the tests/service.test.ts style (PATCH a research watch's `typoVariants` → new version row + old rows superseded).

**Files:** migrations/014, server/typos.ts (new), service.ts, index.ts (zod), types.ts, api.ts, Dialogs.tsx, MarketResearchPage.tsx; tests/typos.test.ts (new).

---

## Milestone 3 — Probable-sale price bands (no migration)

**Goal:** upgrade the existing crude `estimatedMedianPrice` into a transparent p25/median/p75 band of *probable sales*, with staleness and eligibility rules. Works retroactively on existing data.

1. New pure module `server/marketBand.ts`:
   - Input: `{ samples: Array<{ price: number; lastSeenAt: string; endedAt: string; endedReason: string | null }>; windowDays: number; now: string }`.
   - Eligibility: `endedReason` present and not `'Research criteria changed'` (superseded rows never reach this anyway — filter by `status='ended'` in SQL); price is fresh when `lastSeenAt >= endedAt − staleLimit` with `STALE_LIMIT_DAYS = 30` (a price last seen long before disappearance is a stale asking price, not a sale). Constant exported for tests.
   - Output: `{ p25, median, p75, sampleCount, eligibleCount, excludedStale, windowDays, computedAt }` with linear-interpolation percentiles (numpy-default semantics); `null` quartiles when `eligibleCount < MIN_BAND_SAMPLES = 4`.
2. Service: in `marketResearchData()` (service.ts:~1552 region), replace the raw ended-prices median with band computation per watch (and a page-level aggregate), reusing the existing `versionFilter` pattern. Attach to each `MarketWatch` payload: `saleBand: SaleBand | null`. Keep the old `estimatedMedianPrice` field for one release (frontend switches to `saleBand.median`).
3. API/types: no new route (bands ride the existing `GET /api/market-watches` payload); extend `MarketWatch` in src/types.ts:244-265 with `saleBand`.
4. UI (MarketResearchPage):
   - Card metrics strip gains a band chip: `p25 — median — p75 · N probable sales` (render `"learning"` when below MIN_BAND_SAMPLES, showing eligibleCount).
   - Tooltip copy (must-have): "Listings verified no-longer-available; their last asking price is used as a probable-sale estimate, not a confirmed sale price. Prices stale > 30 days before disappearance are excluded."
   - Page stats row: replace/augment `overallMedianPrice` with the aggregate band.
5. README: update the "Market research availability and history" section with the methodology (probable-sale definition, staleness rule, MIN_BAND_SAMPLES).

**Tests:** `tests/marketBand.test.ts` — empty input, < 4 samples, ties, staleness exclusion, superseded exclusion, percentile math vs hand-computed values. Service-level: seed ended `market_listings` + `market_price_observations` at known times in the tests/service.test.ts style and assert the payload's `saleBand`.

**Files:** server/marketBand.ts (new), service.ts, src/types.ts, src/MarketResearchPage.tsx, README.md; tests/marketBand.test.ts (new).

---

## Milestone 4 — Research trend charts (no migration)

**Goal:** visualize per-series price trend (active-market median with p25–p75 band) and probable-sale median over time.

1. Server: new `server/marketTrend.ts` with pure `bucketDailyObservations(observations, days, now)` → `MarketWatchTrendPoint[]` = `{ date, medianPrice, lowerPrice, upperPrice, listingCount }` from `market_price_observations` (per active version; reuse `pruneBefore()` scoring.ts:41 for windowing). Service method `marketWatchTrend(marketWatchId, days)` mirrors `watchAnalytics()`; include the current band median as a reference line.
2. Route: `GET /api/market-watches/:id/trend?days=90` next to the other market-watch routes (index.ts:346+). Not in the expensive rate-limit class. Shape mirrors `WatchAnalytics` (src/types.ts:196-216) → new `MarketWatchTrend` type.
3. Frontend:
   - Extract `AnalyticsTrendChart` (WatchesPage.tsx:411-461) verbatim into `src/AnalyticsTrendChart.tsx`; WatchesPage imports it — zero behavior change, one shared chart.
   - New `MarketWatchTrendDialog` on MarketResearchPage (button on each card, range selector 30/90/180 like WatchAnalyticsDialog:464): median line + shaded band + probable-sale median reference line.
   - Optional (same milestone if cheap): per-listing history endpoint `GET /api/market-listings/:id/history` (`{ points: PriceHistoryPoint[] }` from `market_price_observations`) and render the existing `PriceSparkline` (extract to `src/PriceSparkline.tsx` the same way) in the snapshot modal.
4. SSE: emit the existing `market-watch` event after a research scan so open trend dialogs refresh (App.tsx already bumps `marketRefreshKey` on it, App.tsx:212-214).

**Tests:** `tests/marketTrend.test.ts` — bucket edge cases (empty days, gaps, single observation, day-boundary TZ handling using plain ISO dates like the existing analytics).

**Files:** server/marketTrend.ts (new), service.ts, index.ts, src/AnalyticsTrendChart.tsx (extracted), src/PriceSparkline.tsx (extracted, optional), src/MarketResearchPage.tsx, src/api.ts, src/types.ts; tests/marketTrend.test.ts (new).

---

## Milestone 5 — Band integration (opt-in): deal ranking (migration 015)

**Goal:** let the user connect a deal watch to a research series so the probable-sale band seeds ranking before the watch's own history is ready. **Everything here is opt-in and off by default.**

1. Migration `015_reference_series.sql`:
   - `ALTER TABLE watches ADD COLUMN reference_market_watch_id TEXT REFERENCES market_watches(id);`
   - `ALTER TABLE watch_listings ADD COLUMN typical_source TEXT;` (`'own-history' | 'reference-band' | NULL`)
2. Scoring:
   - Extend `scoreDeal()` options (scoring.ts:21-39) with `typicalOverride?: number` (pure, tested).
   - In `storeListing()` (service.ts:2719-2741): if the watch has a reference series, the band has ≥ 4 eligible samples, and the listing's own observation count is below `BASELINE_MIN_SAMPLES` (30), pass the band median as `typicalOverride` and set `watch_listings.typical_source = 'reference-band'`; once own samples ≥ 30, own history always wins (`typical_source = 'own-history'`).
   - **Recommended (and default) semantics:** the fallback typical improves *ranking/display only* — the `qualifies` readiness gate (30 samples + 6 h, scoring.ts:37) is unchanged, so no new alerts fire earlier than today. Do not loosen the readiness gate without asking the user first.
4. API/types/UI: `referenceMarketWatchId` on `Watch` + WatchDialog select ("Use research series as fallback baseline", listing research watches) + PATCH keys; ListingTable/drawer chip "series baseline" when `typicalSource === 'reference-band'` (add to `Listing` types).

**Tests:** `typicalOverride` cases in the scoring test file; service test that a fresh listing under a reference-series watch shows `typical_source='reference-band'` and that a 30+ sample listing ignores it.

**Files:** migrations/015, scoring.ts, service.ts, index.ts, src/types.ts, src/api.ts, src/Dialogs.tsx, src/ListingTable.tsx, src/ListingDetailDrawer.tsx; scoring/service tests.

---

## Milestone 6 — Cross-source duplicate detection (migration 016)

**Goal:** detect the same physical item cross-posted on OLX / Allegro Lokalnie / Vinted and surface the cheapest alternative.

1. Migration `016_listing_duplicates.sql`:
   ```sql
   CREATE TABLE listing_duplicate_pairs (
     listing_id_a INTEGER NOT NULL REFERENCES listings(id),
     listing_id_b INTEGER NOT NULL REFERENCES listings(id),
     similarity REAL NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (listing_id_a, listing_id_b)
   );
   CREATE INDEX listing_duplicate_pairs_created ON listing_duplicate_pairs(created_at);
   ```
   Canonical order `listing_id_a < listing_id_b`.
2. New pure module `server/duplicates.ts`:
   - `normalizeTitleForMatch(title: string): string[]` — lowercase, strip diacritics (`NFD` + `\p{M}` removal), tokenize, drop marketplace stopwords ("sprzedam", "nowe", "okazja", …).
   - `similarity(a, b) -> 0..1` from: title token Jaccard, price ratio (1.0 at equal, decaying, hard cut beyond ±25%), condition equality, plus a strong boost when `imageIdentityKey()` (marketplaces.ts:482) matches (different CDNs won't match across marketplaces — treat as boost, not requirement). Threshold constant `DUPLICATE_SIMILARITY = 0.75`.
3. Materialization: `refreshDuplicatePairs()` called from `queueDue()` (service.ts:2258) daily behind a `last_duplicate_refresh` setting (copy the `last_prune` gating pattern, service.ts:2626-2645). Candidate pool = `listings` rows observed within `DUPLICATE_WINDOW_DAYS = 14`; pre-filter pairs by price overlap before title math to keep it cheap; wrap writes in `transaction()` (service.ts:309); delete pairs whose rows aged out of the window. Emit the existing `watch` SSE event afterwards so views refresh.
4. API:
   - Extend `GET /api/listing-detail` response with `duplicates: Array<{ marketplace, price, url, image, observedAt }>` (joined via pairs).
   - Add `duplicateCount` + `duplicateCheapest` (nullable) to the `GET /api/listings` row query via LEFT JOIN so the table can badge rows without N+1 requests.
5. UI: badge chip on `ListingRow` (ListingTable.tsx:82-128; follow the `decision-chip` pattern at :96-100), e.g. "2× · Vinted −50 zł"; "Cross-posted listings" section in the listing drawer with external links.
6. Optional (only if time permits, separate commit): append a "cheapest duplicate" line to notification payloads in the alert builder.

**Tests:** `tests/duplicates.test.ts` — similarity math (identical, paraphrased PL titles, price-out, image-key boost), threshold behavior; service test that `refreshDuplicatePairs()` creates and ages out pairs.

**Files:** migrations/016, server/duplicates.ts (new), service.ts, index.ts, src/types.ts, src/api.ts, src/ListingTable.tsx, src/ListingDetailDrawer.tsx; tests/duplicates.test.ts (new).

---

## Suggested order and dependencies

1 → 2 → 3 → 4 → 5 → 6. 1 and 2 are independent quick wins; 3 is the flagship and has no migration; 4 reuses the chart extracted in 4 for research and reads band output from 3; 5 depends on 3; 6 is independent of 3–5 and can be pulled earlier if desired (renumber migrations in implementation order).

Each milestone is one reviewable unit: branch per milestone, run `npm run typecheck && npm test && npm run build`, update README for user-visible behavior, and stop for user review after 3 (terminology matters to them) and after 5 (opt-in semantics).

## Open decisions logged for the user (do not resolve silently)

1. Whether the reference-band fallback may ever loosen the alert readiness gate (plan assumes: no).
2. Whether `estimatedMedianPrice` stays exposed alongside `saleBand` or is replaced in the UI (plan: keep field one release, replace UI label with "Probable-sale median").
