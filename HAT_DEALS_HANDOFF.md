# Scout handoff: deal finding for hat

This is the work Scout needs so that hat's agent can find great second-hand deals quickly. It was written on 2026-09-30 against local `main` = `8835b01` in `/root/scout`, which was a clean tree when I started.

Everything below was checked in one of three ways:

- by reading the code at that commit;
- by running Scout's typecheck and test suite;
- by throwaway probe scripts in `/tmp` against temp databases.

I changed no Scout file except creating this one.

**Someone else is editing this tree.** While I was writing, uncommitted edits by someone else appeared across `server/` (`index.ts`, `marketplaces.ts`, `service.ts`), `src/`, `ios/` and `tests/`. They include a `listing-actions` patch API and structured condition parsing, and they were still growing. Do not overwrite them. **Every line number here is for the commit `8835b01`**, as `git show 8835b01:<file>` prints it, not for the working tree; see "Line offsets on origin/main" below. Read `CLAUDE.md` first for posture and boundaries. This file covers only the deal-finding work.

**What hat is.** hat (`/root/hat`) is the user's agent platform. Its new `deal_hunt` tool is `/root/hat/packages/server/src/tools/deals.ts`, which is uncommitted in hat's working tree as of this writing. It calls Scout over MCP in three ways:

- `scout_search`, once per phrasing of the product, several calls in parallel;
- `scout_price_reference`, which does not exist yet and is optional;
- `scout_listing_detail`, which it tells the model to use to check the top picks.

The contract hat consumes is authoritative, and it is restated exactly in "Interop with hat" at the end. hat already detects new Scout inputs from the tool's JSON Schema. So every item here can ship without a hat release, as long as it stays backward compatible.

## Ground rules

- **The working tree is user-owned** (CLAUDE.md). Run `git status` before editing.
  - CLAUDE.md names the repo `/home/kubus/Projects/apps/scout`; this checkout is `/root/scout`.
- **Local `main` is 2 commits behind `origin/main` (`bb2193c`).** Those commits are "Automatically generate model variant groups". They add:
  - `migrations/027_auto_variant_groups.sql`;
  - `suggestWatchVariantGroups`;
  - `POST /api/watches/:id/variant-suggestions`.

  Get the user's OK before pulling or rebasing, then build on top of `origin/main`.
- **Do not restart the user's running Scout, and do not write to its database** (CLAUDE.md: "never restart the user's persistent process or delete its database without explicit direction").
  - The live instance `https://scout.internal.gaycats.ovh` is production. Do not run scans, searches or writes against it.
  - For experiments, use a temp `SCOUT_DB_PATH`, loopback binding, and a temp `SCOUT_SECRET` and `SCOUT_PASSWORD`/`SCOUT_API_TOKENS` (CLAUDE.md). Otherwise, use a copy of a database.
  - `SCOUT_SKIP_MIGRATION_BACKUP=true` skips the `VACUUM INTO` backups on throwaway databases (`server/db.ts:95`).
  - Inspect live data only through the read-only Debug API, and only if it is enabled (CLAUDE.md "Inspecting live data").
- **Add new migrations only.**
  - `openDatabase` records a SHA-256 per migration file and throws `Migration checksum mismatch` if an applied file changes (`server/db.ts:78-89`).
  - The next free number is **028** once rebased. 027 looks free on local HEAD but is taken on `origin/main`, so do not use it.
  - Every new migration must also be added to the list assertion in `tests/service.test.ts:1089` (`:1091` on origin/main).
- **Connectors fail closed.**
  - Non-2xx responses and unrecognized markup are errors, never empty pages (`server/marketplaces.ts:33`, `:743-745`, `:831`).
  - Bot fences are never bypassed (`:744-745`, `:1045`).
  - Keep today's AI semantics: relevance is fail-open (an unknown result keeps the listing), and the near-miss rescue is fail-closed (an error keeps the drop).
- **Outputs change additively only.**
  - Default MCP outputs stay exactly as today; new behaviour sits behind new optional inputs.
  - REST `/api/search`, `/api/listings` and `Listing` may only gain optional fields. The iOS app decodes them with Codable, and its non-optional fields (`observed`, `observedAt`, `dealStrength`, `dealLabel`, `image`, `url`, `watch`, `subtitle`, and on `SearchSourceStatus` all six fields) must stay. See `ios/ScoutKit/Sources/ScoutKit/Models.swift:53-100` and `:457-483`.
  - The web app and iOS only special-case `status === "error"` (`src/SearchPage.tsx:172`, `ios/Scout/SearchView.swift:175`).
- **CLAUDE.md boundaries:**
  - Marketplace prices are asking prices, not sale prices; label outputs that way.
  - Auth is single-operator.
  - New `/api/*` routes, and `/mcp`, are protected automatically (`server/auth.ts:128-131`, hook at `server/index.ts:151-185`).
  - Add a path to `publicApiPaths` only if it exposes no data.
- **Commit each work item separately.**
- **Verification** (CLAUDE.md): `npm run typecheck && npm test && npm run build && npm audit --omit=dev`.

## Verified baseline (2026-09-30)

**Toolchain.** Node `v24.21.0` on this host (`engines` asks for `>=22.5.0`), `@modelcontextprotocol/sdk` 1.31.0, and zod 3.25.76.

**Checks on local HEAD `8835b01`.**

- `npm run typecheck` is clean.
- `npm test` passes 231/231 in about 9 s.
- I did not run `npm run build` or `npm audit`. The build writes `dist/`, `dist-server/` and `tsconfig.tsbuildinfo` into the user's tree, and the audit needs the network. Run both in your own verification.

**Data.**

- `data/scout.sqlite`, read from a copy, is an empty dev database: 0 watches, listings and observations, with 22 migrations applied (through `022`). It gives no real numbers.
- The live instance answers `GET /api/health` with 200 `{"status":"ok"}` behind `Server: openresty`.
- Auth is on there, so I made no MCP calls and used no token.

**MCP transport** (read in code).

- It is stateless Streamable HTTP: `POST /mcp` builds a fresh `McpServer` and transport per request (`server/index.ts:834-852`). `GET` and `DELETE` return 405 (`:855-856`).
- It registers 12 tools (`server/mcp.ts:20-33`). 4 more `scout_debug_*` tools are added only when the Debug API is on (`server/debug.ts:38-43`: off by default when auth is on).
- Output goes through `text()`, which is pretty-printed JSON (`server/mcp.ts:9-11`). Errors are `{"error": "..."}` with `isError` (`:13-18`). There is no `outputSchema` or `structuredContent`.

**SDK schema probe** (a throwaway script in `/tmp` using Scout's installed SDK). A zod raw shape is advertised as follows:

- `sources: z.array(z.enum([...])).min(1).max(3)` becomes `{"type":"array","items":{"type":"string","enum":["OLX","Allegro Lokalnie","Vinted"]},"minItems":1,"maxItems":3}`.
- `z.boolean().optional().default(false)` becomes `{"type":"boolean","default":false}`.
- `z.enum(['full','compact']).optional().default('full')` becomes `{"type":"string","enum":["full","compact"],"default":"full"}`.
- Schemas carry `"additionalProperties": false`.
- Handlers receive `extra.signal`, an `AbortSignal`.

This is exactly what hat's schema detection reads.

**Cancellation** (read in the SDK and in hat).

- The SDK aborts every in-flight handler's `extra.signal` when its transport closes (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:248-262`, controller created at `:314-318`).
- Scout closes the transport when the HTTP response closes (`server/index.ts:838-841`). So a client disconnect does reach `extra.signal`.
- **hat's Stop does not disconnect.** It sends `notifications/cancelled` as a separate POST (`/root/hat/packages/mcp/src/jsonrpc.ts:67-72`), which a stateless server cannot match to a request id. The original POST stays open until Scout answers.
- So Scout must bound its own work (P0-3).

**Probes** (throwaway scripts in `/tmp`, temp databases, stubbed fetchers):

1. **The manual-search relaxed fallback never fires.** The query `iphone 13 pro max 512gb czarny` against an OLX row titled `iPhone 13 Pro Max 256` returns `[]`, "No matching listings". `filterListings(..., {relaxTerms: true})` keeps that row on its own.
2. **`aiRelevance: false` still runs the Jev near-miss rescue.** With live Jev, one such search made 2 `classifyTermMatchWithJev` calls.
3. **Polish or free-text conditions drop everything.** With the condition filter, over rows labelled `Używane`, `Nowe` and `Uszkodzone`:
   - `używany`, `nowy`, `like new` and `bardzo dobry` keep none of them;
   - `used` keeps `Używane` **and** `Uszkodzone`;
   - `new` keeps `Nowe`.
4. **The typo generator is weak.**
   - `playstation 5` gives `["lpaystation 5","palystation 5","plyastation 5"]`.
   - `iphone 13` gives 8 variants, and the realistic `iphon 13` comes last, so with max 3 it is never searched.
   - `gtx 1660 super` and `rtx 3080` give `[]`.
   - `sony wh-1000xm5` gives `["sony hw-1000xm5","sony w-h1000xm5","sony wh1-000xm5"]`.
5. **Filtering a misspelled title.** `filterListings(['Plystation 5 okazja'], 'playstation 5')` drops the row, but it passes against its own spelling `plystation 5`.
6. **`normalizeFilterText` turns `ł` into a space.** `"Łódź złom"` becomes `"odz z om"` (`server/text.ts:8`).
7. **JSON size of one manual-search row:** 619 B pretty-printed, 457 B minified, and 391 B in the compact shape proposed below.

**hat facts (read in code):**

- The client negotiates protocol `2024-11-05` (`/root/hat/packages/mcp/src/mcp.ts:66`).
- The tool-call timeout is 10 min (`:69`).
- It reads only text and image content (`/root/hat/packages/mcp/src/plugin.ts:125-143`).
- A tool runs without asking when `readOnlyHint === true && destructiveHint !== true` (`:150-153`).
- Tools are listed once, when hat's MCP plugin activates. **After deploying Scout changes, reload hat's MCP plugin, or restart hat, so it sees the new tools and inputs.**

### Line offsets on origin/main (`bb2193c`)

These files are identical on both commits, so their line numbers hold after a rebase: `server/mcp.ts`, `server/marketplaces.ts`, `server/scoring.ts`, `server/typos.ts`, `server/text.ts`, `server/marketBand.ts`, `server/limiter.ts`. `assignVariant` also stays at `server/variants.ts:88`.

| Anchor | local `8835b01` | `origin/main` |
|---|---|---|
| `service.ts` `activeManualSearches` | 538 | 540 |
| `service.ts` `filterListingsByAiRelevance` / `fuzzyRescueForSearch` | 1193 / 1502 | 1196 / 1505 |
| `service.ts` `watchFromRow` / `listingFromRow` / `watches()` | 1943 / 2020 / 2091 | 1946 / 2024 / 2095 |
| `service.ts` `listingsPage` / `listingDetail` / `manualSearch` | 2505 / 2563 / 2724 | 2583 / 2641 / 2802 |
| `service.ts` `referenceBandMedian` / `runMarketWatch` / `dashboard` / `runWatch` | 2954 / 3095 / 3418 / 3687 | 3032 / 3173 / 3496 / 3765 |
| `service.ts` `watchBaselines` / `dealScore` / `storeListing` | 4246 / 4296 / 4312 | 4329 / 4379 / 4395 |
| `service.ts` `queryTokens` / `termMatches` / `filterListings` | 4825 / 4848 / 4901 | 4908 / 4931 / 4984 |
| `index.ts` `const expensive` / `searchInput` / `app.post('/mcp'` | 115 / 540 / 834 | 116 / 562 / 856 |
| `tests/service.test.ts` migration list / `seedVariantWatch` | 1089 / 2524 | 1091 / 2526 |

**What rebasing changes for this work.** On origin/main, watches without groups get model-variant groups automatically once enough listings are saved (`variant_groups_auto`). So the variant path of P0-4 becomes the common path, not an edge case.

---

## Work items, in recommended order

The ranking weighs impact on "finding great deals quickly" against effort. P0 items are either consumed by hat already (it switches on when Scout advertises them) or are small correctness fixes that change what a hunt finds. Each item is one commit.

### P0-1: Search correctness quick fixes (small; more matches, less waste)

**Where:**

- **Relaxed fallback.** `server/service.ts:2735` computes `comparable` with the strict all-terms filter. `:2739` then runs the relaxed retry (`relaxTerms: true`) over `comparable`, which already passed the strict filter. If the strict pass found nothing, `comparable` is empty. So the majority-of-tokens fallback that `filterListings` implements (`:4915-4919`, unit-tested in `tests/marketplaces.test.ts:735-738`) can never add a row to a manual search. Probe 1 confirms this.
- **Rescue ignores `aiRelevance: false`.** `server/service.ts:2743-2759` calls `fuzzyRescueForSearch` no matter what `input.aiRelevance` is. The comment at `:2760-2766` and `README.md:170` both say the checkbox skips "the Jev relevance and rescue calls entirely". Probe 2 confirms the rescue still runs.
- **Condition.** `matchesRequestedCondition` (`server/service.ts:4866-4872`) understands only `any`, `new`, `used` and its alias table.
  - The marketplaces map only `new`/`used`: OLX at `server/marketplaces.ts:767-768`, Vinted at `:102-107`, and Lokalnie only `new` at `:135`.
  - hat forwards the model's free-text `condition` as-is, so Polish input empties the result (probe 3).
- **MCP input checks.** `scout_search`'s schema (`server/mcp.ts:147-160`) lacks the `minPrice <= maxPrice` check that REST has (`server/index.ts:554`), and it does not dedupe `sources`.
- **Dashboard wording.** The `scout_dashboard` description promises "Strong+ deal counters" (`server/mcp.ts:56`). But `stats.strongDeals` counts `dealStrength >= 4`, which is Very strong and up (`server/service.ts:3429`).

**Fix:**

1. **Relaxed fallback.** Pass `relaxTerms: true` in the first (`comparable`) call so the fallback runs against `fetched`. The second call then only adds the shipping filter.
   - Record whether the relaxed pass was used; P0-2 reports it per listing as `match: "relaxed"`.
   - Also leave already-kept keys out of the rescue pool, so the rescue does not spend Jev on relaxed matches (the rescue pool in `fuzzyRescueForSearch`, `:1513`).
2. **Rescue opt-out.** Run the rescue only when `input.aiRelevance !== false`.
3. **Condition synonyms.** Add a `normalizeRequestedCondition()` used by `manualSearch` before filtering and URL building:
   - `nowy|nowa|nowe|new` becomes `new`;
   - `używany|używana|używane|uzywany…|used` becomes `used`;
   - `any|dowolny|wszystkie|''` becomes `Any`.

   Keep other strings as they are for now (see the decision below).
4. **MCP input checks.** The handler returns `toolError('Minimum price cannot exceed maximum price')` when both prices are set and inverted. A raw zod shape cannot `.refine()`, so the check goes in the handler. Dedupe `sources` with `[...new Set(input.sources)]`.
5. **Wording.** Change the dashboard description to "Very strong+ deal counters". Changing the count instead would alter the UI and iOS stats.

**Contract:** none new. The output shape is unchanged; only the result sets change.

**Tests** (`tests/service.test.ts`; stub `(service as any).fetchOlxApi` as in the test at `:872-892`, or with `olxListings()` at `:2544`):

- **Relaxed match.** A query of `iphone 13 pro max 512gb czarny` against `iPhone 13 Pro Max 256` returns that row. A query whose tokens all match still returns only the strict rows. Explicit `terms` never relax.
- **Rescue opt-out.** Under `liveJevEnv()` (`:1763`) with `aiRelevance: false`, `classifyTermMatchWithJev` is called 0 times. With `aiRelevance: true` it is called at least once.
- **Condition.** `używany` keeps an `Używane` row, and the OLX request URL contains `filter_enum_state%5B0%5D=used`.
- **MCP checks** (`tests/mcp.test.ts`): `minPrice > maxPrice` gives `isError` with the message, and duplicate `sources` search once.

**Risks / needs a product decision:**

- The relaxed fallback now really runs, so a hunt can return looser matches when nothing matches strictly. That is what `README.md:93` already promises.
- `condition: "used"` still keeps `Uszkodzone` (damaged) listings. Decide whether `used` should exclude `Uszkodzone`. P1-2 at least flags them.
- Unknown condition strings, such as `bardzo dobry` outside the alias table, still act as a substring filter. Decide between that and mapping unknown strings to `Any` with a note.

### P0-2: Compact, stable, structured `scout_search` output (small to medium; hat already asks for it)

**Where:**

- Output is `text(await service.manualSearch(input))`, pretty-printed (`server/mcp.ts:9-11`, `:162-164`).
- Rows are built at `server/service.ts:2790-2796`:
  - `typical`, `belowTypical`, `observed: 'just now'`, `dealStrength: 1`, `dealLabel: 'Watch'` and `watch: 'Manual search'` are constants or null;
  - `listingId` and `marketplaceListingKey` are missing;
  - `observedAt` is the OLX posting time (`server/marketplaces.ts:825`) but the fetch time for Lokalnie and Vinted (`:210`).
- A listing's AI relevance verdict exists internally (`classified`, `server/service.ts:1246`, `:1356-1363`) but is not returned. So "unknown" rows are indistinguishable from approved ones.
- Per-source status is `{source, status, count, pendingShipping, durationMs, message}` (`src/types.ts:335-343`). There is no machine-readable error kind.
- OLX `last_refresh_time` and `description` are present in the search API (see `tests/fixtures-olx-api.json`), but `parseOlxOffer` drops them (`server/marketplaces.ts:802-827`).

**Fix:**

1. **New input** on `scout_search`: `format: z.enum(['full','compact']).optional().default('full')`.
   - `full` is byte-for-byte today's shape.
   - hat sends `format: "compact"` on every call once the enum advertises it.
2. **Keep REST unchanged.** Keep `manualSearch(input)` as it is for REST. Add `manualSearchDetailed(input, options)`, which returns the same `ManualSearchResponse` plus two side tables:
   - per listing: `listingId`, `postedAt`, `refreshedAt`, `relevance`, `match`, `matchedVia`, `flags`;
   - per source: `fetched`, `matched`, `aiExcluded`, `aiUnknown`, `aiBudgetExhausted`, `returned`, `truncated`, `errorKind`, `path`.

   Extend `RelevanceFilterResult` (`server/service.ts:25-33`) with a per-key status map and a budget-exhausted counter (the branch at `:1305-1308`). Pass an `onPath` reporter into `fetchSearchPages` at `:2733`.
3. **OLX fields.** Add optional `postedAt` and `refreshedAt` to `NormalizedListing` (`server/marketplaces.ts:3-16`). Set them in `parseOlxOffer` from `created_time` and `last_refresh_time`. Keep `observedAt` as it is.
4. **Formatter.** Put a pure formatter `toCompactSearch(...)` in a new `server/mcpFormat.ts`. Serialize compact output with `JSON.stringify(payload)`, with no indentation.
   - Also drop indentation in `text()` for every tool. JSON clients do not care, and the sample row shrinks from 619 B to 457 B.
5. **Error kinds.** Classify source errors into `errorKind`:
   - `timeout` for `timed out` or `closed before completing`;
   - `blocked` for HTTP 401, 403 or 429;
   - `http` for other `HTTP \d{3}`, `returned \d{3}`;
   - `parse` for `no usable markup`, `no supported listing` or `did not contain`;
   - `redirect`, `session`, and later `deadline` and `backoff` (P0-3, P2-6);
   - `unknown` for anything else.

   Messages to match are in `server/marketplaces.ts:415-419`, `:836`, `:890`, `:1126`, `:1193-1205` and `server/service.ts` near `:425`, `:436`, `:3897`, `:4062`. A typed error class at the throw sites is better long-term; regex classification is fine for v1.

**Contract** (hat reads these fields; none may be removed or retyped):

```json
{"schemaVersion":1,"format":"compact","query":"13 128gb","page":1,
 "listings":[{"id":"OLX:1092728340","listingId":"1092728340","source":"OLX","title":"Iphon 13 128GB 100% Baterii Black",
   "price":800,"shipping":null,"shippingAvailable":true,
   "url":"https://www.olx.pl/d/oferta/iphon-13-128gb-100-baterii-black-CID99-ID1bVYyE.html",
   "sellerType":null,"condition":"Używane","location":"Małopolskie, Łapanów","negotiable":false,
   "postedAt":"2026-08-20T19:40:08+02:00","refreshedAt":"2026-08-31T16:51:09+02:00",
   "relevance":"not-checked","match":"strict","matchedVia":"query","flags":[]}],
 "sources":[{"source":"OLX","status":"ok","errorKind":null,"message":"1 matches","fetched":1,"matched":1,
   "returned":1,"aiExcluded":0,"aiUnknown":0,"aiBudgetExhausted":0,"truncated":false,"pendingShipping":0,"durationMs":12}]}
```

- **Every key is always present, with `null` when unknown.**
  - `id` stays `"<Marketplace>:<listingId>"`. hat uses it for dedupe and as the `scout_listing_detail` key.
  - `price` is a number in PLN.
  - `shipping` is a number of PLN or `null`; no marketplace delivery cost is parsed today, so it is always `null` for now.
  - `sellerType` is `"private"`, `"business"` or `null`. Set it only when the OLX `ownerType` filter was used. The OLX API seller field is unverified (`tests/fixtures-olx-api.json` has none).
  - `relevance` is `relevant`, `unknown` or `not-checked` (AI off or not configured). Irrelevant rows are still dropped.
  - `match` is `strict`, `relaxed` or `rescued`.
  - `matchedVia` is `query`; P1-1 adds `typo:<spelling>`.
- **`sources[].status` stays exactly `"ok"` or `"error"`.** hat treats anything but `"error"` as success. A timeout or backoff must therefore be `status: "error"` plus an `errorKind`, never a new status value.
- **No top-level `error` key on success.** hat reads any string `error` field as a failure of the whole call (`/root/hat/packages/server/src/tools/deals.ts:176`).
- The whole text content must be one JSON document.
- Listings stay sorted by price ascending (`server/service.ts:2818`).

**Tests:**

- `tests/mcp.test.ts`, compact shape:
  - Stub `fetchOlxApi` to return `tests/fixtures-olx-api.json` `.search`. Its second offer is `type: "free"` and is skipped by `parseOlxOffer`.
  - Call `scout_search` with `{query:"13 128gb", sources:["OLX"], aiRelevance:false, format:"compact"}`.
  - Assert the exact key list of the listing and the source, the values above, and that the text has no newline.
- **Default is unchanged:** the same call without `format` still returns today's keys (deepEqual on `Object.keys`).
- **hat contract test** (new `tests/hatContract.test.ts`), for every compact listing:
  - `id` matches `/^(OLX|Allegro Lokalnie|Vinted):.+/` and `title` is non-empty;
  - `price` is a number above 0 and `source` is one of the three marketplaces;
  - `shipping` is `null` or a number of at least 0; `sellerType` is `null`, `private` or `business`;
  - `shippingAvailable` and `negotiable` are booleans or `null`;
  - every `sources[].status` is `ok` or `error`, and there is no top-level `error`.
- **Service tests:**
  - More than 40 uncached listings under `liveJevEnv()` give `aiBudgetExhausted > 0` and `relevance: "unknown"` rows.
  - A throwing fetcher gives `status:"error"` with the right `errorKind`.
  - OLX has `postedAt` and Vinted has `null`.

**Risks / needs a product decision:**

- Whether `full` should also gain the new fields additively. That is safe for iOS and web; it is not needed for hat.
- Bump `schemaVersion` only for breaking changes.

### P0-3: MCP concurrency, deadline and cost controls (medium; hat runs parallel searches)

hat runs one `scout_search` per phrasing (the query plus up to 3 variants) in parallel. It caps itself at 3 in flight across the whole process, but parallel sub-agent hunts, the web UI, iOS and the model's own direct calls all share Scout.

**Where:**

- **Fourth search refused.** `manualSearch` refuses a 4th concurrent search immediately (`server/service.ts:2725`), and the counter is shared with REST, web and iOS (`:538`). The error text is `Three manual searches are already running. Try again shortly.`
  - A study probe gave 3 successes and 1 error for 4 concurrent in-memory MCP calls.
  - hat retries only errors that contain `already running`, after 2, 4 and 6 s.
- **No sharing between identical searches.** There is no single-flight or result cache. The manual relevance cache (`manual_relevance_cache`, migration 024) is written per batch of 6 (`:1346-1353`), so identical concurrent searches pay twice.
- **No deadline or cancellation.** Handlers ignore `extra`.
  - Marketplace requests time out after 12 s each (`fetchOlxApiSingleRequest(..., 12_000)` at `:3898`).
  - A Jev call can take up to 60 s × 3 attempts (`server/jev.ts:215`, `:193-201`; `server/openrouter.ts:11`).
  - Fastify `requestTimeout: 60_000` only bounds receiving the request (`server/index.ts:95`).
  - The proxy in front of live Scout is openresty; its `proxy_read_timeout` is **unverified**. The nginx default of 60 s would cut long searches.
- **Jev concurrency is per pass, not global.** Each relevance pass runs batches of `SCOUT_JEV_CONCURRENCY` (default 6, max 16; `:166-172`, `:1250`), and so does the rescue pool (`:1485`). So 3 searches × 3 sources × 6 means up to 54 Jev calls at once. The call sites are `:1036`, `:1078`, `:1095`, `:1330`, `:1440`, `:1463` and `:2264`.
- **Per-marketplace limit.** It is 2 in flight per marketplace, FIFO, shared with scans, detail checks and shipping enrichment (`:144`, `:3872-3882`; `server/limiter.ts:1-20`).
  - A manual search queues behind scan traffic, and `Limiter` has no timeout or abort.
  - `manualSearch` never checks connector backoff (`activeConnectorBackoff`, `:4774-4777`).
- **Rate limit.** Every `/mcp` POST is "expensive": 30 a minute per client IP, one bucket shared with `/api/search`, scans and so on (`server/index.ts:115-120`).
  - That covers `initialize`, `notifications/initialized`, `tools/list`, cancellations and cheap read tools. hat spends 3 POSTs per connection plus 1 per call.
  - A 429 is an HTTP error. hat shows it as a failure (`MCP server answered HTTP 429: ...`) and does not retry it.

**Fix** (in this order; each step can be its own commit):

1. **Queue instead of refusing.**
   - Replace the counter with `private readonly manualSearchSlots = new Limiter(3)`.
   - Give `Limiter.run` an options bag `{ signal?: AbortSignal; maxWaitMs?: number }`. A waiter that times out or aborts is removed from `waiting` and rejects with a typed error.
   - On timeout, throw `ServiceError('Three manual searches are already running. Try again shortly.', 429)`. **Keep that exact phrase**, because hat's retry matches `/already running/i`.
   - Default wait: 15 s (`SCOUT_MANUAL_SEARCH_QUEUE_MS`).
2. **Single-flight plus a short result cache**, in front of the slot.
   - Key: normalized `{query (case and whitespace folded), sorted and deduped sources, terms, excluded, minPrice, maxPrice, shippingOnly, normalized condition, location, ownerType, page, aiRelevance, typoVariants}`. `format`, `searchId` and `deadlineMs` are not part of the key.
   - Cache the detailed internal result, so both formats render from it. Use a TTL of 3 min and an LRU of about 50 entries.
   - Add `fromCache` and `cachedAt` to the compact output.
   - On a hit with a `searchId`, emit each source's progress event immediately (`emitSearchProgress`, `:2718-2722`).
3. **Deadline and cancellation.**
   - New MCP input `deadlineMs: z.number().int().min(5_000).max(120_000).optional()`. The MCP default comes from `SCOUT_MCP_SEARCH_DEADLINE_MS` (45 000: under a 60 s proxy read timeout, and well inside hat's 150 s hunt). REST has no default.
   - Each caller awaits the shared work with its own deadline. Sources still running when it expires are reported as `{status:"error", errorKind:"deadline", message:"Stopped after 45 s"}`, with whatever finished returned normally.
   - The shared work stops starting new phases (fetch, rescue, relevance batches) once every caller has gone or an absolute cap is hit (`SCOUT_SEARCH_MAX_MS`, 120 000). It then settles and frees its slot.
   - Pass an `AbortSignal` into `manualSearchDetailed`, and check it between phases and between relevance batches.
   - Pass the handler's `extra.signal` into it. This covers clients that disconnect, but **not hat's Stop** (see the baseline).
   - Abort-aware `Limiter` waiting keeps a stopped search from firing its queued marketplace requests later.
   - Optionally, give the Jev calls a signal-aware `fetcher`. `classifyListingRelevanceWithJev` and the others already take a third `fetcher` argument (`server/jev.ts:240-242`). Note that `isTransientFetchError` treats `AbortError` as retryable (`server/openrouter.ts:26-31`), so check the signal in the retry loop.
   - A completed result is cached, so hat's retry after a deadline, or the model's direct fallback call, gets the full answer.
4. **Global Jev limiter.** Add `private readonly jevLimiter = new Limiter(SCOUT_JEV_GLOBAL_CONCURRENCY ?? 12)` around every Jev and vision call site listed above. Per-pass pools keep their size; the global cap bounds the sum. The calls do not nest, so this cannot deadlock.
5. **Rate-limit classification.**
   - Extract the hook at `server/index.ts:102-126` into a testable `registerRateLimits(app, limiter)`, for example in `server/security.ts`.
   - For `/mcp`, `onRequest` charges only the route's general bucket (240/min). Unauthenticated floods stay bounded, and the auth hook still 401s them.
   - A route-level `preHandler` on `app.post('/mcp', ...)`, which runs after auth with the body parsed, charges the `expensive` bucket only when `mcpRateClass(request.body)` is `'expensive'`:
     - `mcpRateClass` is a pure function in the same module;
     - `'expensive'` means any JSON-RPC message (object or batch array) is a `tools/call` of `scout_search`, `scout_queue_scan`, `scout_debug_query`, or `scout_listing_detail` with `live: true` (P1-3);
     - a malformed body counts as expensive (fail closed).
   - Consider a per-token bucket for bearer requests.
6. **Document costs.** Add "Costs and limits" under `README.md` "MCP server (Streamable HTTP)" (`:176-187`):
   - **Cold `scout_search`, per source:** at most 40 Jev relevance calls (`:1219`) plus at most 10 rescue calls (`:1416`), so at most 150 for 3 sources.
   - **Warm cache:** 0 calls.
   - **`shippingOnly`:** adds up to 8 Lokalnie detail fetches (`:4192`), plus up to 10 for the rescue pool (`:1516`).
   - **`typoVariants` (P1-1):** adds up to 2 page fetches per source, drawing on the same 40-call budget.
   - **A hat hunt of 4 phrasings:** up to about 600 Jev calls cold. The relevance cache key includes the query (`server/ai.ts:181-192`), so different phrasings do not share verdicts.
   - **DB-only tools:** `scout_price_reference`, `scout_listings` and `scout_deals` cost nothing.
   - **How to measure spend on a database copy:** `SELECT task, COUNT(*) FROM jev_shadow_log WHERE note = 'live' AND created_at > ? GROUP BY task` (`logJevLive`, `:840-855`). The price per call is not in the repo.

**Contract** (hat depends on these):

- A busy or timed-out queue returns `{"error":"Three manual searches are already running. Try again shortly."}` with `isError: true`.
- A deadline gives a normal payload, with the affected sources set to `status: "error"` plus `errorKind: "deadline"`. It is never a top-level `error`.
- hat does not send `deadlineMs`, so the server default is what hat gets.

**Tests:**

- `tests/limiter.test.ts`: `maxWaitMs` rejects and does not leak a slot; `signal` removes the waiter; FIFO order is kept.
- `tests/service.test.ts`, using a `fetchOlxApi` stub gated on a promise:
  - 4 concurrent `manualSearch` calls all resolve, with at most 3 running at once. With `maxWaitMs: 10` the 4th rejects with status 429 and a message matching `/already running/`.
  - 2 concurrent identical searches make 1 fetch and get equal results. After the TTL (make it injectable) the search fetches again.
  - A never-resolving stub with `deadlineMs: 50` returns in under 200 ms with `errorKind: "deadline"`.
  - With 3 concurrent searches, the maximum in-flight `classifyListingRelevanceWithJev` calls stay at or below the global limit.
- `tests/mcp.test.ts`: 4 separate `connectedClient()` pairs over one service (as production does per POST) call `scout_search` at once, and all 4 succeed.
- `tests/security.test.ts`: a table for `mcpRateClass`, covering `initialize`, `tools/list`, `tools/call scout_listings`, `tools/call scout_search`, a batch, and a malformed body. Add a small Fastify `inject` test in the style of `tests/auth.test.ts:176-191`.

**Risks / needs a product decision:**

- **Queueing.** The web search also waits instead of failing fast. Decide whether REST gets `maxWaitMs: 0`.
- **Caching.** Results can be up to 3 min old. Decide whether to add a `refresh: true` input.
- **Rate limit for unauthenticated `/mcp`.** It rises from 30 to 240 per minute per IP. Tokens are 256-bit (`scripts/generate-api-token.mjs`), but confirm with the user.
- **Proxy timeout.** Confirm the live openresty `proxy_read_timeout` before choosing the deadline default.
- **Priority.** Decide whether interactive manual searches should jump ahead of scan traffic in the per-marketplace limiter.

### P0-4: New read-only MCP tool `scout_price_reference` (medium to large; hat already consumes it)

**Where:** there is nothing today, and there is no way to ask "what is the typical used price of X" without knowing a watch.

- `scout_watches` shows no number for ungrouped watches. `variants` is filled only when groups exist (`server/service.ts:1981-1986`), and the Other-bucket typical in `typicalRows` (`:2108-2113`) is dropped.
- `scout_watch_analytics.current.medianPrice` is the latest day's asking median, not the scoring baseline.

These are the building blocks:

- `watchBaselines` (`:4246-4290`): per-variant buckets of the latest price per listing, 400 at most per bucket;
- `variantDealScore`/`dealScore` (`:2232-2236`, `:4296-4310`), with the exact readiness and pooling rules;
- `scoreDeal` (`server/scoring.ts:47-83`);
- `referenceBandMedian` (`:2954-2958`) and `computeSaleBand` (`server/marketBand.ts:39-59`);
- `endedSaleBandRows` (`:2940-2947`) and `marketWatchVersion` (`:2824-2831`);
- `queryTokens`, `parseIncludedExcluded` and `termMatches` (`:4825-4858`, all private);
- `assignVariant` (`server/variants.ts:88-100`, plain substring match);
- two private copies of `percentile`: `server/service.ts:343-351` and `server/marketBand.ts:25-32`.

**Fix:**

1. **Move shared helpers.** Move `QUERY_STOPWORDS`, `queryTokens`, `parseIncludedExcluded` and `termMatches` from `server/service.ts:4814-4858` into `server/text.ts` and export them. This is a pure move; the existing `filterListings` tests cover it. Export one `percentile` (linear interpolation, as in `marketBand.ts`) from `server/scoring.ts` and use it in both places.
2. **Matching.** Add a new pure module `server/queryMatch.ts` exporting:

   ```ts
   export interface MatchCandidate { kind: 'watch' | 'research'; id: string; name: string; query: string; includedTerms: string; excludedTerms: string; groups: VariantGroup[] }
   export type MatchKind = 'exact' | 'variant' | 'broader' | 'narrower';
   export interface QueryMatch { candidate: MatchCandidate; match: MatchKind; variantKey: string | null; matchedTokens: string[]; unmatchedTokens: string[]; modelTokenUnmatched: boolean }
   export function matchQuery(query: string, candidates: MatchCandidate[]): QueryMatch[];
   ```

   The query is treated like a title:
   - `q = normalizeFilterText(query)`, with `qGlued = q` minus spaces.
   - Take `{included, excluded}` from `parseIncludedExcluded(c.query, c.includedTerms, c.excludedTerms)`.
   - **Veto** the candidate if any excluded term `termMatches(q, qGlued, term)`.
   - `required` means every included term `termMatches(q, qGlued, ...)`.
   - A query token is **explained** if `termMatches` finds it in the candidate's text: `normalizeFilterText(c.query + ' ' + included.join(' '))`, plus its glued form.

   The match is then:
   - `exact`: required, and nothing is left unexplained;
   - `variant`: required, the candidate has groups, `g = assignVariant(query, groups)` is not `OTHER_VARIANT_KEY`, and `g.terms` explain every leftover token;
   - `broader`: required, with leftovers. Set `modelTokenUnmatched` when a leftover contains a digit or is one of `ti, super, pro, max, plus, ultra, mini, lite, xt, xtx, xl, air, oled, digital` (the list hat uses in `/root/hat/packages/tool-deals/src/classify.ts:379-381`);
   - `narrower`: not required, but every query token is explained;
   - otherwise, no match.

   For `exact` on a grouped watch, the bucket is `assignVariant(query, groups)`. If that is Other, the match is a mixed bucket.
3. **Service method.** `ScoutService.priceReference(input)` goes near `watchAnalytics` (`:2303`).
   - **Candidates:**
     - non-archived watches: `SELECT * FROM watches WHERE archived_at IS NULL`;
     - research series: `SELECT * FROM market_watches`, taking query and terms from `marketWatchVersion(row)`.
   - **Rank matches:**
     - first by match quality: `exact` or `variant`, then `broader` without a model token, then the rest;
     - then `ready` first;
     - then kind `watch` before `research`. Watch baselines are asking prices, like hat's live listings; research bands are probable-sale;
     - then by samples, descending;
     - then by `enabled`.

     If `sources` is given, a candidate whose sources overlap ranks ahead of one that does not.
   - Compute figures only for the top 5 candidates.
   - **For a watch:**
     - Take `baselines = this.watchBaselines(row)` and the bucket (the variant's key, or Other for ungrouped watches).
     - Take `referenceBand` for `row.reference_market_watch_id`. Refactor `referenceBandMedian` into `referenceBand()`, which returns the whole `SaleBand`, with the median a thin wrapper.
     - Call `this.dealScore(row, 1, bucket, band.median-if-eligible, named ? baselines.pooled : null)` for `score.typical`, `score.isReady` and `useReference`, exactly as scans do.
     - When `useReference`: `typicalPrice` is the band median, `p25`/`p75` come from the band, `samples` is `band.eligibleCount`, `ready` is `false`, and `typicalSource` is `'reference-band'`.
     - Otherwise: `p25`/`p75` are the percentiles of `bucket.prices`, `samples` is `bucket.prices.length`, and `typicalSource` is `'own-history'`.
     - `updatedAt` is the newest `observed_at` feeding the bucket. Have the `latest` query at `:4262-4265` also return `observed_at`.
   - **For a research series:**
     - The band is `computeSaleBand(endedSaleBandRows(id) → samples, SALE_BAND_WINDOW_DAYS, now)`. If `eligibleCount >= MIN_BAND_SAMPLES`, report its median and quartiles with the basis "probable-sale band".
     - Otherwise, take the median of active `market_listings.last_price_pln` for the active version, if there are at least 4, with the basis "asking prices of active research listings".
     - `updatedAt` is `market_watches.last_scan_at`.
   - **`best`** is the top candidate that is `exact` or `variant` (named bucket, or ungrouped), or `broader` without a model token, **and** has a `typicalPrice` above 0 from at least `MIN_BAND_SAMPLES` (4) samples. Otherwise `best` is `null`.
   - `minPrice`/`maxPrice` never truncate the distribution; they are only echoed in `matches[].filters.requested`.
   - There is no ad-hoc fallback from loose `listings` rows in v1; the study's selection-bias concern stands.
4. **Register the tool.** Register `scout_price_reference` in `server/mcp.ts` with `annotations: { readOnlyHint: true, idempotentHint: true }` and add it to `SCOUT_MCP_TOOL_NAMES` (`:20-33`). The description should say:
   - it gives Scout's learned typical used asking price for a product;
   - it matches free text to watches (with model variants) and research series;
   - it makes no marketplace fetch and no AI call.
5. **Optional REST route:** `GET /api/price-reference?q=...` (protected automatically).

**Contract** (exactly what hat sends and parses; see `/root/hat/packages/server/src/tools/deals.ts:237-271` and `:404-418`).

Input schema:

```ts
{ query: z.string().trim().min(1).max(240),
  sources: z.array(marketplace).min(1).max(3).optional(),
  minPrice: z.number().nonnegative().nullable().optional(),
  maxPrice: z.number().positive().nullable().optional(),
  // optional, never sent by hat:
  terms: z.string().max(240).optional(), excluded: z.string().max(240).optional(),
  include: z.array(z.enum(['watch', 'research'])).min(1).optional(), limit: z.number().int().min(1).max(5).optional() }
```

Output, as the test below produces it for `seedVariantWatch(db, service, 'pooled-watch')` (`tests/service.test.ts:2524-2542`) and the query `iphone 13 pro`:

```json
{"query":"iphone 13 pro",
 "best":{"kind":"watch","id":"pooled-watch","name":"pooled-watch name","variant":"13 Pro","typicalPrice":2600,
   "p25":2567.5,"p75":2632.5,"samples":12,"ready":true,"basis":"asking prices, own history",
   "updatedAt":"<seeded observed_at, ISO>"},
 "matches":[{"kind":"watch","id":"pooled-watch","name":"pooled-watch name","variant":"13 Pro","typicalPrice":2600,
   "p25":2567.5,"p75":2632.5,"samples":12,"ready":true,"basis":"asking prices, own history","updatedAt":"<same>",
   "variantKey":"pro","match":"variant","matchedTokens":["iphone","13","pro"],"unmatchedTokens":[],
   "typicalSource":"own-history","observationHours":8,"enabled":true,
   "filters":{"minPrice":null,"maxPrice":null,"shippingOnly":false,"sources":["OLX"],
              "requested":{"sources":null,"minPrice":null,"maxPrice":null}}}],
 "notes":["Asking prices, not completed sales."]}
```

The rules hat enforces (breaking any of them makes hat read the answer as "unreadable" or wrong):

- **`best` must never hold a candidate without a price.** It is `null` when nothing qualifies. If it is an object, `name` must be a non-empty string and `typicalPrice` a number above 0; otherwise hat reports the whole answer as unreadable.
- **`best` field types:**
  - `kind` is `"watch"` or `"research"`, and `id` is a string.
  - `variant` is a string or `null`; hat shows it in parentheses.
  - `p25` and `p75` are numbers or `null`, and should satisfy `p25 <= typicalPrice <= p75`. hat ignores quartiles on the wrong side and uses them for the spread.
  - `samples` is an integer of at least 0. hat weighs the reference by it, and at least 8 counts as strong.
  - `ready` is a boolean; hat labels it "not ready" when false.
  - `basis` is a short string, shown verbatim.
  - `updatedAt` is an ISO string or `null`; hat shows the first 10 characters.
- `matches` is not read by hat; it is there for the model and for debugging.

**Tests:**

- **`tests/queryMatch.test.ts`** (pure):
  - `iphone 13 pro` against `{query:'iphone 13', groups: iphoneVariants}` (the constant at `tests/service.test.ts:2514-2518`, redeclared) gives `variant`/`pro`, and `iphone 13` gives `exact`/`base`.
  - `iphone 13 pro` against an ungrouped `iphone 13` gives `broader` with `modelTokenUnmatched`.
  - `iphone 13` against a watch `iphone 13 pro` gives `narrower`.
  - `iphone 13 czarny` against `iphone 13` gives `broader` without a model token.
  - An excluded `mini` vetoes `iphone 13 mini`.
  - `rtx3080` and `rtx 3080` match both ways.
  - `iphone 5` does not match `iphone 15`.
  - Stopwords are ignored (`karta do gtx 1660`).
  - Explicit included terms decide `required`.
- **`tests/service.test.ts`**, next to `seedVariantWatch`:
  - The payload above (compare the quartiles rounded to 0.01). `iphone 13 mini` gives `typicalPrice` 1500.
  - An ungrouped watch with 20 samples gives `ready: false` and `samples: 20`.
  - Fewer than 4 samples and no reference give `best: null`, with the candidate listed in `matches` with `typicalPrice: null`.
  - A reference-band watch (own samples under the floor, and a research series with at least 4 eligible ended listings) gives `typicalSource: 'reference-band'`, `samples` equal to `eligibleCount`, and `ready: false`.
  - A research-only match gives `kind: 'research'`.
  - Archived watches are ignored.
  - For a watch, `typicalPrice` equals `scoreDeal(bucket.prices, 1, …).typical`.
- **`tests/mcp.test.ts`:** the tool is listed with `readOnlyHint: true`, and `best: null` is serialized as `null`.
- **`tests/hatContract.test.ts`:** the type rules above.

**Risks / needs a product decision:**

- **False matches.** They are mitigated by the `match` kinds, the token lists, the model-token rule and the veto; tune them with real watch names from the Debug API.
- **Watch price filters** truncate the distribution; `filters` exposes them.
- **Paused or stale watches:** `enabled` and `updatedAt` are exposed.
- **Should `sources` narrow the distribution per marketplace?** It is not narrowed in v1, because narrowing would diverge from what Scout scores against.
- **What does `ready` mean for research?** The proposal is `eligibleCount >= 10`. With 4-9, it still gives a price, but `ready: false`.
- **Research versus watch baselines.** A research band (probable-sale) runs lower than asking prices, so it makes hat's discounts look smaller (conservative). Decide whether a research series may be `best` when an `exact` watch exists but is not ready.

### P0-5: "Strong+ deals right now" in one call: `scout_listings` filters plus `scout_deals` (small; DB-only)

**Where:**

- `scout_listings` accepts `marketplace`, `q`, `watchId`, `page`, `pageSize` (at most 50), `sort` (`newest`, `strongest` or `price`), `decision` and `visibility` (`server/mcp.ts:70-85`).
- `listingsPage` has no discount, tier, variant or price predicates (`server/service.ts:2519-2537`).
- `strongest` sorts by the integer `wl.deal_strength` (`:2539-2543`).
- The SELECT (`:2547`) leaves out `l.ai_description_verification_*`, so rows carry no verification status.
- Always on: the watch is not archived, the association was seen in the last 12 h (`MATCH_VISIBILITY_MS`, `:122`), and the row is not AI-irrelevant.
- **Manual-search hits never appear**, because the query joins `watch_listings`.

The tiers are `dealStrengthFromDiscount` (`:508-511`):

| Discount | Strength | Label |
|---|---|---|
| ≥ 30 % | 5 | Exceptional |
| ≥ 20 % | 4 | Very strong |
| ≥ 12 % | 3 | Strong |

Alerts start at 18 % (`server/scoring.ts:81`).

**Fix:**

1. **New optional `scout_listings` inputs**, also added to the REST query schema at `server/index.ts:293-302`:
   - `minTier`: `strong`, `very-strong` or `exceptional`, meaning strength of at least 3, 4 or 5;
   - `minDiscount`: 0-100;
   - `variantKey`: up to 64 characters (`__other__` is allowed);
   - `minPrice` and `maxPrice`;
   - `verification`: `pass`, `reject`, `unknown`, `pending`, `not-configured`, `fallback` or `none`;
   - `sort` gains `discount`;
   - `format`: `full` or `compact`.
2. **SQL.** Append to `predicates`, with `?` binds as elsewhere. Build `readyWatchIdsJson` from `knownWatches ?? this.getWatches()` **before** the query (today that happens at `:2554`), with `readiness === 100`, the same rule `listingFromRow` uses as `baselineReady`.

   ```sql
   -- only typicals listingFromRow would display (server/service.ts:2021-2030)
   AND wl.typical_pln > 0
   AND (wl.typical_source IN ('own-history', 'reference-band')
        OR wl.watch_id IN (SELECT value FROM json_each(?)))           -- readyWatchIdsJson; for minTier/minDiscount/sort=discount
   AND COALESCE(wl.deal_strength, 0) >= ?                             -- minTier
   AND (wl.typical_pln - l.price_pln) * 100.0 / wl.typical_pln >= ?   -- minDiscount
   AND wl.variant_key = ?                                             -- variantKey
   AND l.price_pln >= ? AND l.price_pln <= ?                          -- minPrice / maxPrice
   AND COALESCE(l.ai_description_verification_status, 'none') = ?    -- verification
   -- sort = 'discount'
   ORDER BY (wl.typical_pln - l.price_pln) / wl.typical_pln DESC, wl.last_seen_at DESC, wl.id DESC
   ```

   `json_each(?)` keeps one SQL shape for the statement cache (`:593-608`). Add `l.ai_description_verification_json, l.ai_description_verification_at, l.ai_description_verification_status, l.ai_description_verification_error` to the SELECT, so `listingFromRow` fills the verification fields (`:2075-2087`). This is additive for REST and iOS.
3. **New tool `scout_deals`**, with `annotations: {readOnlyHint: true, idempotentHint: true}` and added to `SCOUT_MCP_TOOL_NAMES`.
   - Input: `{ minTier = 'strong', marketplace?, watchId?, variantKey?, maxPrice?, includeRejected = false, limit = 20 (max 50) }`.
   - It calls `listingsPage({ ..., sort: 'discount', visibility: 'visible' })` and excludes `verification = 'reject'` unless `includeRejected` is set.
   - With no arguments, it answers "Strong+ deals right now".
4. **Wording.** Leave `dashboard().stats.strongDeals` alone; P0-1 fixes its wording.

**Contract** (not consumed by hat yet; rows are shaped so the model can pass them straight to `deal_score`):

```json
{"schemaVersion":1,"minTier":"strong","freshHours":12,"total":1,
 "deals":[{"id":"OLX:strong-pro","listingId":"strong-pro","source":"OLX","title":"iPhone 13 Pro 128GB","price":2106,
   "typical":2600,"discountPercent":19,"tier":"strong","dealLabel":"Strong","typicalSource":"own-history",
   "watchId":"pooled-watch","watch":"pooled-watch name","variantKey":"pro","variant":"13 Pro",
   "url":"https://www.olx.pl/d/oferta/strong-pro","condition":null,"location":null,"shippingAvailable":null,"negotiable":false,
   "seenAt":"<ISO>","verification":null,"flags":[]}],
 "notes":["Asking prices, not completed sales.","Strong starts at 12% below typical; Scout alerts from 18%."]}
```

**Tests:**

- `tests/service.test.ts`, modelled on the test at `:632`. Seed rows across the tiers with `typical_pln`, `deal_strength` and `typical_source` set, plus one legacy row (`typical_source NULL`) on a watch that is not ready. Assert:
  - each `minTier`;
  - `minDiscount`, with the legacy row excluded;
  - `sort:'discount'` order across pages, and `total` following the filters;
  - `variantKey`, price bounds, and `verification`, including `none`;
  - hidden and AI-filtered rows are excluded.
- `tests/mcp.test.ts`: `scout_deals` with no arguments returns Strong+ sorted by discount, and the tool list equals `SCOUT_MCP_TOOL_NAMES`.
- Run `EXPLAIN QUERY PLAN` on a database copy.

**Risks / needs a product decision:**

- Stored strength and typical are as of the last scan.
- The 12 h freshness window hides rows that were recently seen but have ended. Decide whether to expose `freshHours` as an input.
- "Would Scout alert" (`qualifies`) is not stored; see P2-3.

### P1-1: `typoVariants` on `scout_search` (medium; hat sends it when advertised)

**Where:**

- The generator is `server/typos.ts:10` (tokens under 6 characters are skipped), `:16-41` and `:48-71`. Its weaknesses are shown in probe 4.
- Only scans use it:
  - `runWatch` at `server/service.ts:3729-3738`, and only without exact URLs;
  - `runMarketWatch` at `:3121-3129`;
  - both with `TYPO_VARIANTS_PER_SCAN = 2` (`:132`), rotated by `scanOrdinal` (`:625-628`).
- `manualSearch` never uses it.
- **There is a latent bug in the scans.** Typo pages are filtered against the **original** query (`:3742-3744`, `:3133-3135`), so a misspelled title is dropped (probe 5).
  - In `runWatch` it can survive only through the gated, 10-per-source Jev rescue (`:3756-3778`).
  - `runMarketWatch` has no rescue at all, so typo pages in research are pure fetch cost.

**Fix:**

1. **New input** `typoVariants: z.boolean().optional().default(false)`. hat sends `true`, on its main phrasing only.
   - Budget: `SEARCH_TYPO_VARIANTS = 2` extra page-1 queries per source (`SCOUT_SEARCH_TYPO_VARIANTS`, 0-3). They are ignored when `page > 1`.
   - They are fetched concurrently through `marketplaceRequest`, so they queue behind the 2-per-marketplace limit.
2. **Filter each variant page against its own spelling.**
   - Change the generator to return pairs: `typoVariantPairs(query) → Array<{ query, from, to }>`.
   - Filter a variant page with `filterListings(page, pair.query, rewrite(terms, from→to), excluded, filters)`, keeping the rows of the original page.
   - Merge on `${marketplace}:${listingId}`, with the main page winning.
   - Judge AI relevance against the **original** query. That is the user's intent, and those rows reuse the main page's cache hash.
   - Run the rescue on the main page only.
3. **Apply the same own-spelling filter in `runWatch` and `runMarketWatch`.**
4. **Generator** (`server/typos.ts`), still deterministic:
   - skip tokens that contain digits (probe 4, `wh-1000xm5`);
   - allow letter-only tokens of 5 characters;
   - order candidates by realistic typos first: delete the final letter or vowel (`iphone` → `iphon`), transpose interior letters, drop a doubled letter, then the rest;
   - add joined forms of two adjacent letter-only tokens (`play station` → `playstation`);
   - spread the picks across positions instead of the first three indices.

**Contract** (hat detects `properties.typoVariants` and sends a boolean `true`; it must accept exactly that):

- **Compact output adds:**
  - a top-level `"typoVariants":["iphon 13","iphoen 13"]`;
  - per listing, `"matchedVia":"typo:iphon 13"`;
  - per source, `"variants":[{"query":"iphon 13","status":"ok","fetched":1,"matched":1}]`.
- The `full` format may add `matchedVia` as an optional field.

**Tests:**

- **`tests/service.test.ts`,** with a stub switching on the `query=` parameter of the OLX API URL:
  - `iphone 13` returns `iPhone 13 128GB` (id `A`), and `iphon 13` returns the fixture offer `1092728340`, titled "Iphon 13 128GB...".
  - The result has both rows, with `matchedVia` set to `query` and `typo:iphon 13`.
  - With the option off, there is 1 fetch per source; with it on, at most 3.
  - `page: 2` makes no typo fetch.
  - The typo hit survives with Jev off.
- **Watch-scan regression:** the same stub on a watch with `typo_variants = 1` stores the misspelled listing without live Jev.
- **`tests/typos.test.ts`** (`:1-50`):
  - digit tokens are untouched;
  - `iphone 13` gives `iphon 13` within the first 2;
  - joined forms appear;
  - the output is deterministic.

  Existing assertions (`rtx 4070` gives `[]`, and diacritics are kept) must still hold, or be updated on purpose.

**Risks / needs a product decision:**

- Two extra fetches per source per search (anti-bot fences, and the 2-per-marketplace queue).
- More Jev spend inside the same 40-call budget.
- Changing `typoVariants()` output changes which variants existing watches rotate through.
- Research series gain listings (the criteria version is unchanged); note this in the README.

### P1-2: Server-side quick flags on listings (medium)

**Where:**

- No deterministic junk detection exists. There are no for-parts, wanted, swap or replica rules; a grep of `server/` finds only the Jev prompt word list at `server/jev.ts:262`.
- JSON-LD `DamagedCondition` becomes the label `Uszkodzone` (`server/marketplaces.ts:357`), and nothing acts on it.
- The OLX search API returns `description` (`tests/fixtures-olx-api.json`), but `parseOlxOffer` (`:802-827`) drops it.
- `normalizeFilterText` turns `ł` into a space (`server/text.ts:8`; probe 6), so it cannot be reused for Polish flag words: `działa` becomes `dzia a`.
- The existing verification outcome (`l.ai_description_verification_status`, written by `verifyHighPriorityDealOnce`, `server/service.ts:1662`) is the one piece of verification logic to reuse.

**Fix:**

1. **New `server/flags.ts`**, `listingFlags({ title, condition, description?, query? }) → Flag[]`.
   - Port the tested rules from hat: `/root/hat/packages/tool-deals/src/classify.ts`, which is uncommitted in hat's tree:
     - `normalizeText` (`:10-26`, maps `ł` to `l`, splits letters from digits);
     - `NEGATORS`, `NEGATION_GLUE` and `negated` (`:80-107`);
     - `FOR_PARTS` (`:123-163`), `DENIED_AFTER` (`:166`), `CARRIER_LOCK` (`:168`);
     - `WANTED` (`:170-172`), `SWAP`, `SALE` and `OPTIONAL_SWAP` (`:174-181`), `REPLICA` (`:184`), `NOT_THE_DEVICE` (`:187-195`);
     - the `accessory()` logic (`:566-587`), which depends on the query.
   - Split iCloud, FRP, activation and MDM locks out of for-parts into their own flag.
2. **Vocabulary**, aligned with hat's `DealFlag` names where one exists (`/root/hat/packages/tool-deals/src/types.ts:58-76`):
   - shared with hat: `for_parts`, `wanted_ad`, `swap`, `replica`, `accessory`;
   - Scout only: `damaged` (condition label), `locked`, and `verification_reject` (stored verification is `reject`, with `match` set to its first issue).
3. **Where flags are computed:**
   - `manualSearch`, from title, condition and the OLX description (add `searchDescription?: string`, truncated to 2000 characters, to `NormalizedListing`; it is not persisted);
   - `listingsPage`, `scout_deals` and `listingDetail`, from stored title and condition, the watch query, and the stored verification.

   Optionally, feed `searchDescription` to Jev relevance: `ListingRelevanceContext.description` exists (`server/ai.ts:30-31`) and is not in the cache hash (`:181-192`).
4. **Default is flag only; never drop a listing.**
5. **Filtering.** For an `excludeFlags` filter with correct `total`s, persist the query-independent flags: new migration `028_listing_flags.sql` adds `listings.flags_json TEXT` and `flags_version INTEGER`, written in `storeListing` and `storeManualListing`. `accessory` stays computed at read time.

**Contract:** listing `"flags":[{"flag":"for_parts","match":"nie wlacza sie","in":"description"}]`, where `in` is `title`, `condition`, `description` or `verification`.

- hat does not read `flags` today; it computes its own title flags. So this needs no hat change.
- Keep the names stable, so that a later hat version can merge them.

**Tests:**

- **`tests/flags.test.ts`** (table-driven): port the cases from `/root/hat/packages/tool-deals/src/classify.test.ts`, and the titles in its fixtures `phone-broken-bait.json`, `console-wanted-swap.json` and `airpods-accessories.json`. It must cover these negations:
  - `bez uszkodzeń` and `uszkodzeń: brak` raise nothing;
  - `zablokowany na sieć Play` raises nothing;
  - `sprzedam lub zamienię` is not a swap;
  - `nie działa` is for_parts.
- **`tests/service.test.ts`,** through `manualSearch`:
  - an OLX stub row whose description reads `nie włącza się` gives `for_parts` in `description`;
  - the condition `Uszkodzone` gives `damaged`;
  - a listing with stored verification `reject` gives `verification_reject` in `scout_listings`.

**Risks / needs a product decision:**

- **False positives** (Polish inflection, negation) would hide real deals if flags were used to drop listings, so v1 only flags.
- **Should hard title flags (`wanted_ad`, `for_parts`) skip the Jev relevance call** and count as `irrelevant` with reason `flag:*`? That saves spend but is a behaviour change, so it should be opt-in.
- Persisting flags needs the migration.

### P1-3: Make `scout_listing_detail` useful for search hits (small to medium)

**Where:**

- hat's report ends by telling the model to check the top 3 picks with `scout_listing_detail`, keyed by listing id.
- Manual-search hits are stored by `storeManualListing` (`server/service.ts:4220-4230`), so the key resolves. But `listingDetail` (`:2563-2644`) has little to show for them:
  - the watch is `Unassigned` and `typical` is `null`;
  - `history` is empty (no observations);
  - `descriptionSnapshot` is `null`, because snapshots are written only by deal verification (`captureListingDetailSnapshot`, `:1624`).
- There is no on-demand check of availability or description.

**Fix:**

1. **New optional input `live: z.boolean().optional().default(false)`.**
   - When true, make one detail fetch through the marketplace limiter, the same fetch verification uses: `this.detailHtml(url, marketplace)` plus `parseListingDescription` (`:1684-1685`). For OLX, `createConnectorAdapter('OLX').fetchDetail(url, {listingId})` gives availability and price from the offers API (`server/marketplaces.ts:894-914`).
   - Return `liveCheck` alongside today's fields, running `listingFlags` (P1-2) on the description.
   - Make no AI call. Write nothing in v1 (see the decision below).
2. **Annotations:** `{ readOnlyHint: true, openWorldHint: true }`.
3. **Description:** say "pass `live: true` to fetch the current page". The model reads the description.

**Contract:**

```json
"liveCheck":{"checkedAt":"<ISO>","availability":{"status":"live"},"price":800,"description":"Witam, sprzedam iPhone 13 128GB. Stan bardzo dobry.","flags":[]}
```

- `availability.status` is `live`, `terminal` or `unknown`, with a `reason` for the last two.
- `liveCheck` is `null` when `live` was not asked for.
- hat sends only `key` today.

**Tests:** in `tests/service.test.ts`, with `fetchListingDetailHtml` stubbed through `ScoutServiceDependencies` (`:183-197`) and `fetchOlxApi` stubbed:

- a manual-search hit plus `live: true` gives the description and flags;
- a 404 detail gives `terminal`;
- `live: false` makes no fetch.

**Risks / needs a product decision:**

- **Should `live` be automatic** when no snapshot exists? That is convenient, but it gives a read tool a fetch cost.
- **Should the result be stored** as a `listing_detail_snapshots` row? It is useful later, but it is a write.

---

### P2 items (lower impact on hunts, or needing decisions first)

- **P2-1: Baseline-enriched search.**
  - **Proposal:** a `scout_search` input `scoreAgainst: 'auto' | <watchId>` that reuses P0-4's matching, then `watchBaselines`, `scanVariantResolver` and `variantDealScore`, read-only with no `storeListing`.
  - **Output:** per listing, `deal: {typical, discountPercent, deviation, tier, qualifies, basis, variantKey}`.
  - **Also:** it enables the watch-scan AI gate (spend Jev only on possible deals).
  - **Tests:** the scores equal `variantDealScore` for the same price.
  - hat scores listings itself, so this is for Scout's UI, iOS and the model.
- **P2-2: Watch-level typical for ungrouped watches.**
  - **Proposal:** add `typical`, `p25`, `p75` and `robustScale` to `Watch`, from data `watches()` already loads (`typicalRows`, `server/service.ts:2108-2113`).
  - **Also:** fix the "with learned baselines" wording (`server/mcp.ts:63`).
  - This is additive for iOS.
- **P2-3: Persist score fields.**
  - **Proposal:** migration `02x_watch_listing_scores.sql`, one `ALTER TABLE watch_listings ADD COLUMN` each for `discount_percent REAL`, `deviation REAL`, `confidence INTEGER` and `qualifies INTEGER`, written in `storeListing` (`:4352-4378`). This enables a `qualifiesOnly` filter on `scout_listings` and `scout_deals` ("would Scout alert?").
  - **Tests:** the migration-list assertion, and values equal `scoreDeal`.
- **P2-4: Compact `scout_dashboard`.**
  - **Problem:** it returns up to 500 rows, AI-filtered and hidden ones included (`getListings(watches, true)`, `:2559-2561`, `:3420`).
  - **Proposal:** add `limit` (default 20) and exclude AI-filtered and hidden rows in MCP.
- **P2-5: `sort` for `scout_search`.**
  - **Problem:** manual search passes no `sort`, so each marketplace's default order applies (`:2733`); scans use `newest` (`:3721`).
  - **Proposal:** add `sort: 'relevance' | 'newest'` (`MarketplaceSearchSort`, `server/marketplaces.ts:40`, `:109-114`, `:771`). Fresh underpriced listings sell fast.
  - **Unverified:** what each marketplace's default order is, and whether a price-ascending sort works reliably. Check before adding `price_asc`.
- **P2-6: Connector backoff in manual search.**
  - **Proposal:** skip sources whose `activeConnectorBackoff` is set, as `status:'error', errorKind:'backoff'` with the until time in `message`; add an `ignoreBackoff` input.
  - **Decision:** should manual failures be recorded in `connector_runs` and extend backoff?
- **P2-7: Product decisions before any code.**
  - **`scout_verify_listing`:** on-demand Jev description verification, with vision escalation, reusing `verifyHighPriorityDealOnce` internals and caches. It writes caches that alert gating later reuses, so decide on `readOnlyHint`.
  - **Write tools:** `scout_create_watch` and `scout_create_research_watch` (`readOnlyHint: false`, so hat asks), so an agent can start learning a baseline for a product it keeps hunting.
- **P2-8: Docs drift.**
  - `README.md:170` says unsure relevance fetches the detail page and then vision. The code follows the lean (`server/service.ts:1030-1049`, test at `tests/service.test.ts:1919`).
  - The same paragraph says the checkbox skips rescue calls; this is fixed in P0-1.
  - The MCP section's "twelve tools" (`README.md:187`) needs updating for the new tools.

---

## Needs a product decision: consolidated

Do not implement these unilaterally; pick a default and confirm it with the user.

1. P0-1: whether `condition: used` should exclude `Uszkodzone`; how to treat unknown condition strings.
2. P0-3:
   - queueing for REST, versus failing fast;
   - the cache TTL, and a `refresh` input;
   - the unauthenticated `/mcp` limit going from 30 to 240 per minute;
   - the deadline default (depends on the live proxy timeout);
   - a priority lane for interactive searches.
3. P0-4:
   - whether `sources` narrows the distribution;
   - what `ready` means for research;
   - whether research may beat a watch that is not ready.
4. P1-1: whether to accept the extra fetch and Jev cost; changed rotation for existing watches.
5. P1-2: whether flags may skip Jev or hide listings; whether to persist flags (migration).
6. P1-3: automatic `live`; storing live checks as snapshots.
7. P2-6 and P2-7: backoff semantics; `scout_verify_listing`'s annotation; write tools.

## Definition of done

- [ ] Rebased onto `origin/main` with the user's OK; new migrations numbered from 028, and the list assertion in `tests/service.test.ts` updated.
- [ ] `npm run typecheck`, `npm test`, `npm run build` and `npm audit --omit=dev` all pass.
- [ ] `scout_search` with no new inputs returns today's shape (a key-level test), and REST `/api/search` and `/api/listings` changed only additively.
- [ ] `tests/hatContract.test.ts` passes:
  - compact `scout_search` gives `id` as `<Marketplace>:<listingId>`, a numeric `price`, `source`, `status` only `ok` or `error`, and no top-level `error`;
  - `scout_price_reference` gives `best` as `null` or an object with a non-empty `name` and a `typicalPrice` above 0.
- [ ] Busy and queue-timeout errors still contain "already running", and deadlines return partial payloads, not errors.
- [ ] `tests/mcp.test.ts` tool list equals `SCOUT_MCP_TOOL_NAMES`, including `scout_price_reference` and `scout_deals`.
- [ ] New tools are annotated `readOnlyHint: true` and none sets `destructiveHint`.
- [ ] README updated:
  - the MCP section (tool list and count; new inputs `format`, `typoVariants`, `deadlineMs`, `live`; queue and deadline; "Costs and limits");
  - Manual search (relaxed fallback, typo variants, condition synonyms);
  - the AI relevance paragraph at `README.md:170`.
- [ ] Jev spend measured on a database copy before and after (the `jev_shadow_log` query in P0-3), with the numbers in the commit message.
- [ ] The live database, the live instance and the user's running process were never touched, and `data/` is unchanged.
- [ ] Other people's uncommitted edits in the tree were left alone.
- [ ] One commit per item.

## Interop with hat

Everything hat does with Scout lives in `/root/hat/packages/server/src/tools/deals.ts`, uncommitted in hat's tree; line numbers are from that file. It is documented for users in `/root/hat/README.md:222-265` ("Scout") and `:483-557` ("What `deal_hunt` expects from Scout"). hat's README is current; the earlier note that it was stale no longer applies.

**Connection.**

- hat config: `{"name":"scout","transport":"http","url":"https://<scout host>/mcp","token":"<one SCOUT_API_TOKENS value>"}`.
- Tools appear as `mcp__scout__scout_*`. hat finds them by name suffix (`__scout_search`, `__scout_price_reference`, `__scout_listing_detail`; `:25-28`, `:461-482`), preferring the server of the chosen search tool, then `mcp__scout__`. **Keep these three tool names exactly.**
- hat runs a Scout tool only if all of these hold:
  - it is `readOnlyHint: true` without `destructiveHint`;
  - hat's `trustReadOnlyHint` is on;
  - the session policy approves it.
- hat lists tools and schemas only when its MCP plugin activates, so **reload hat's MCP plugin after each Scout deploy**.

**`scout_search`, as hat calls it** (`:502-515`, `:719-757`):

- **Always sends:** `query` and `sources`.
  - Default `sources` is `inputSchema.properties.sources.items.enum` sliced to `maxItems` (`:490-500`). If Scout ever adds a marketplace, raise `maxItems` too, or hat will take only the first three.
  - `minPrice`, `maxPrice`, `shippingOnly` and `condition` are sent only when the model set them. `condition` is free text, hence P0-1's synonyms.
  - `typoVariants: true` is sent only on the first phrasing, and only when `properties.typoVariants` exists.
  - `format: "compact"` is sent on every call once `properties.format.enum` includes `"compact"`.
  - It never sends `page`, `terms`, `excluded`, `location`, `ownerType`, `aiRelevance`, or the new `deadlineMs`. Server defaults apply.
- **Concurrency.** One call per phrasing (the query plus up to 3 variants), with at most 3 in flight across all of hat. A 4th waits in hat. An error containing `already running` is retried after 2, 4 and 6 s.
- **Reads** the text content as one JSON document (`:166-179`). A string `error` field means the whole call failed.
- **Listing fields** (`:185-211`):
  - `title` is required;
  - `id`, else `source:listingId`, else `url`;
  - `price` is a number or a string like `"1 299 zł"`;
  - `shipping` is a number of at least 0;
  - `url`, then `source` or `marketplace`;
  - `sellerType` is `private` or `business`;
  - `shippingAvailable` is a boolean;
  - `condition` and `location`;
  - `negotiable` or `priceNegotiable`.

  Everything else is ignored, and `null` is treated as absent.
- **Source fields:** `source`, `status` (only `"error"` means failed), and `message` (shown as the reason).

**`scout_price_reference`** (`:237-271`, `:404-418`, `:759-790`): the input and output are exactly as in P0-4's contract. The reference is weighted by `deal_score`:

- with at least 8 samples, it is used when the live listings agree within 15 %;
- between 15 % and 35 % apart, it is blended with them by sample count, capped at 30;
- beyond 35 %, the live listings win if there are at least 8 of them.

`ready` only labels the reference; `samples` drives the weighting.

**`scout_listing_detail`:** hat only names it in the closing hint, keyed by `id`, for the top 3 picks. hat sends nothing else; P1-3's `live` needs a hat prompt change to be used by default.

**Invariants Scout must keep:**

1. Tool names.
2. `readOnlyHint` on the read tools.
3. `id` as `<Marketplace>:<listingId>`.
4. `sources[].status` is `"ok"` or `"error"`, with new failure types expressed as `errorKind`.
5. No top-level `error` key on success.
6. The busy phrase `already running`.
7. A `typoVariants` property that accepts `true`.
8. A `format` enum that contains `"compact"`.
9. `best` is `null` rather than a partial object.

**hat-side items (for hat, not Scout):**

- hat's MCP plugin answers "no runner is connected" for HTTP servers too (`isRunnerUp()`, `/root/hat/packages/mcp/src/plugin.ts:187`). Scout over HTTP needs no runner.
- Stop and timeouts send `notifications/cancelled` but do not abort the in-flight POST (`/root/hat/packages/mcp/src/jsonrpc.ts:67-72`). Aborting the POST for a cancelled id would let Scout see a disconnect and fire `extra.signal`.
- HTTP 429 is not retried (`/root/hat/packages/mcp/src/transports.ts`, the non-OK branch of `post`).
- A tool-name clash gives Scout's tool a hashed name (`mcpToolName`, `/root/hat/packages/mcp/src/plugin.ts:114-123`), which breaks suffix discovery.
- Once they ship, hat could:
  - read `flags`, `relevance` and `postedAt` from compact rows;
  - use `scout_deals`;
  - pass `live: true` to `scout_listing_detail`.

**End-to-end check (local, no live data):**

1. Start Scout on loopback against a temp database:

   ```bash
   TOKEN=$(node scripts/generate-api-token.mjs)
   SCOUT_DB_PATH=/tmp/scout-e2e.sqlite SCOUT_SKIP_MIGRATION_BACKUP=true \
     SCOUT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
     SCOUT_API_TOKENS=$TOKEN PORT=3999 npx tsx server/index.ts
   ```

   - The host defaults to `127.0.0.1` (`server/index.ts:28`).
   - Searches still fetch the real marketplaces.
   - AI runs only with an OpenRouter key (`SCOUT_OPENROUTER_API_KEY` or Settings), and with one, live Jev is the default and costs money. `SCOUT_JEV_MODE=legacy` without a key keeps it deterministic.
2. Give `scout_price_reference` something to find. A fresh watch has no baseline, so insert listings and observations into the temp database the way `seedVariantWatch` does (`tests/service.test.ts:2524-2542`).
3. Point a local hat at `http://127.0.0.1:3999/mcp` with `$TOKEN`.
4. Run `deal_hunt` for a seeded product and confirm:
   - the `Sources:` line lists all three marketplaces;
   - the Scout price reference note names the watch;
   - the closing hint names `mcp__scout__scout_listing_detail`.
