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

**Update 2026-08-31 (researched, live-tested):** anonymous JSON paths were also found for **Allegro Lokalnie** (undocumented `allegrolokalnie.pl/api/*` + JSON-LD embedded in search HTML) and **Vinted** (`/api/v2/catalog/items` with a one-request anonymous cookie bootstrap). The claims below in "Scope of remaining marketplaces" that said otherwise are outdated — see the two new sections after the OLX one.

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

## Verified Allegro Lokalnie JSON API (anonymous, no session, no browser) — researched 2026-08-31

The earlier claim "no consumer API exists" was **wrong**: `allegrolokalnie.pl/api/*` is an undocumented, anonymous, captcha-exempt JSON API (live since ≥2019 per Wayback CDX; latest endpoint sightings: `similar_offers` 2026-08-29, `listing_ads` 2026-08-21). What it lacks is phrase-search — search stays on the SSR HTML page, which embeds a machine-readable JSON-LD `ItemList` (below).

All requests verified with only a modern Chrome `User-Agent` (+ `Accept: application/json`). No cookies, no CSRF, no browser, no rate-limit headers observed. Notable asymmetry: in the same test session, HTML pages got 403 DataDome (allegro.pl) / 429 AllegroCaptcha (allegrolokalnie.pl) while `/api/*` returned 200 — the JSON surface currently bypasses the bot fence. Treat that as fragile; do not hammer.

### Batch enrichment: `POST /api/additionaldata/offers` (verified anonymous)
Body: `{"offer_ids": ["<uuid>", ...]}` — the site itself batches **60 per request** (harvested from its own search page). Works with no cookies/CSRF at all.

Response: `200` JSON **array** of GA4-ecommerce-style objects:
```jsonc
{
  "item_type": "buy_now",              // 'buy_now' | 'classified' | 'bidding' (auction/Licytacja; verified 2026-09)
  "item_id": "lenovo-legion-7-...",     // ⚠️ SLUG, not the uuid
  "item_brand": "Lenovo",
  "item_category": "Laptopy",
  "item_category_path": "Elektronika>Komputery>Laptopy",
  "item_name": "Lenovo Legion 7 ...",
  "item_price": "4900.00",             // string
  "item_quantity": 1,
  "item_root_category": "Elektronika",
  "item_variant": "very_good"          // condition enum: brand_new | very_good | visibly_used
}
```
Gotchas (verified):
- **Invalid/unknown uuids are silently dropped** — response array is shorter than the input (a well-formed bogus uuid just doesn't come back).
- **Response order is arbitrary, not positional** (verified with single-element and mixed requests), and the response carries **no uuid** — only the slug.
- Correlation is therefore done from the **search page**, which has both: offer uuid (in `data-card-analytics-click`) and slug (in the item URL). Use the batch for enrichment (condition/brand/category), **not** for per-id availability.
- Missing vs. `similar_offers`: no `price_negotiable`, no city, no photos, no timestamps.

### Offer detail: `GET /api/offers/{uuid}` (verified anonymous)
```jsonc
// 200
{ "offer": { "id": "<uuid>", "type": "buy_now", "title": "...", "slug": "...",
             "user_id": "...", "price_cents": 480000, "price": "4800.00",
             "main_photo": { "normal": "https://...", "thumb": "https://..." } } }
```
- `main_photo.normal` = full-size image, no `{width}x{height}` placeholders.
- ⚠️ **Not a liveness check**: offers archived in 2020 and 2023 still returned `200` (it's a summary cache). Malformed uuid → `400 "Bad Request"`. No `404` case observed (untested for freshly removed offers). Liveness decisions stay on the HTML detail page / search re-encounter.

### Category offers: `GET /api/similar_offers?offer_id={uuid}&category_id={uuid}&category_tree=navigation` (verified anonymous)
`200` → `{"offers": [ /* ~15 items */ ], "similar_offers_listing_url"}`. `offer_id` is required (omitting → 400). Rich object → `NormalizedListing` mapping:

| `NormalizedListing` | from offer | notes |
|---|---|---|
| `listingId` | `id` | uuid |
| `title` | `title` | |
| `price` | `price_cents / 100` | also `prices.price_cents`, `initial_price_cents`, `price_reduction_percentage` |
| `currency` | `'PLN'` | implicit |
| `url` | `offer_url` | `https://allegrolokalnie.pl/oferta/{slug}` |
| `imageUrl` | `photo_url` | `s180x180b` size baked into URL; swap prefix for `s512x512` / `original` |
| `condition` | `condition` | enum: `brand_new` / `very_good` / `visibly_used` |
| `location` | `city` | city name only |
| `shippingAvailable` | `type === 'buy_now'` | proxy; `smart` flag also present; `classified` presumably = ogłoszenie |
| `priceNegotiable` | `price_negotiable` | **explicit boolean** — better than the HTML text heuristic |
| `observedAt` | `analytics.inserted_at` / `created_at` / `updated_at` | ISO-8601; also `category_path`, `inventory_quantity`, `seller_id` |

### Misc anonymous endpoints (all verified 200)
- `GET /api/search/suggestions/?phrase=iphone` → phrase suggestions
- `GET /api/cities/?name=kr` → `{cities:[{id,name,state,slug,county}]}`
- `GET /api/categories/tree?parent_id={uuid}` → category uuids (needed for `similar_offers` / `listing_ads`)
- `GET /api/listing_ads/?category_id={uuid}` → promo banners only, not listings
- SPA bundles (`lokalnie-prod-assets.storage.googleapis.com/ui/versions/<hash>/assets/*.js`) reference only `listing_ads`, `offers/{id}/follow` (PUT), `user_preferences*`, `cities/` — search itself is SSR SEO-URL navigation.

### Search: SSR HTML + embedded JSON-LD `ItemList`
`https://allegrolokalnie.pl/oferty/q/{phrase}` embeds a ~41KB `<script type="application/ld+json">` schema.org `ItemList` (60 items/page, verified from a 2026-03 archived snapshot):
```jsonc
{ "@type": "ItemList", "itemListElement": [{ "position": 1, "item": {
    "name": "...",
    "image": { "url": "https://a.allegroimg.com/original/..." },
    "url": "https://allegrolokalnie.pl/oferta/<slug>",
    "offers": { "price": "119", "priceCurrency": "PLN" },
    "itemCondition": "https://schema.org/NewCondition" } }] }
```
Mapping: `name`→title, `offers.price`→price, `priceCurrency`→currency, `url`→url, `image.url`→imageUrl, `itemCondition`→condition. **Recommend parsing this blob instead of the `mlc-itembox` card regexes** — far more stable. Cards/`data-card-analytics-click` remain the source for the uuid and for location/shipping/negotiable (not in JSON-LD).

⚠️ The JSON-LD `ItemList` includes **auctions**, which have no format field there. Only the rendered cards expose the format (`mlc-itembox__offer-type--buy_now` / `--classified` / `--bidding` = `Kup teraz` / `Ogłoszenie` / `Licytacja`). Scout monitors fixed-price listings, so auction slugs are read off the cards and their JSON-LD twins are dropped (see `allegroAuctionSlugs` in `server/marketplaces.ts`). Without this, auctions leak into results with `shippingAvailable: null`.

### Official `api.allegro.pl` (OAuth) — buys nothing for Lokalnie
1. Register at apps.developer.allegro.pl (free, ≤5 app keys, 2FA required on the prod account; sandbox needs none) → Client ID/Secret.
2. `POST https://allegro.pl/auth/oauth/token`, `Authorization: Basic base64(id:secret)`, `grant_type=client_credentials` → JWT valid **12h** (mint new; no refresh for this grant).
3. Call with `Authorization: Bearer` + **`Accept: application/vnd.allegro.public.v1+json`** (generic `application/json` → 406) + custom `User-Agent: AppName/1.0 (+https://info-url)` (mandatory since June 2026, ToS art. 3.4c).
4. **But:** `/offers/listing` is verified-apps-only since 2021 (`403 AccessDenied`/`VerificationRequired`; gate ≈100 app users / Allegro VIP, unanswered 2025–2026 forum requests), and it does not index Lokalnie classifieds anyway. Not worth pursuing for this use case.

### Raw evidence (2026-08-31)
| Request | Status | Result |
|---|---|---|
| `api.allegro.pl/offers/listing` + `Accept: application/json` | 406 | header error |
| same + `Accept: application/vnd.allegro.public.v1+json` | 401 | `WWW-Authenticate: Bearer realm="oauth2-resource"` |
| `allegro.pl/listing?string=...` | 403 | DataDome (`captcha-delivery.com`) challenge |
| `allegrolokalnie.pl/oferty/q/...` | 429 | AllegroCaptcha iframe (curl **and** Node undici — not client-TLS dependent) |
| `POST /api/additionaldata/offers` (3 valid uuids) | 200 | 3 items, arbitrary order |
| same + 1 bogus uuid | 200 | 2 items — bogus silently dropped |
| `POST` with a **single** uuid ×2 | 200 | stable uuid→item mapping across requests |
| `GET /api/offers/{uuid}` (live + 2020 + 2023 offers) | 200 | detail summary; no removal signal on old ones |
| `GET /api/offers/not-a-uuid` | 400 | `"Bad Request"` |
| `GET /api/similar_offers?offer_id=...&category_id=...&category_tree=navigation` | 200 | 22.5 KB rich JSON |
| `GET /api/similar_offers` (no offer_id) | 400 | offer_id required |
| `GET /api/v1/offers`, `/api/graphql` | 404 | dead paths |

---

## Verified Vinted JSON search + HTML detail (anonymous, no login) — researched 2026-08-31

Verdict: **search works over JSON with no login/OAuth/CAPTCHA** — the earlier claim that `api/v2/catalog/items` "returns a bot-challenge page without a valid session" was half-wrong: with **no cookies** you get a clean `401` JSON (`invalid_authentication_token`), not a challenge; after a **single plain `GET https://www.vinted.pl/`** (collecting Set-Cookie naturally, no login) the same call returns `200` full JSON. The only Cloudflare challenge hit was on the **item-detail JSON route**, which we don't need (item HTML page works).

Tested from a residential PL IP (46.149.212.35). **Datacenter IPs may get 403 on the very first `GET /`** (Cloudflare; community-confirmed). Keep the existing Chromium render as the fail-closed fallback.

### Minimal request recipe (verified)
**Step 1 — cookie bootstrap (1 request, per domain):**
```
GET https://www.vinted.pl/
  User-Agent: <modern Chrome>
  Accept: text/html,application/xhtml+xml,...
  Accept-Language: pl-PL,pl;q=0.9
```
Cookies set (no login involved): **`access_token_web`** (`.vinted.pl`, HttpOnly, **7-day** JWT with payload `{client_id:"web", scope:"public", iss:"vinted-iam-oauth", aud:"fr.core.api.vinted.com"}`) ← the one that matters; `refresh_token_web` (`.www.vinted.pl`, 90-day) — presumably mints fresh access tokens without re-visiting (untested); `anon_id`, `v_udt`, `anonymous-iso-locale=pl-PL`, `__cf_bm` (Cloudflare). The `datadome` cookie is actively **cleared** on first visit → DataDome is not the fence here; protection is Cloudflare.

**Step 2 — search (verified 200):**
```
GET https://www.vinted.pl/api/v2/catalog/items
    ?search_text=lego&per_page=20&page=1&order=newest_first
    &price_from=20&price_to=150&status_id=6
  Cookie: <jar from step 1>
  User-Agent: <same Chrome UA>
  Accept: application/json
```
`X-Requested-With`/`Origin`/`Referer` **not** required. On `401` → re-run step 1 (community pattern; 401 body: `{"code":100,"message":"...","message_code":"invalid_authentication_token"}`).

**Per-domain caveat (verified):** cookies and API are per-ccTLD — bootstrap and call the same domain (`www.vinted.pl` jar ≠ `www.vinted.fr`). Note `.pl` search results are **international by default** (Czech/Estonian items observed); restrict with `country_ids` if PL-only is expected.

**Verified params:** `search_text`, `per_page`, `page` (`pagination.current_page` honored), `price_from`, `price_to`, `status_id` (6 = "Nowy bez metki"; UI URLs use `status_ids[]`), **`order=newest_first`** (verified strictly descending item ids). ⚠️ **`sort=` is silently ignored** (200 + relevance order) — must use `order=`. Community-documented: `brand_ids`, `catalog_ids`, `size_ids`, `color_ids`, `material_ids`, `country_ids`, `city_ids`, `currency`, `is_for_swap`.

**Response:** `{ "items": [...], "pagination": { current_page, total_pages, total_entries, per_page }, "search_tracking_params": {...}, "code": 0 }`

### Search item → `NormalizedListing`
| `NormalizedListing` | from item | notes |
|---|---|---|
| `listingId` | `id` | number; higher ≈ newer |
| `title` | `title` | |
| `price` / `currency` | `price.amount` (string) / `price.currency_code` | also `service_fee`, `total_item_price` |
| `url` | `url` | `path` is relative |
| `imageUrl` | `photo.url` | f800 webp/jpeg; `photo.thumbnails[]`, `full_size_url` also available |
| `condition` | `status` | **local label** (`"Bardzo dobry"`, `"Nowy z metką"`); no numeric `status_id` in items |
| `brand` | `brand_title` | extra, if needed |
| `priceNegotiable` | — | **absent** from search items |
| `location` / `shippingAvailable` | — | **absent** from search items |
| `observedAt` | — | `created_at_ts` absent as of 2026-08 on vinted.pl → use fetch time (matches the OLX design) |

Extras: `promoted` ("Podbity"), `favourite_count`, `view_count`, `size_title`, `user{id,login,business}`, `conversion{seller_price, seller_currency, buyer_currency, fx_*}` (seller lists in EUR, buyer sees PLN).

### Detail / availability — JSON route is dead for anonymous clients; use the item page
- `GET /api/v2/items/{id}` → **404** with an HTML body but `content-type: application/json` header (misleading; route doesn't exist anonymously, even for items listed seconds earlier).
- `GET /api/v2/items/{id}/details` → **403** Cloudflare challenge (`/cdn-cgi/challenge-platform`) — the only challenge hit in the whole session.
- **Working detail recipe — public item page (plain HTTP, no browser):** `GET /items/{id}` → `307` to canonical `/items/{id}-{slug}` (bogus id → 404; the redirect is itself an existence signal). The 200 page embeds schema.org LD-JSON:
```jsonc
{ "@type": "Product", "name": "...", "description": "...", "image": [...],
  "brand": { "name": "..." }, "category": "...", "color": "...",
  "offers": { "price": 45, "priceCurrency": "PLN", "availability": "InStock",
              "itemCondition": "UsedCondition", "url": "..." } }
```
plus OG tags in `<head>` as fallback (title/description/url/image — the Giglium wrapper streams only up to `</head>`). Availability semantics: `200 + offers.availability: "InStock"` → live; `404` → terminal/removed. "Sold" state unverified — flag for a one-off test the first time an observed item sells.

### Rate limiting & risks
- No `X-RateLimit-*`/`Retry-After` headers observed anywhere. Community uses backoff on 401 and re-bootstrap.
- **IP reputation:** everything above is from one residential-looking PL IP; datacenter deployments may be 403'd on the first `GET /` (do not bypass — fail closed to the Chromium fallback).
- **Undocumented internal API:** field names, params (`order` vs `sort`), and routes (`/api/v2/items/{id}` recently vanished, `created_at_ts` used to exist) can change silently.
- **Per-domain sessions:** cookie jar, tokens, and catalog are per-ccTLD; `access_token_web` expires in 7 days (re-bootstrap or use `refresh_token_web`).
- **No official public API / developer program exists** (unchanged as of 2026; corroborated by all known wrappers).

### Community corroboration (2024–2026)
`Giglium/vinted_scraper` (pushed 2026-08-30): bootstrap = `GET /` → `access_token_web`; search = `/api/v2/catalog/items`; 401 → refresh cookies; item JSON blocked → parse item page `<head>` OG tags; UA pool auto-updated via CI; issue #59 = 403 on first `GET /` from flagged IPs. `Fuyucch1/Vinted-Notifications` (pyVintedVN, 2025): per-locale domain + `Host` header, 401/404 → cookie refresh, params incl. `order`, `status_ids`, `brand_ids`, `country_ids`. Also `Androz2091/vinted-api`, `Pawikoski/vinted-api-wrapper`, `herissondev/vinted-api-wrapper` — all use the same internal API; none uses an official one.

### Raw evidence (2026-08-31, 11 requests total)
| Request | Status | Result |
|---|---|---|
| `catalog/items?search_text=iphone`, no cookies | 401 | clean JSON `invalid_authentication_token` |
| `GET /` (bootstrap) | 200 | cookies incl. `access_token_web` (7d JWT, scope public); `datadome` cleared |
| `catalog/items?search_text=lego&per_page=5` + jar | 200 | 52 KB JSON, full item shape |
| + `page=2&price_from=20&price_to=150&status_id=6&sort=newest_first` | 200 | filters honored; `sort=` ignored |
| + `order=newest_first` | 200 | strictly descending ids → `order=` is the real param |
| `/api/v2/items/{id}` (fresh item) | 404 | HTML body, fake `content-type: application/json` |
| `/api/v2/items/{id}/details` | 403 | Cloudflare challenge HTML |
| `/items/{id}` (bare id) | 307 | → `/items/{id}-{slug}` |
| `/items/9999999999-bogus` | 404 | |
| `/items/{id}-{slug}` | 200 | LD-JSON `Product{offers{availability:"InStock"}}` + OG tags |

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

### Scope of remaining marketplaces (updated 2026-08-31 — superseded by the two sections above)
- **Allegro Lokalnie:** anonymous JSON exists (`/api/offers/{uuid}`, `/api/similar_offers`, batch `POST /api/additionaldata/offers`) but **no phrase-search endpoint** — search stays on plain HTTP HTML, ideally parsing the embedded JSON-LD `ItemList` (uuid from `data-card-analytics-click`, slug from the URL). Liveness stays on HTML detail status; `/api/offers/{uuid}` is not a removal signal.
- **Vinted:** JSON search works with a one-request anonymous cookie bootstrap (`GET /` → `access_token_web`, then `/api/v2/catalog/items?order=newest_first`; re-bootstrap on 401). Detail/availability via the public item page's LD-JSON (`availability: InStock` / 404). Chromium render stays as the fail-closed fallback for Cloudflare-fenced IPs.
- Earlier notes that "no consumer API exists" (Allegro) and "api/v2 returns a bot-challenge without a session" (Vinted) were wrong or half-wrong; do not rely on them.

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
