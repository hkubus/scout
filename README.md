> [!WARNING]
> This entire project is vibecoded and probably should not be used by anyone other than its original author. It may contain serious bugs, unsafe assumptions, and incomplete behavior. Use it at your own risk.

# Scout

Scout is a single-user, LAN/VPN-friendly marketplace deal monitor for public OLX, Allegro Lokalnie, and Vinted searches.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:4173. The Vite client uses the Fastify API at port 3001 and shows an offline state when the API is unavailable.

## Production (Node)

Install the locked dependencies, build the dashboard, and start the API/server process:

```bash
npm ci
npm run typecheck
npm test
npm run build

export NODE_ENV=production
export SCOUT_SECRET="$(openssl rand -hex 32)"   # keep this value; placeholders are rejected
export SCOUT_PASSWORD_HASH='scrypt$32768$8$1$…'   # node scripts/hash-password.mjs
export SCOUT_HOST=127.0.0.1
export TZ=Europe/Warsaw
export SCOUT_DB_PATH=./data/scout.sqlite
npm start
```

The compiled dashboard and API are served together on port 3001. `SCOUT_SECRET` encrypts stored credentials. See [Authentication and internet deployment](#authentication-and-internet-deployment) before exposing Scout beyond loopback. `TZ` controls the server-local 22:00–08:00 overnight window, so set it explicitly for the deployment timezone. SQLite, migrations, encrypted Discord/ntfy settings, per-channel delivery records, and notification history live under `SCOUT_DB_PATH`.

Exposure checks are based on the actual listening address, not a manually supplied flag. If a separately hosted frontend needs API access, set `SCOUT_CORS_ORIGIN` to an explicit comma-separated allowlist; CORS is disabled by default. With auth enabled such a frontend must send a bearer token from `SCOUT_API_TOKENS`: the `SameSite=Strict` session cookie is never sent cross-site, and CORS origins are not trusted for cookie-authenticated requests. `/api/health` is lightweight process liveness; `/api/ready` reports the SQLite probe, scheduler tick age, interrupted scans, migration state, and connector degradation (unauthenticated callers only see `status`).

## Authentication and internet deployment

Auth turns on as soon as any credential is configured, and protects every `/api/*` route, `/events`, and `/mcp`. Only the static dashboard shell, `/api/health`, `/api/ready`, and `/api/auth/*` are public.

| Variable | Purpose |
| --- | --- |
| `SCOUT_PASSWORD_HASH` | scrypt hash of the dashboard password. Generate it with `node scripts/hash-password.mjs` (prompts without echo, or reads stdin). Preferred over `SCOUT_PASSWORD`. |
| `SCOUT_PASSWORD` | Plaintext alternative (≥12 characters), hashed in memory at boot. |
| `SCOUT_API_TOKENS` | Comma-separated tokens (≥32 characters each). Generate them with `node scripts/generate-api-token.mjs [count]`. MCP clients and scripts send one as `Authorization: Bearer <token>`, and any token also signs in to the dashboard, so a token-only setup needs no password. |
| `SCOUT_AUTH` | `on` requires credentials even on loopback; `off` explicitly keeps the old unauthenticated trusted-LAN mode. |
| `SCOUT_TRUST_PROXY` | **Required behind a reverse proxy**: a comma-separated list of proxy IPs/CIDRs (`loopback`, `linklocal`, and `uniquelocal` also work), or a hop count such as `1`. Use `loopback` (or `127.0.0.1`) for a proxy on the same host and `uniquelocal` under Docker Compose, where the proxy connects from a bridge address; Compose defaults to `uniquelocal`. A hop count trusts whatever peer connects, so only use it when nothing but the proxy can reach Scout's port. Any other value stops startup with an error. Makes client IPs (rate limits) and `https` detection (Secure cookies, HSTS) come from `X-Forwarded-*`; without it every client shares the proxy's IP and one client can exhaust sign-in attempts for everyone. Avoid `true`: it trusts `X-Forwarded-For` from anyone, so per-IP limits can be spoofed. Leave unset when Scout is reached directly. |
| `SCOUT_PUBLIC_ORIGIN` | Public origin (e.g. `https://scout.example.com`) when the proxy does not forward the original `Host`. An `https` origin also forces `Secure` cookies and HSTS. |
| `SCOUT_ALLOWED_HOSTS` | Extra hostnames (e.g. `scout.lan`) accepted in the `Host` header while auth is off. IP addresses and `localhost` are always accepted. |

Scout refuses to start without credentials when it listens on a non-loopback address, when `SCOUT_TRUST_PROXY` or `SCOUT_PUBLIC_ORIGIN` is set (a loopback bind behind a proxy is still published), or when `SCOUT_AUTH=on`, unless `SCOUT_AUTH=off` explicitly accepts trusted-network mode. Without credentials it also answers `403` to any API request carrying `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, or `CF-Connecting-IP`, so a proxy or tunnel added later cannot publish it unprotected. `scout.service` and `.env.example` set `SCOUT_AUTH=on`. `SCOUT_SECRET` must be at least 32 random characters whenever auth is on, Scout is proxied, or `NODE_ENV=production`; documented placeholders are rejected.

- **Unauthenticated mode.** With no credentials (local development, or `SCOUT_AUTH=off` on a trusted LAN), Scout accepts only `Host` headers that are IP addresses, `localhost`, or listed in `SCOUT_ALLOWED_HOSTS`, which defeats DNS rebinding, and rejects browser requests that another site initiates. Non-browser clients such as curl and MCP clients are unaffected.

- **Browser sessions.** Signing in with the password or an API token sets an `HttpOnly`, `SameSite=Strict` session cookie (`Secure` over HTTPS). Sessions expire after 7 idle days or 30 days total and are stored server-side as SHA-256 hashes. Each session is bound to the credential it signed in with: changing the password revokes password sessions, and removing a token from `SCOUT_API_TOKENS` revokes the sessions signed in with it, and Settings → Server setup → Update and access has **Sign out everywhere**. Signing out also closes that session's open live-update stream.
- **CSRF.** Cookie-authenticated `POST`/`PATCH`/`PUT`/`DELETE` requests, including login and sign-out, must come from the same origin (`Origin`/`Sec-Fetch-Site`): the scheme, host, and port the request arrived on, or `SCOUT_PUBLIC_ORIGIN`. Behind a TLS proxy this depends on `SCOUT_TRUST_PROXY` (so Scout sees `https`) or an `https` `SCOUT_PUBLIC_ORIGIN`. Bearer-token requests are not cookie-based and are not checked.
- **Brute force.** Sign-in is limited to 10 attempts per client per 15 minutes, where a client is an IPv4 address or an IPv6 /64 (the per-IP API limits group IPv6 the same way). API-token sign-ins count toward the same limit. At most 2 password checks run at once, and extra attempts get a retryable `429`. There is no global attempt cap, so an attacker cannot use one up and block the correct password for the full window. An attacker who controls many addresses can still slow sign-in down by keeping those 2 slots busy. If more than 50,000 addresses are being tracked, new addresses get `429` until the oldest entries expire. Failed attempts are logged.
- **Live updates.** The `/events` stream checks its session every 25 seconds and closes once that session expires or is revoked.
- **Transport.** Terminate TLS in front of Scout (Caddy, nginx, Traefik) and keep Scout itself bound to loopback or a private network. Without HTTPS the password, cookie, and tokens travel in clear text.
- **Blast radius.** An authenticated user is the operator, and so is every API token: Settings → System update (`git pull`, build, restart) stays available. Give tokens only to clients you would trust with the whole instance. The read-only [Debug API](#debug-api) is off by default while auth is on; set `SCOUT_DEBUG_API=true` to enable it.

Minimal Caddy example:

```
scout.example.com {
  reverse_proxy 127.0.0.1:3001
}
```

…with `SCOUT_HOST=127.0.0.1`, `SCOUT_TRUST_PROXY=loopback`, `SCOUT_PUBLIC_ORIGIN=https://scout.example.com`, and credentials for Scout. Under Docker Compose keep the default `SCOUT_TRUST_PROXY=uniquelocal`. After deploying, make one failed sign-in and check that the log shows your own IP address, not the proxy's; Scout also logs a warning when forwarded headers arrive from a proxy it does not trust.

For a source checkout, the deployment checks are:

```bash
npm run typecheck
npm test
npm run build
```

## Notifications

Settings supports Discord webhooks and ntfy topics. Each channel has its own minimum deal priority (`Strong`, `Very strong`, or `Exceptional`), so ntfy can be limited to only the most important alerts while Discord receives the broader stream. ntfy uses the standard JSON publish API and can optionally send a bearer access token; credentials are encrypted with `SCOUT_SECRET`. With "Open alerts in the Scout iOS app" on, tapping an ntfy alert opens the listing in the [iOS app](#ios-app) through a `scout://` link, and an "Open listing" action button keeps the marketplace page one tap away. Alerts are owned by the watch that produced them, are suppressed for unchanged qualifying observations, and retry failed or interrupted deliveries with capped backoff from the scheduler.

An alert needs a ready baseline (30 comparable samples and 6 hours of watch history), an 18%+ discount below the learned median, and — for discounts between 18% and 20% — a robust price-deviation score of at least 3.1 (scaled by watch sensitivity). A **Very strong** discount (20%+ below the median) alerts as soon as the watch is ready even when the watch's own price spread fails that deviation test, so a heterogeneous search cannot keep silencing genuine discounts forever. Higher-priority deals are still subject to the description-verification safeguard below.

Each watch can also set two alert rules of its own:

- **Target price:** a listing at or below it alerts at once, even while the watch is still learning. It goes to every configured channel, whatever that channel's minimum priority or digest setting, with a "Target price hit" title. The feed marks such listings with a **Target** chip.
- **Minimum saving:** a deal alert also needs the listing to be at least this many złoty below the typical price. It keeps cheap items with a big percentage but a tiny saving from alerting. Target-price hits ignore it, and it never changes the feed or the deal labels.

ntfy alerts attach the listing photo, which the phone downloads from the marketplace. Alongside the price they show the typical price, the złoty saved, the estimated net, and the listing's condition, seller type, shipping and age. Discord embeds carry the same context.

**Estimated net** (the feed's *Est. net* column and the alerts) is what reselling at the typical asking price on the same marketplace would leave after that platform's seller fee from the [Flips](#flips-ledger) fee presets, minus the buy price. It is built from asking prices, not completed sales, so treat it as an upper estimate. It is display-only and never decides whether a deal alerts.

Daily deal digests can be enabled for Discord, ntfy, or both at a configurable server-local time. On digest-enabled channels, Strong and Very strong deals are bundled into one ranked daily summary while Exceptional deals remain immediate. Empty digests are suppressed, unchanged listings are not repeated, and meaningful price drops or priority increases can appear in a later digest. Digest creation and per-channel delivery are durable and use the same capped retry behavior as immediate alerts.

## Manual search

The Search page queries OLX, Allegro Lokalnie, and Vinted live and applies the same deterministic and AI relevance filters as watch scans. Term matching folds unit spellings and joined model numbers (`128gb` matches “128 GB”, `rtx 3080` matches “RTX3080”), ignores query stopwords, and keeps single-digit models bound to whole tokens so `iphone 5` does not match “iPhone 15”. When the strict all-terms match finds nothing, a manual search falls back to matching a majority of the query tokens; user-typed Included/Excluded terms always stay strict.

Each source streams its finished page over the existing SSE channel, so a fast marketplace renders while a slow one is still fetching; the HTTP response remains authoritative and reconciles anything the stream missed. `Load more` pages past the per-request cap instead of truncating silently, and AI relevance decisions are cached by query, listing input, and model, so repeating a search reuses them instead of re-spending Jev calls. OLX searches can additionally restrict results to private sellers or business accounts (`owner_type`), a structured marketplace filter rather than a post-filter.

The listings feed (Deals → All listings, `GET /api/listings`) applies its text search, marketplace, minimum deal strength (`minStrength`), decision (including `none` for untriaged), visibility, AI-filtered (`aiFiltered=exclude|include|only`), and sort filters in SQL across every page, and its match total reflects the active filters. Deals → Top deals shows the 20 strongest Strong-or-better listings that are not hidden, passed, or filtered by AI; the "strong deals" count everywhere means Strong or better on the deal-strength scale. Deal strength weighs both the discount percentage and the złoty saved: its index is `percent × √(typical / 400 zł)`, so it equals the plain percentage at a 400 zł typical, and the tiers are Strong ≥ 12, Very strong ≥ 20, Exceptional ≥ 30 (each also needs at least 8%, 13%, and 20% as a plain percentage, since asking prices on expensive items swing widely). 100 zł off 600 zł (16.7%) is Very strong; 50 zł off 200 zł (25%) is Strong.

## Watch prefill from listings

Any listing drawer offers a `Save as watch` action that opens the deal-watch dialog pre-filled from the listing's stored data: the search phrase comes from the stored AI canonical title (or the cleaned listing title, with price tokens, sale stopwords, and city names removed), brand/model become included terms, the source is preselected, the price range spans ±25% around the asking price, and the shipping requirement follows the listing. Research listings offer the same from their row actions and the preserved-copy dialog. Prefill never triggers an AI request, and every field stays editable before saving.

## Model variants inside one watch

A broad search such as `gtx 1660` matches the 1660, 1660 Super, and 1660 Ti, which are different products with different price levels. Pooling them into one baseline makes a normal-priced Ti look expensive and an average 1660 look like a deal. The watch dialog's **Model variants** section lets one watch split its matches into separately scored models instead of creating three near-identical watches.

Each group is a label plus comma-separated match terms (all terms must appear in the normalized title; an optional exclude list vetoes a match). Matching is most-specific-first — the number of words across the required terms decides, with the declared order breaking ties — so `1660 super` and `1660 ti` take precedence over `1660` without reordering. Titles that match no group share an **Other / unclassified** bucket so misfiled listings stay visible.

Groups are generated automatically by default. A watch with no groups waits until it has 25 saved listings (hidden and AI-rejected ones excluded), then proposes groups from their titles after a scan: OpenRouter suggests them when configured, and otherwise (or if that call fails) a built-in title analysis looks for words that consistently follow the model name and are priced apart from the rest (`1660 → Super, Ti`, `iPhone 13 → Pro, Pro Max`). Every proposal is re-checked against the same titles, and a group only survives if it actually holds listings; if the titles look like a single product, Scout tries again once the watch has grown by half. Generated groups are stored like hand-made ones and never overwritten: edit, remove, or add to them in the watch dialog, or press **Suggest from listings** there to preview a fresh proposal (saved only when you save the watch; groups with unchanged terms keep their learned baselines). Untick **Generate variants automatically** in an empty group list to opt a watch out.

Every variant learns its own typical price, sample count, and readiness, and alerts are scored, gated, and labelled per model: `GTX 1660 Ti · 22% below typical`. The watch card shows a per-variant progress chip and the listings feed and drawer label each row with its variant. A watch with no groups keeps the original watch-wide baseline exactly. Editing a watch's groups re-tags its saved listings immediately; variant identity is stored per listing association, so a listing that is retitled on the marketplace can move models on its next scan.

Named variants share their statistics so each one doesn't have to learn alone: a variant's typical price is its own median once it has 10 listings, while the spread used for the z-score is pooled across all named variants (each price taken relative to its own variant's median), and alerts still need 30 samples across the named variants plus 6 hours. Other / unclassified is a mix by definition, so it keeps its own spread and the full 30-sample floor.

When no rule places a listing (slang, a missing space, an unusual title) and OpenRouter is configured, Jev picks a variant — but only for listings that would be a deal in at least one named variant, at most 10 per scan, with answers cached against the variant definitions. Only a confident pick moves a listing out of Other, and the pick lands before the AI relevance pass so it gets the same relevance check. The listing drawer's **Model variant** selector can also move a listing by hand; manual picks win over rules and Jev until switched back to automatic or until their variant is removed, while Jev picks are re-derived whenever the groups are edited.

## Manually hiding listings

Any listing can be hidden with the eye action on its row or the `Hide` button in the detail drawer. Hiding is keyed to the marketplace listing, so it removes the offer from Top deals and the default listings feed across every watch, excludes it from the dashboard counters, and suppresses its alerts (including queued immediate alerts and future daily-digest entries) even when the query, title, and description look correct. Hidden rows are kept in the database — history is retained and they can be reviewed or unhidden under Deals → All listings with the `Hidden only` / `Visible and hidden` visibility filter.

## Market research availability and history

Research snapshots are separate from deal-watch scoring. A valid empty search page is recorded as an empty snapshot; blocked, unsupported, timed-out, or ambiguous markup fails that source snapshot. A listing that disappears from search is verified at its detail URL with low concurrency. Only explicit terminal responses advance the three-check threshold; live detail pages reset the missing count, while unknown checks leave it unchanged. The UI says “no longer available” and retains the last asking price without claiming a confirmed sale.

Watches and research watches can optionally scan typo variants to catch mispriced listings whose titles misspell the product. Each scan runs at most two extra one-page searches with deterministic misspellings of the query (adjacent transpositions, vowel deletions, doubled-letter removal; Polish diacritics are preserved). The variant set rotates across scans so every variant is eventually covered without ever exceeding the one-page-per-search budget. Toggling the option on a research watch changes its criteria and therefore starts a new comparable series.

OLX searches every category by default, so a query like "rtx 3070" mostly returns whole PCs and laptops, and "iphone 13" mostly returns cases. Watches, research watches and manual searches can be scoped to one OLX category, picked from OLX's own hit counts for the query (`GET /api/marketplaces/olx/categories?query=…`). Only OLX scans use it; Allegro Lokalnie and Vinted are unaffected. Pasted OLX exact URLs keep their category and city path. Scout resolves the path through OLX and refuses to scan a path it cannot resolve exactly, instead of widening the search. A category OLX no longer accepts fails that watch's scan as a warning without backing off the whole OLX connector. Changing the category on a research watch starts a new comparable series.

Listings also carry the signals marketplaces already send with search results, so no extra requests are needed. OLX supplies when the offer was posted, when it was last refreshed or bumped, whether it is a paid placement or highlight, and whether the seller is a business account. Vinted supplies promotion and business flags; Allegro Lokalnie reports neither, so its listings stay "unknown". OLX's "newest" order is really "most recently refreshed", so rows show "Posted 14 mo ago · bumped 2 h ago", and the dashboard's **New today** counts listings posted today (or first seen today where no posting time exists) rather than re-sightings. Deal watches can learn from and alert on private sellers or business sellers only, which OLX filters natively; elsewhere a listing is dropped only when its flag says it is the other kind. They can also skip promoted listings. Research watches are not filtered this way, so their price bands keep covering the whole market.

### Probable-sale price bands

For every research series Scout computes a p25–median–p75 band of **probable sales** from ended listings. The methodology is deliberately conservative:

- A probable sale is a listing verified as no longer available (three terminal detail checks); its last asking price is used as a probable-sale estimate, **not** a confirmed sale price.
- Superseded rows (research criteria changed) never count. Rows without a verified ended reason are excluded.
- An asking price last seen more than 30 days before the listing disappeared is stale and is excluded — it describes an earlier market, not the exit price.
- Bands cover a rolling 90-day window and open up (report `learning` with the eligible count) below 4 eligible samples. Percentiles use linear interpolation.

The older raw `estimatedMedianPrice` field remains in the API payload for one release; the UI shows the probable-sale band instead.

### Research trend charts

Each research watch card offers a price-trend dialog (`GET /api/market-watches/:id/trend?days=30|90|180`). Trend points bucket the current series' price observations into days — one latest observation per listing per day — and draw the median asking price with a shaded p25–p75 band, plus the probable-sale median as a dashed reference line. Preserved-copy dialogs also show the listing's own asking-price sparkline from its stored observations. Open trend dialogs refresh automatically after research scans via the existing `market-watch` event.

### Reference series as a fallback baseline (opt-in)

A deal watch can point at a research watch (`referenceMarketWatchId`). While the watch's own baseline is below 30 comparable samples and the reference series has at least 4 eligible probable sales, new listings display a **series baseline**: the reference band's median stands in for the learned typical price, clearly chipped as "series baseline" in the table and drawer. This improves ranking and display only — the alert readiness gate (30 samples and 6 hours) is unchanged, so no alerts fire earlier than they would without a reference series. Once the watch's own history reaches the sample floor, own history always wins and new rows are marked `own-history`.

## Flips ledger

The **Flips** page records what you bought, where it is listed for sale, and what it sold for. It then shows the net profit of each flip after the platform fee and your costs. **I bought this** in a listing's details adds a flip prefilled from the listing, and that panel's resale estimate subtracts the fee of the platform you plan to sell on.

- **Fee presets** are editable. The defaults are private-seller rates as of September 2026:
  - OLX: 0% for a standard listing with OLX Przesyłka. Enter a rate if you use the optional "Zapłać, jeśli sprzedasz" model.
  - Allegro Lokalnie: 4,9% for Kup teraz or auctions in Elektronika (7,9% in other categories).
  - Vinted: 0%.

  The fee is stored with each sale, so editing a preset never rewrites past sales.
- **Delist checklist:** marking an item sold lists the other platforms it is still listed on, and the page warns about any sold item that is still up somewhere else.
- **Działalność nierejestrowana:**
  - Revenue this quarter is tracked against the quarterly limit (10 813,50 zł in 2026).
  - Sales per platform are counted against the DAC7 reporting threshold (30 sales or 2 000 € a year per platform).
  - The page produces the simplified sales record (*uproszczona ewidencja sprzedaży*): one row per day with that day's sales and the running total for the quarter, downloadable as CSV. These figures are estimates for your own records, not tax advice.

The ledger is private bookkeeping. Nothing in scanning, scoring, bands or alerts reads it (only the fee presets feed the display-only estimated net), so your own buy and sale prices never mix with marketplace asking prices. Retention never prunes it. It is included in `/api/export` and database backups, but hidden from the Debug API: it is left out of the table list, refused in read-only SQL, and emptied in debug snapshots.

### Listing on OLX, Allegro Lokalnie and Vinted

Each unsold flip can hold a listing: title, description, condition, a category keyword (such as "Słuchawki") that the extension uses to pick each site's category, an asking price per platform, and up to 20 photos. A flip added from a Scout listing starts with a title and description drafted from that original listing: its saved description, or the live page if Scout never saved one, rewritten by AI as your own listing without the previous seller's contact, location or pickup details, or copied as-is when OpenRouter is not configured; the condition comes from the AI or, failing that, from the original's own condition label. A flip added by hand can be written by AI from its title, the description so far and its note. While the flip has no photos, the original listing's photos are copied in too (a preserved research copy's images, else the live gallery, else the search thumbnail); reorder or delete them like your own. The prices are suggested from your fee presets so each platform leaves you the same amount, optionally rounded to the nearest price ending in 9,99. Add photos on the web or from the iOS app. They are resized to at most 2000 px, turned upright, stripped of metadata (GPS included) and stored as WebP on your server, private like the rest of the ledger. Photos stored before WebP are converted in the background at startup.

The **Scout listing helper** Firefox extension in [`extension/`](extension/README.md) opens a platform's listing form and fills it from the flip, photos included, following multi-step forms such as Allegro Lokalnie's to fill each field when its step appears. You check the form and publish it yourself; nothing is submitted automatically. Pressing **I published it** marks the platform in the flip's "Listed on". OLX, Allegro Lokalnie and Vinted offer no listing API for private sellers, except OLX's partner program, so a browser-side helper is the safe way to avoid typing each listing three times.

## Preserved listing copies

Research listings are preserved for market research: when a listing first appears in a research watch, Scout fetches its detail page once (bounded per scan, with a small retry budget on later scans), stores the description, and downloads the gallery images into the Scout database so the listing stays viewable after it is sold or removed. Captures are deduplicated by listing state, capped at 12 images of up to 4 MB each, and served only from Scout's own image endpoint. Use the eye action on a Saved listings row to view the preserved copy, or the save action to capture or refresh a copy on demand — including for listings that already ended. Copies live and die with their research listing row, so the daily 180-day retention cleanup also prunes them; deleting a research watch deletes its copies.

## Docker Compose

Compose binds Scout to `0.0.0.0` inside the container and publishes port 3001 to the host. The Browserless v2 image is pinned by digest and the image build uses `npm ci` from `package-lock.json`. Set `SCOUT_BROWSER_TOKEN` in `.env` (`openssl rand -hex 24`): Browserless requires it on every connection, so scripts on rendered marketplace pages cannot drive the browser. Scout also blocks those pages from requesting loopback, private, or single-label hosts and from opening WebSockets.

```bash
docker compose up -d --build
npm run test:compose
```

The smoke test requests `http://127.0.0.1:3001/api/ready` from the host. Compose requires `SCOUT_SECRET`, `SCOUT_BROWSER_TOKEN`, plus either credentials (`SCOUT_PASSWORD_HASH`/`SCOUT_PASSWORD`/`SCOUT_API_TOKENS`) or an explicit `SCOUT_AUTH=off`, because the container listens on `0.0.0.0`. Compose substitutes `${SCOUT_PASSWORD_HASH}` from the project `.env` file, so put the hash in single quotes there (`SCOUT_PASSWORD_HASH='scrypt$32768$8$1$…'`). Compose reads single-quoted `.env` values literally, so the `$` separators are left alone. Do not write them as `$$`, because that escape only applies inside `compose.yaml`. To generate a hash with the image, run `docker compose run --rm --no-deps scout node scripts/hash-password.mjs`. The published port binds to `127.0.0.1` by default (`SCOUT_PUBLISH` overrides it), so put a TLS-terminating proxy in front for internet access. Scout waits for the pinned Browserless container health check before starting. The container runs as a non-root user with a read-only application filesystem; `/app/data` is the writable SQLite volume.

## AI listing intelligence

Scout can optionally use a DeepSeek model through OpenRouter for relevance filtering and description verification without changing Scout's deterministic price scoring. Configure the OpenRouter token and model in Settings, or use environment variables for a headless deployment:

```bash
export SCOUT_OPENROUTER_API_KEY='sk-or-v1-...'
export SCOUT_OPENROUTER_MODEL='deepseek/deepseek-v4-flash'
```

The API token entered in Settings is encrypted with `SCOUT_SECRET` and is never returned to the browser. Scout sends OpenAI-compatible chat-completion requests to OpenRouter and validates every JSON response before storing it. See the [OpenRouter chat-completions docs](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) for endpoint and authentication details.

Searches can also use the AI relevance filter. It runs after Scout's deterministic filters and excludes listings where the requested item is only mentioned as an accessory, replacement part, compatible component, repair service, or unrelated context—for example, a GPU fan when searching for a GPU. Jev judges relevance from the title, price, location, and query; unsure cases fetch the detail page for a second description-enriched judgment, then fall back to a vision-model tiebreak over the thumbnail. Relevance decisions are cached per watch, listing, query, and model. The filter is enabled by default for new watches and can be disabled per watch; without an OpenRouter key, Scout falls back to deterministic filtering. Relevance checks and the bounded near-miss rescue run several Jev round trips at once instead of one at a time (default 6, tune with `SCOUT_JEV_CONCURRENCY`), which shortens cold searches without changing any decision. Manual searches carry the same choice as a watch: the **AI relevance filtering** checkbox on the search form (remembered in the browser) can skip the Jev relevance and rescue calls entirely for deterministic-only results, and saving a search as a watch carries that choice over. Set `SCOUT_JEV_MODE=legacy` to use the DeepSeek model for relevance instead.

Very strong and exceptional deals receive an additional conservative safeguard when OpenRouter is configured. Scout fetches the approved marketplace detail page, extracts the listing description, saves a deduplicated snapshot of the listing state, and asks Jev for a structured `pass`, `reject`, or `unknown` condition check; unsure judgments and Jev outages escalate to a vision model over the listing photos. Only `pass` continues to immediate alerts; explicit damage, parts-only, repair, missing-essential-component, account-lock, or similar signals—and unavailable or ambiguous descriptions—hold the high-priority alert until a later scan. Results are cached by listing description and model, and the saved snapshots can be reviewed later from the listing drawer. Without an OpenRouter key the existing deterministic alert behavior remains active. Set `SCOUT_JEV_MODE=legacy` to use the DeepSeek model for verification instead.

Each watch can also list up to 8 **Jev verification checks** (watch dialog → More options), each up to 120 characters. Jev answers each one in the same verification call, and code decides what the answer means. A **Require** check (for example `includes original charger`) lets the deal pass only after a confident yes. A confident no rejects it, and an unclear answer holds the alert and sends the listing to the vision model, which sees the same checks. An **Exclude** check (for example `iCloud locked`) rejects only when Jev is near-certain the listing matches (confidence ≥ 0.95). Anything less is ignored, so a suspicion never hides a deal. Failed and unconfirmed checks appear as issues on the stored verification. Checks are part of the verification cache key, so editing them re-verifies affected deals on their next scan, while watches with no checks keep their cached verdicts.

The Search form's **Jev checks** (under Filters) run the same Require/Exclude checks on manual search results, after the relevance filter. Results Jev rejects are dropped and counted in the marketplace status line. The rest are tagged `Jev ✓`, `Unconfirmed`, or `Not checked`. When the search has a Require check, only `Jev ✓` results show until you tick **Show unconfirmed**. Jev reads the description the OLX offers API already returned; for other listings Scout fetches up to 12 detail pages per marketplace per page, and anything beyond that is judged from the title only. Each marketplace page spends at most 40 uncached Jev calls. Verdicts that had a description are cached per listing and check list, so repeating a search costs nothing. Checks need an OpenRouter key and Jev live mode, and **Save as watch** carries them into the new watch.

Jev and vision requests retry transient OpenRouter provider failures with backoff. The legacy DeepSeek verification path uses OpenRouter response healing and retries once on malformed JSON. If a technical OpenRouter failure remains, Scout records a `fallback` status and sends the deterministic alert while showing the error; explicit `reject` and `unknown` decisions still hold the alert.

## MCP server (Streamable HTTP)

Scout exposes a Model Context Protocol server over Streamable HTTP at `POST /mcp` (same host/port as the API), so AI assistants connect over HTTP instead of stdio:

```bash
curl -s -X POST http://127.0.0.1:3001/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

It is stateless (one fresh server per request, no session ids) and offers thirteen tools (plus the four read-only `scout_debug_*` tools while the [Debug API](#debug-api) is enabled): `scout_readiness`, `scout_dashboard`, `scout_watches`, `scout_listings` (compact 20-row default, max 50), `scout_listing_detail`, `scout_watch_analytics`, `scout_analytics`, `scout_market_research`, `scout_market_trend`, `scout_search` (live marketplace fetch), `scout_olx_categories` (live OLX category counts for a query), `scout_queue_scan`, and `scout_connectors`. `GET`/`DELETE /mcp` return 405; the endpoint shares the API's rate limits (30/min per IP), CORS policy, and security headers. With auth enabled, MCP clients must send `Authorization: Bearer <token>` using a value from `SCOUT_API_TOKENS`.

## iOS app

`ios/` contains a native SwiftUI client covering the deal feed, search, listing triage, deal and research watches, analytics, and Home Screen widgets. It is built on GitHub's macOS runners from the push mirror and installed with SideStore. See [`ios/README.md`](ios/README.md).

## Debug API

For development and troubleshooting, Scout exposes read-only access to the live database under `/api/debug/*`. It is on by default only while auth is off; with auth enabled set `SCOUT_DEBUG_API=true` to turn it on (and `false` always disables it). With auth enabled every debug request needs a session or API token:

| Endpoint | Returns |
| --- | --- |
| `GET /api/debug/schema` | Every table and view with columns, indexes, and row counts, plus database/WAL size and applied migrations. |
| `GET /api/debug/tables/:table?limit=&offset=&orderBy=&direction=` | Raw rows from one table, newest first by rowid (max 1000 per page). |
| `POST /api/debug/query` | One read-only SQL statement: `{"sql": "SELECT ... WHERE id = ?", "params": [1], "maxRows": 500}` (max 5000 rows; `truncated` reports a cut). |
| `GET /api/debug/runtime` | Uptime, memory, Node version, non-secret environment configuration, readiness, settings, and the in-memory log buffer. |
| `GET /api/debug/snapshot` | A consistent `VACUUM INTO` copy of the whole SQLite database for local analysis (`curl -o scout.sqlite ...`). |

```bash
curl -s -X POST http://127.0.0.1:3001/api/debug/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT marketplace, COUNT(*) AS n FROM listings GROUP BY marketplace"}'
```

Each query runs in a short-lived child process on its own read-only SQLite connection with `query_only` set, and is stopped after 5 seconds, so a runaway query cannot stall Scout. Only `SELECT`, `WITH`, `VALUES`, `EXPLAIN`, and `PRAGMA` statements are accepted, so the debug API cannot modify data. Values in the encrypted-credential format are replaced with `[redacted: encrypted secret]` wherever they appear in a value, the encrypted marketplace session column reads as `NULL`, and BLOBs are summarized by size; the snapshot blanks encrypted settings and marketplace browser sessions before download. Redaction is best-effort against deliberate SQL transformations, so treat debug access as access to the encrypted credentials. The same surface is available to MCP clients as `scout_debug_schema`, `scout_debug_table`, `scout_debug_query`, and `scout_debug_runtime`. The debug API exposes the full listing and notification history.

## Optional marketplace sessions

Scout can use a manually authenticated browser session for your own OLX, Allegro Lokalnie, or Vinted account. This keeps the marketplace login and any MFA/CAPTCHA steps in your browser; Scout does not collect passwords or attempt to bypass verification.

To create a Playwright storage-state file on a machine with a visible Chromium installation:

```bash
npm run marketplace:login -- --marketplace "OLX"
```

After logging in, import the generated JSON from Settings → Marketplace accounts. Session state is encrypted with `SCOUT_SECRET`, restricted to the selected marketplace domain, and never returned by the API. Allegro Lokalnie imports may also contain the related `allegro.pl` account-auth origin used by its sign-in flow. Sessions can expire and must then be re-imported. Do not paste raw `Cookie` headers or commit storage-state files.

## Safety boundaries

Scout only accepts HTTPS URLs from the approved marketplace domains. It does not store marketplace passwords, bypass CAPTCHAs, rotate proxies, spoof fingerprints, or automatically purchase. Optional Playwright session state is encrypted at rest, scoped to one approved marketplace, and supplied by the user after a manual login. Connector adapters intentionally fail closed when a public page cannot be normalized. Requests are paced: each marketplace has at most two requests in flight across all scans and searches, at most two Chromium renders run at once, and a failed scan or research run pauses that marketplace for 5 minutes, doubling with each consecutive failure up to 6 hours.

## Recovery and retention

Use Settings → Server setup → Data to download a redacted JSON export or create a SQLite backup beside the configured database. The backup uses SQLite's WAL-aware `VACUUM INTO` operation and is written with restrictive permissions where supported. Keep backups outside the application directory as well; a database backup contains private history and encrypted credentials. Retention cleanup runs daily and prunes operational history after 180 days while preserving active watch definitions and research series metadata. Watch price history is stored compactly: a scan that sees an unchanged price updates that day's latest observation instead of adding a new one, so each listing keeps its price changes plus at most two rows per unchanged day. Daily analytics are unaffected, and the observation count shown in watch analytics counts stored price points, not scans.

To restore a verified backup, stop Scout first and run `npm run db:restore -- --backup /secure/path/scout.sqlite.backup.sqlite --confirm`. Add `--database /path/to/scout.sqlite` when `SCOUT_DB_PATH` is not the target. The command validates SQLite integrity, stages the replacement atomically, and keeps the previous database in a recoverable `.before-restore-*` file. Restored databases have no sign-in sessions, so sign in again afterwards.

For systemd deployments, install the built `dist-server` artifact under `/opt/scout`, create the dedicated `scout` user, grant it ownership of `/var/lib/scout`, and place `SCOUT_SECRET` and `SCOUT_PASSWORD_HASH` (plus `SCOUT_TRUST_PROXY` behind a proxy) in `/etc/scout/scout.env` with mode `0600` before enabling `scout.service`. Single-quote the hash there too (`SCOUT_PASSWORD_HASH='scrypt$…'`).
