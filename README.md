# Scout

Scout is a single-user, LAN/VPN-friendly marketplace deal monitor for public OLX, Allegro Lokalnie, and Vinted searches.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:4173. The Vite client uses the Fastify API at port 3001 and shows an offline state when the API is unavailable.

## Production

Copy `.env.example` to `.env`, set a long random `SCOUT_SECRET`, then run:

```bash
docker compose up -d --build
```

The compiled dashboard and API are served together on port 3001. SQLite, migrations, encrypted Discord webhook settings, and notification history live in the `scout-data` volume.

## Optional marketplace sessions

Scout can use a manually authenticated browser session for your own OLX, Allegro Lokalnie, or Vinted account. This keeps the marketplace login and any MFA/CAPTCHA steps in your browser; Scout does not collect passwords or attempt to bypass verification.

To create a Playwright storage-state file on a machine with a visible Chromium installation:

```bash
npm run marketplace:login -- --marketplace "OLX"
```

After logging in, import the generated JSON from Settings → Marketplace accounts. Session state is encrypted with `SCOUT_SECRET`, restricted to the selected marketplace domain, and never returned by the API. Sessions can expire and must then be re-imported. Do not paste raw `Cookie` headers or commit storage-state files.

## Safety boundaries

Scout only accepts HTTPS URLs from the approved marketplace domains. It does not store marketplace passwords, bypass CAPTCHAs, rotate proxies, spoof fingerprints, automatically purchase, or contact sellers. Optional Playwright session state is encrypted at rest, scoped to one approved marketplace, and supplied by the user after a manual login. Connector adapters intentionally fail closed when a public page cannot be normalized.
