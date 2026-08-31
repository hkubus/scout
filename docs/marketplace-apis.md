# Replacing Playwright scraping with marketplace APIs

**Status:** design / implementation briefing for an agent.
**Scope:** replace the Chromium/`playwright-core` **runtime scraping** of marketplace listings with HTTP APIs (or plain HTTP where no API exists). Read-only monitoring first.
**Out of scope (per owner):** seller messaging / auto-negotiation. Do **not** touch `server/olx-messaging.ts`, `server/allegro-messaging.ts`, `sendMarketplaceMessage`, or the messenger-only `marketplace-login.ts` session capture in this effort. (Their Chromium dependency is a separate, later problem.)

## Repo facts

- `Marketplace = 'OLX' | 'Allegro Lokalnie' | 'Vinted'`.
- The scraping seam is `ConnectorAdapter` + `createPublicAdapter(marketplace, fetcher)` in `server/marketplaces.ts` (lines ~490–529). `fetcher: (url: string) => Promise<string>` returns an **HTML page** string today.
- `createPublicAdapter(...)` is instantiated at three call sites in `server/service.ts`:
  - `~1432` — research search (`fetchPublicSearch`)
  - `~1698` — research detail/availability (`fetchDetail`)
  - `~2104` — watch scan search (`fetchPublicSearch`)
  All three use `(url) => this.fetchPublicPage(url, source)`.
- `fetchPublicPage` (`server/service.ts` ~2162) tries plain `fetch` first, then falls back to `renderPublicPage` (`~2233`) on **403/429** or when a **marketplace session** is imported. `renderPublicPage` is the Chromium path (`chromium.connectOverCDP(SCOUT_BROWSER_WS)` or `chromium.launch(...)`).
- Parser/normalization code (do not change behavior): `parseSearchPage`, `parseListingAvailability`, `normalizeListing`, `parseOlxCards`/`parseAllegroCards`/`parseVintedCards`, `buildMarketplaceSearchUrl`, normalizers in `server/marketplaces.ts`.

**Key insight (verified):** with no imported session, OLX and Allegro Lokalnie search/detail already work over plain HTTP (no browser). Chromium is only on the hot path for (a) imported sessions, (b) bot-challenge fallback, (c) Vinted SPA rendering, (d) messaging. After this change, OLX no longer needs Chromium for anything.

---

## Verified OLX JSON API (anonymous, no session, no browser)

Confirmed by direct curl with only `User-Agent: <modern Chrome>` + `Accept: application/json`. No cookies, no CSRF, no Chromium required.

### Search
`GET https://www.olx.pl/api/v1/offers/`

Query params (from the owner + verified):
```
?query=              # search phrase
&category_id=        # category tree id
&offset=N            # pagination offset (default 0)
&limit=L             # page size
&sort_by=created_at:desc   # newest first (verified; `created_desc` => HTTP 400)
&region_id=          # region
&city_id=            # city
&district_id=        # district
&owner_type=         # e.g. private/business
&user_id=            # seller id
&last_seen_id=       # used for incremental follow-up
&filter_refiners=    # keep refiner filters
&suggest_filters=
&facets=true         # include facet metadata (verified accepted)
&sl=

&filter_float_*:from=   # numeric range lower, e.g. filter_float_price:from=500
&filter_float_*:to=     # numeric range upper, e.g. filter_float_price:to=1000
&filter_int_*:from=
&filter_int_*:to=
&filter_enum_*[0]=      # enum filter, e.g. filter_enum_state[0]=new (verified)
&filter_enum_*[1]=
```

Response shape:
```jsonc
{
  "data": [ /* Offer[] */ ],
  "metadata": {
    "total_elements": 1000,     // server-capped result count
    "visible_total_count": 145159, // real search count (use for empty detection)
    "promoted": [],
    "search_id": "...",
    "adverts": { /* config */ },
    "source": { "promoted": [0,1], "organic": [2,3,4,5] }
  },
  "links": {
    "self":     { "href": "https://www.olx.pl/api/v1/offers?query=iphone&limit=5&offset=5" },
    "next":     { "href": "...offset=10" },
    "previous": { "href": "...offset=0" },
    "first":    { "href": "...offset=0" }
  }
}
```
Pagination: follow `links.next.href` (or increment `offset`). Keep the existing cap of 10 pages (see `setMarketplacePage`, page 1–10).

### Detail / availability
`GET https://www.olx.pl/api/v1/offers/{id}/` (note trailing slash)

- `200` → `data` is a **single Offer object** (not an array) → `{ status: 'live' }`.
- `404` → body `{"error":{"status":404,"title":"Not Found","detail":"Ad not found."}}` → `{ status: 'terminal', reason: 'Ad not found.' }`.

### Offer object → fields of interest
```jsonc
{
  "id": 1094633246,                                  // number -> listingId
  "url": "https://www.olx.pl/d/oferta/...html",       // -> url
  "title": "Iphone 14 128gb.",                        // -> title
  "created_time": "2026-08-31T16:22:07+02:00",        // -> observedAt
  "description": "Witam... <br />...",                // HTML; kept in detail, not search card
  "status": "active",
  "offer_type": "offer",                              // 'offer' | 'classified'
  "params": [
    { "key":"price", "name":"Cena", "type":"price", "value": {
        "value": 1799, "currency":"PLN", "label":"1 799 zł",
        "negotiable": true,                       // -> priceNegotiable
        "type":"price","arranged":false,"budget":false
    } },
    { "key":"state", "name":"Stan", "type":"select", "value": { "key":"used","label":"Używane" } }  // -> condition (label)
    // ...other attribute params
  ],
  "photos": [
    { "id":11362482022, "filename":"...", "width":2016, "height":1512,
      "link":"https://ireland.apollo.olxcdn.com:443/v1/files/<file>/image;s={width}x{height}" }
  ],
  "location": { "city": {"name":"Kraków"}, "district": {"name":"Prądnik Biały"}, "region": {"name":"Małopolskie"} },
  "delivery": { "rock": { "offer_id":"aaaaaaaa-...", "active":true, "mode":"BuyWithDelivery" } },  // -> shippingAvailable
  "category": { "id":1812, "type":"goods" },
  "contact": { "chat": true, "phone": false }
}
```

### Field mapping to `NormalizedListing` (server/marketplaces.ts)
| `NormalizedListing` | from Offer | notes |
|---|---|---|
| `marketplace` | `'OLX'` | |
| `listingId` | `String(id)` | |
| `title` | `title` | |
| `price` | `params.find(p => p.key === 'price')?.value.value` | number; **skip/error if `type === 'free'` (value 0)** — `normalizeListing` rejects non-positive prices |
| `currency` | `'PLN'` | |
| `url` | `url` | must pass `validateSearchUrl(url, 'OLX')` |
| `imageUrl` | `photos[0]?.link.replace('{width}x{height}', '320x240')` | template substitution required; omit if none |
| `condition` | `params.find(p => p.key === 'state')?.value.label` | e.g. `'Nowe'`, `'Używane'` |
| `location` | `[region.name, city.name, district.name].filter(Boolean).join(', ')` | |
| `shippingAvailable` | `delivery?.rock?.active ?? null` | boolean or null |
| `priceNegotiable` | `priceParam.value.negotiable` | boolean; note `negotiable:false` is a real non-negotiable value, not "unknown" |
| `observedAt` | `created_time` | |

### Rules to implement
- **Empty search:** `metadata.visible_total_count === 0` or `data.length === 0` → `MarketplaceSearchResult` with `pageStatus: 'empty', empty: true`. Do **not** rely on `data` being empty alone: gibberish queries return loosely-related results with a nonzero count. (Verified: query `zzzzqkzzzx` returned 70 loosely-related items.)
- **Busy/handled:** treat a non-2xx as an error and let the existing `exponentialBackoff` / `connector_runs` logic take over; keep the existing `failClosed` behavior.
- **Detail:** reuse `parseListingAvailability` semantics but driven by HTTP status (`404`→terminal, `200+data`→live, `403/429/5xx`→unknown) since this is JSON, not HTML.

---

## Integration design (implementation guidance)

**Goal:** swap OLX's fetcher from "HTML page rendering" to "JSON API," with no change to parser/scoring/storage code.

Because `ConnectorAdapter` is typed around HTML (`fetcher: (url) => Promise<string>` and `parseSearchPage(html)`, `parseListingAvailability(html)`), the cleanest approach is a **dedicated OLX JSON adapter** rather than shoehorning JSON into the HTML parser.

### Recommended shape (in `server/marketplaces.ts`)
Add OLX-specific helpers alongside `parseOlxCards`, reusing existing exports:
- `buildOlxSearchApiUrl(query, filters, page)` → the `/api/v1/offers/` URL. Map each `MarketplaceSearchFilters` field to the API params:
  - `minPrice/maxPrice` → `filter_float_price:from` / `filter_float_price:to`
  - `condition` → `filter_enum_state[0]=<key>` (`new` verified; `used` uses the state key `used` — confirm at test time)
  - `sort` → `sort_by=created_at:desc`
  - `page` → `offset = (page-1)*limit`, `limit = 25` (or reuse any existing page size constant)
  - `shippingOnly` → note: the API does not have a direct shipping-only flag today; either drop it for OLX-JSON or post-filter on `delivery.rock.active`. Flag this decision.
- `parseOlxOffersApi(json, marketplace) → NormalizedListing[]` mapping the `data` array per the table above (wrap each in `normalizeListing`).
- `parseOlxListingAvailabilityApi(json, httpStatus) → ListingAvailability`.
- A new `createOlxJsonAdapter()` (optionally parameterized with an `http` fetch function) that implements `ConnectorAdapter`:
  - `fetchPublicSearch(url)` — receives the *search page URL*; derive `query`/filters OR change the call site to pass filters directly.
  - `fetchDetail(url)` — extract `id` from the listing URL (`/d/oferta/...-ID<slug>.html` url → the `/api/v1/offers/{id}/` call), or accept an optional id.
  - `verifyAvailability(url)` — delegate to `fetchDetail`.

> Prefer passing the original watch `query + filters` into the adapter from `service.ts` rather than parsing the OLX search URL back into a query. This keeps the filter mapping clean and avoids re-interpreting OLX's HTML URL slug.

### Call-site change (server/service.ts)
At the three `createPublicAdapter(source, ...)` sites, branch on `source === 'OLX'` to construct the JSON adapter:

```ts
const adapter = source === 'OLX'
  ? createOlxJsonAdapter('OLX', (url) => this.fetchJson(url, { marketplace: 'OLX' }))
  : createPublicAdapter(source, (url) => this.fetchPublicPage(url, source));
```

Add a `fetchJson(url, opts)` helper (plain `fetch` with the Chrome UA + `Accept: application/json`, `timeout`, and `redirect: 'manual'` like `fetchPublicPage`) that returns parsed JSON. Keep `fetchPublicPage` for the other two marketplaces.

### Scope of remaining marketplaces (do not re-probe)
- **Allegro Lokalnie:** no consumer API exists. Keep the existing plain-HTTP path. (Optionally harden headers/cookie handling; out of scope unless requested.)
- **Vinted:** no public API. Internal `api/v2/catalog/items` returns a bot-challenge page without a valid session and is undocumented/brittle. **Out of scope for this pass** unless the owner asks; keep the existing browser render fallback for now. (If pursued later: it needs a live session — UA + `X-Requested-With: XMLHttpRequest` + valid cookie/CSRF — and should keep the headless render as the safety net.)

---

## Testing & verification

- Add unit tests in `tests/marketplaces.test.ts` for `parseOlxOffersApi` / `parseOlxListingAvailabilityApi` using captured fixtures (the exact `data` object / `404` body above). Keep existing OLX card-parser tests (they can stay, since `parseOlxCards` is still exported; note it becomes unused by OLX runtime after the swap).
- No fixture file exists yet — create `tests/fixtures-olx-api.json` with a small captured search response and a removed `404` body.
- Run the standard gate from the repo root:
  ```bash
  npm run typecheck
  npm test
  npm run build
  npm audit --omit=dev
  ```
- Manual smoke (optional): `curl -sS 'https://www.olx.pl/api/v1/offers/?query=iphone&limit=25&sort_by=created_at:desc' -H 'User-Agent: <Chrome>' -H 'Accept: application/json'`.

## Risks / edge cases to document in code comments
- `price.value.type === 'free'` (value 0) listings are dropped by `normalizeListing` — acceptable, matches today's parser.
- Photos `link` contains `{width}x{height}` placeholders — substitute before storing.
- `priceNegotiable` maps from `negotiable`; `price.value.type === 'arranged'` still carries a real price (keep it).
- Empty detection by `visible_total_count === 0`, not by empty array.
- OLX may rate-limit; reuse the existing `connector_runs` backoff. Do not bypass bot fences; keep the existing CAPTCHA-non-interference posture.
