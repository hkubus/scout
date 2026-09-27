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
export SCOUT_SECRET='replace-with-a-random-value-at-least-32-characters-long'
export SCOUT_HOST=127.0.0.1
export TZ=Europe/Warsaw
export SCOUT_DB_PATH=./data/scout.sqlite
npm start
```

The compiled dashboard and API are served together on port 3001. `SCOUT_SECRET` encrypts stored credentials. Scout has no built-in authentication, so keep `SCOUT_HOST=127.0.0.1` unless the service is intentionally restricted to a trusted LAN/VPN; do not expose it directly to the public internet. `TZ` controls the server-local 22:00–08:00 overnight window, so set it explicitly for the deployment timezone. SQLite, migrations, encrypted Discord/ntfy settings, per-channel delivery records, and notification history live under `SCOUT_DB_PATH`.

Exposure warnings are based on the actual listening address, not a manually supplied flag. Do not expose Scout directly to the public internet. If a separately hosted frontend needs API access, set `SCOUT_CORS_ORIGIN` to an explicit comma-separated allowlist; CORS is disabled by default. `/api/health` is lightweight process liveness; `/api/ready` reports the SQLite probe, scheduler tick age, interrupted scans, migration state, and connector degradation.

For a source checkout, the deployment checks are:

```bash
npm run typecheck
npm test
npm run build
```

## Notifications

Settings supports Discord webhooks and ntfy topics. Each channel has its own minimum deal priority (`Strong`, `Very strong`, or `Exceptional`), so ntfy can be limited to only the most important alerts while Discord receives the broader stream. ntfy uses the standard JSON publish API and can optionally send a bearer access token; credentials are encrypted with `SCOUT_SECRET`. Alerts are owned by the watch that produced them, are suppressed for unchanged qualifying observations, and retry failed or interrupted deliveries with capped backoff from the scheduler.

An alert needs a ready baseline (30 comparable samples and 6 hours of watch history), an 18%+ discount below the learned median, and — for discounts between 18% and 20% — a robust price-deviation score of at least 3.1 (scaled by watch sensitivity). A **Very strong** discount (20%+ below the median) alerts as soon as the watch is ready even when the watch's own price spread fails that deviation test, so a heterogeneous search cannot keep silencing genuine discounts forever. Higher-priority deals are still subject to the description-verification safeguard below.

Daily deal digests can be enabled for Discord, ntfy, or both at a configurable server-local time. On digest-enabled channels, Strong and Very strong deals are bundled into one ranked daily summary while Exceptional deals remain immediate. Empty digests are suppressed, unchanged listings are not repeated, and meaningful price drops or priority increases can appear in a later digest. Digest creation and per-channel delivery are durable and use the same capped retry behavior as immediate alerts.

## Watch prefill from listings

Any listing drawer offers a `Save as watch` action that opens the deal-watch dialog pre-filled from the listing's stored data: the search phrase comes from the stored AI canonical title (or the cleaned listing title, with price tokens, sale stopwords, and city names removed), brand/model become included terms, the source is preselected, the price range spans ±25% around the asking price, and the shipping requirement follows the listing. Research listings offer the same from their row actions and the preserved-copy dialog. Prefill never triggers an AI request, and every field stays editable before saving.

## Model variants inside one watch

A broad search such as `gtx 1660` matches the 1660, 1660 Super, and 1660 Ti, which are different products with different price levels. Pooling them into one baseline makes a normal-priced Ti look expensive and an average 1660 look like a deal. The watch dialog's **Model variants** section lets one watch split its matches into separately scored models instead of creating three near-identical watches.

Each group is a label plus comma-separated match terms (all terms must appear in the normalized title; an optional exclude list vetoes a match). Matching is most-specific-first — the number of words across the required terms decides, with the declared order breaking ties — so `1660 super` and `1660 ti` take precedence over `1660` without reordering. Titles that match no group share an **Other / unclassified** bucket so misfiled listings stay visible.

Every variant learns its own typical price, sample count, and readiness, and alerts are scored, gated, and labelled per model: `GTX 1660 Ti · 22% below typical`. The watch card shows a per-variant progress chip, the listings feed and drawer label each row with its variant, and `scoreDeal` itself is unchanged — it simply receives the selected model's price history. A watch with no groups keeps the original watch-wide baseline exactly. Editing a watch's groups re-tags its saved listings immediately and deterministically; variant identity is stored per listing association, so a listing that is retitled on the marketplace can move models on its next scan.

## Market research availability and history

Research snapshots are separate from deal-watch scoring. A valid empty search page is recorded as an empty snapshot; blocked, unsupported, timed-out, or ambiguous markup fails that source snapshot. A listing that disappears from search is verified at its detail URL with low concurrency. Only explicit terminal responses advance the three-check threshold; live detail pages reset the missing count, while unknown checks leave it unchanged. The UI says “no longer available” and retains the last asking price without claiming a confirmed sale.

Watches and research watches can optionally scan typo variants to catch mispriced listings whose titles misspell the product. Each scan runs at most two extra one-page searches with deterministic misspellings of the query (adjacent transpositions, vowel deletions, doubled-letter removal; Polish diacritics are preserved). The variant set rotates across scans so every variant is eventually covered without ever exceeding the one-page-per-search budget. Toggling the option on a research watch changes its criteria and therefore starts a new comparable series.

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

Separately opt-in in Settings, `Cap offers with a reference series band` uses the reference series' probable-sale band in negotiation math: the ceiling becomes the minimum of the buyer's total-cost ceiling and the band's p75. Because the cap can only *lower* the buyer's ceiling, it also applies to bounded automatic negotiation when enabled — it never widens the room below the asking price.

## Preserved listing copies

Research listings are preserved for market research: when a listing first appears in a research watch, Scout fetches its detail page once (bounded per scan, with a small retry budget on later scans), stores the description, and downloads the gallery images into the Scout database so the listing stays viewable after it is sold or removed. Captures are deduplicated by listing state, capped at 12 images of up to 4 MB each, and served only from Scout's own image endpoint. Use the eye action on a Saved listings row to view the preserved copy, or the save action to capture or refresh a copy on demand — including for listings that already ended. Copies live and die with their research listing row, so the daily 180-day retention cleanup also prunes them; deleting a research watch deletes its copies.

## Docker Compose

Compose binds Scout to `0.0.0.0` inside the container and publishes port 3001 to the host. The browserless image is pinned and the image build uses `npm ci` from `package-lock.json`:

```bash
docker compose up -d --build
npm run test:compose
```

The smoke test requests `http://127.0.0.1:3001/api/ready` from the host. Compose requires `SCOUT_SECRET`; keep the published port on a trusted LAN/VPN because Scout has no built-in authentication. Scout waits for the pinned Browserless container health check before starting. The container runs as a non-root user with a read-only application filesystem; `/app/data` is the writable SQLite volume.

## AI listing normalization

Scout can optionally enrich watched listings with a DeepSeek model through OpenRouter. It extracts a canonical product name, brand/model/variant, explicit attributes, condition signals, flags, and evidence without changing Scout's deterministic price scoring. Configure the OpenRouter token and model in Settings, or use environment variables for a headless deployment:

```bash
export SCOUT_OPENROUTER_API_KEY='sk-or-v1-...'
export SCOUT_OPENROUTER_MODEL='deepseek/deepseek-v4-flash'
```

The API token entered in Settings is encrypted with `SCOUT_SECRET` and is never returned to the browser. Normalization is intentionally manual and off by default: use the listing detail drawer when you explicitly want an enrichment, and do not treat model output as a scoring or purchasing decision. Scout sends OpenAI-compatible chat-completion requests to OpenRouter and validates every JSON response before storing it. See the [OpenRouter chat-completions docs](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) for endpoint and authentication details.

Searches can also use the AI relevance filter. It runs after Scout's deterministic filters and excludes listings where the requested item is only mentioned as an accessory, replacement part, compatible component, repair service, or unrelated context—for example, a GPU fan when searching for a GPU. Jev judges relevance from the title, price, location, and query; unsure cases fetch the detail page for a second description-enriched judgment, then fall back to a vision-model tiebreak over the thumbnail. Relevance decisions are cached per watch, listing, query, and model. The filter is enabled by default for new watches and can be disabled per watch; without an OpenRouter key, Scout falls back to deterministic filtering. Relevance checks and the bounded near-miss rescue run several Jev round trips at once instead of one at a time (default 6, tune with `SCOUT_JEV_CONCURRENCY`), which shortens cold searches without changing any decision. Manual searches carry the same choice as a watch: the **AI relevance filtering** checkbox on the search form (remembered in the browser) can skip the Jev relevance and rescue calls entirely for deterministic-only results, and saving a search as a watch carries that choice over. Set `SCOUT_JEV_MODE=legacy` to use the DeepSeek model for relevance instead.

Very strong and exceptional deals receive an additional conservative safeguard when OpenRouter is configured. Scout fetches the approved marketplace detail page, extracts the listing description, saves a deduplicated snapshot of the listing state, and asks Jev for a structured `pass`, `reject`, or `unknown` condition check; unsure judgments and Jev outages escalate to a vision model over the listing photos. Only `pass` continues to immediate alerts or automatic negotiation; explicit damage, parts-only, repair, missing-essential-component, account-lock, or similar signals—and unavailable or ambiguous descriptions—hold the high-priority alert until a later scan. Results are cached by listing description and model, and the saved snapshots can be reviewed later from the listing drawer. Without an OpenRouter key the existing deterministic alert behavior remains active. Set `SCOUT_JEV_MODE=legacy` to use the DeepSeek model for verification instead.

Jev and vision requests retry transient OpenRouter provider failures with backoff. The legacy DeepSeek verification path uses OpenRouter response healing and retries once on malformed JSON. If a technical OpenRouter failure remains, Scout records a `fallback` status and sends the deterministic alert while showing the error; explicit `reject` and `unknown` decisions still hold the alert.

## AI-assisted marketplace negotiation

Saved OLX and Allegro Lokalnie listings have a `Negotiate with AI` action in their detail drawer. Scout calculates a deterministic opening offer from the current asking price, the buyer's maximum total cost, and known delivery/fee costs; the learned typical price remains part of deal ranking, not negotiation math. The default opening policy starts 12% below asking and caps every offer at the buyer's total-cost ceiling. The listing's negotiation signal labels the result as ready, manual review, or fixed-price; an unspecified signal does not block a price suggestion, but it does require manual review before contacting the seller. Scout first generates a short Polish draft, displays the exact text for editing, validates the reviewed message, and asks for an explicit final confirmation immediately before sending it through the user's encrypted, authenticated marketplace browser session. On Allegro Lokalnie the sender opens the offer's `Napisz na czacie` conversation and sends exactly one message. Settings can also enable bounded automatic negotiation: it requires an explicit negotiable-price signal, a total-cost ceiling, an authenticated OLX or Allegro Lokalnie session, a qualifying deal, and a configurable daily attempt limit; Scout records one automatic attempt per listing and never starts multi-round bargaining. Sent and failed outbound messages appear under Messages. Seller replies are not imported yet, and Vinted messaging is not enabled.

## Optional marketplace sessions

Scout can use a manually authenticated browser session for your own OLX, Allegro Lokalnie, or Vinted account. This keeps the marketplace login and any MFA/CAPTCHA steps in your browser; Scout does not collect passwords or attempt to bypass verification.

To create a Playwright storage-state file on a machine with a visible Chromium installation:

```bash
npm run marketplace:login -- --marketplace "OLX"
```

After logging in, import the generated JSON from Settings → Marketplace accounts. Session state is encrypted with `SCOUT_SECRET`, restricted to the selected marketplace domain, and never returned by the API. Allegro Lokalnie imports may also contain the related `allegro.pl` account-auth origin used by its sign-in flow. Sessions can expire and must then be re-imported. Do not paste raw `Cookie` headers or commit storage-state files.

## Safety boundaries

Scout only accepts HTTPS URLs from the approved marketplace domains. It does not store marketplace passwords, bypass CAPTCHAs, rotate proxies, spoof fingerprints, or automatically purchase. Manual negotiation requires an editable draft and explicit user confirmation; outbound text is checked for links, contact details, abusive language, and unapproved amounts, and browser automation requires positive delivery evidence. Automatic negotiation is disabled by default, supports only the bounded OLX and Allegro Lokalnie flows described above, and never performs multi-round bargaining. Optional Playwright session state is encrypted at rest, scoped to one approved marketplace, and supplied by the user after a manual login. Connector adapters intentionally fail closed when a public page cannot be normalized.

## Recovery and retention

Use Settings → Data recovery to download a redacted JSON export or create a SQLite backup beside the configured database. The backup uses SQLite's WAL-aware `VACUUM INTO` operation and is written with restrictive permissions where supported. Keep backups outside the application directory as well; a database backup contains private history and encrypted credentials. Retention cleanup runs daily and prunes operational history after 180 days while preserving active watch definitions and research series metadata.

To restore a verified backup, stop Scout first and run `npm run db:restore -- --backup /secure/path/scout.sqlite.backup.sqlite --confirm`. Add `--database /path/to/scout.sqlite` when `SCOUT_DB_PATH` is not the target. The command validates SQLite integrity, stages the replacement atomically, and keeps the previous database in a recoverable `.before-restore-*` file.

For systemd deployments, install the built `dist-server` artifact under `/opt/scout`, create the dedicated `scout` user, grant it ownership of `/var/lib/scout`, and place `SCOUT_SECRET` in `/etc/scout/scout.env` with mode `0600` before enabling `scout.service`.
