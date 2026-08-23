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

The compiled dashboard and API are served together on port 3001. Keep `SCOUT_HOST=127.0.0.1` when placing an authenticated reverse proxy in front; set it to `0.0.0.0` only for a trusted LAN/VPN. `TZ` controls the server-local 22:00–08:00 overnight window, so set it explicitly for the deployment timezone. SQLite, migrations, encrypted Discord/ntfy settings, per-channel delivery records, and notification history live under `SCOUT_DB_PATH`.

`SCOUT_PUBLIC=true` enables a visible public-exposure warning in Settings; it does not provide login or access control. Do not expose Scout directly to the public internet. If a separately hosted frontend needs API access, set `SCOUT_CORS_ORIGIN` to an explicit comma-separated allowlist; CORS is disabled by default.

For a source checkout, the deployment checks are:

```bash
npm run typecheck
npm test
npm run build
```

## Notifications

Settings supports Discord webhooks and ntfy topics. Each channel has its own minimum deal priority (`Strong`, `Very strong`, or `Exceptional`), so ntfy can be limited to only the most important alerts while Discord receives the broader stream. ntfy uses the standard JSON publish API and can optionally send a bearer access token; credentials are encrypted with `SCOUT_SECRET`.

## Optional marketplace sessions

Scout can use a manually authenticated browser session for your own OLX, Allegro Lokalnie, or Vinted account. This keeps the marketplace login and any MFA/CAPTCHA steps in your browser; Scout does not collect passwords or attempt to bypass verification.

To create a Playwright storage-state file on a machine with a visible Chromium installation:

```bash
npm run marketplace:login -- --marketplace "OLX"
```

After logging in, import the generated JSON from Settings → Marketplace accounts. Session state is encrypted with `SCOUT_SECRET`, restricted to the selected marketplace domain, and never returned by the API. Sessions can expire and must then be re-imported. Do not paste raw `Cookie` headers or commit storage-state files.

## Safety boundaries

Scout only accepts HTTPS URLs from the approved marketplace domains. It does not store marketplace passwords, bypass CAPTCHAs, rotate proxies, spoof fingerprints, automatically purchase, or contact sellers. Optional Playwright session state is encrypted at rest, scoped to one approved marketplace, and supplied by the user after a manual login. Connector adapters intentionally fail closed when a public page cannot be normalized.
