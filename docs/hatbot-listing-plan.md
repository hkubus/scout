# Hatbot listing — Scout's side (N6, step L1)

Handoff shared with Hatbot (`/root/hatbot`, PLAN.md §3.3 "N6, listing"). Hatbot builds its side against the contract below, so the tool names and shapes are fixed. Written 2026-10-24; [Connecting Hatbot](#connecting-hatbot) (OAuth) added 2026-10-25.

## What it's for

You mark a flip "Ready to list" in Scout and pick the marketplaces. Hatbot's brain polls Scout over MCP every 5 minutes, asks the owner once ("List 'RTX 3070 Gaming OC' on OLX for 1199 zł and Vinted for 1149 zł? 6 photos."), and its Haggler bot posts the listing on each marketplace from its desktop browser. Hatbot then reports each channel's outcome (the new listing's URL, or an error, or that the owner declined) back to Scout.

## Scout's part

1. **Ready state** on a flip: per picked channel (OLX, Allegro Lokalnie, Vinted; never Other), a status `ready | listed | failed | declined`, plus `url` and `error`. Marking ready needs a listing draft with a title, description, condition, a price for each picked channel (or `basePrice`) and at least one photo; Scout says plainly what's missing otherwise. Cancelling (unmarking) takes the flip out of `scout_flips_to_list`. A channel recorded `listed` is also added to the flip's `listedOn`, so the existing delist checklist keeps working.
2. **Delivery details** in the listing draft: `delivery: { shipping: boolean, pickup: boolean, parcelSize: "small" | "medium" | "large" | null }`. Vinted needs the parcel size; OLX and Allegro Lokalnie need shipping and pickup.
3. **The button** on the web and in the iOS app: "Ready to list" on a flip, picking channels; each channel's status and URL shown on the flip, and a way to cancel.
4. **Four MCP tools** in `server/mcp.ts` (below).
5. Tests for the ready state and the four tools.

## The four tools

- `scout_flips_to_list {}` (read, `readOnlyHint: true`) → `{ flips: [{ id: number, updatedAt: string, channels: [{ channel: "OLX" | "Allegro Lokalnie" | "Vinted", status: "ready" | "listed" | "failed" | "declined", url?: string, error?: string }] }] }`. Every flip that's marked ready, with all its picked channels.
- `scout_flip { id: number }` (read) → `{ id, updatedAt, title, description, condition, category, delivery, prices: { [channel]: number }, currency: "PLN", photos: [{ id: number, mime: string }] }`. `condition` is Scout's own value (`new-with-tags | new | like-new | good | damaged`). `prices` holds each picked channel, with `basePrice` filled in where a channel has none.
- `scout_flip_photo { id: number }` (read) → `{ id, mime: "image/jpeg", base64 }` as a **text** content item (JSON), not image content: Hatbot's MCP client drops image content. Re-encoded to JPEG, at most 2000 px on the long side, so it stays under about 2 MB.
- `scout_flip_listed { flipId: number, channel: string, status: "listed" | "failed" | "declined", url?: string, error?: string }` (write, not read-only, idempotent) → `{ ok: true }`. For `listed`, `url` is required and must be on that channel's host (olx.pl, allegrolokalnie.pl, vinted.pl); Scout refuses it otherwise.

Errors come back the way every Scout tool reports them: `isError: true` with `{ "error": "…" }` as the text.

## Two things that matter

- **`updatedAt` is the draft's revision, not the row's.** Hatbot asks the owner again whenever it changes, so it changes only when what gets posted changes (title, description, condition, category, delivery, prices, photos, or the picked channels), never when `scout_flip_listed` records a status. Otherwise recording one channel would re-ask for the others.
- **No money or selling words in the four tools' names and descriptions.** Hatbot's MCP plugin (`apps/brain/src/plugins/mcp/index.ts`, `moneyKind`) reads them to guess payments and purchases, and a tool it guesses is one would always ask, so the brain couldn't call it without the owner. Kept out: pay, payment, checkout, transfer, refund, money, funds, charge, spend, invoice, deposit, trade, buy, purchase, order, bid, subscribe, book, reserve, sell, selling, offer (and the plugin's tip, wire, swap). The texts say "list", "post", "listing", "draft", "photo" and "flip". `tests/mcp.test.ts` runs a copy of the plugin's patterns over them.

## How Scout fills in the details

Decisions made while building, which Hatbot can rely on:

- **Only ready flips are visible.** `scout_flip` and `scout_flip_photo` answer for flips that are marked ready (and their photos) and return an error for anything else, including a flip cancelled meanwhile. Hatbot should treat that error as "no longer ready".
- **A ready draft is always complete.** Besides the list above, marking ready needs a parcel size when Vinted is picked, and shipping or pickup (or both) when OLX or Allegro Lokalnie is. While a flip is ready, Scout refuses edits that would leave its draft incomplete (deleting the last photo, clearing a price) and asks the owner to cancel first. So `scout_flip` always has a title, description, condition, a price per picked channel, a delivery and at least one photo. `category` is a free-text hint ("Karty graficzne") or `null`.
- **`photos[].mime` is `"image/jpeg"`**, which is what `scout_flip_photo` returns; Scout stores WebP. Photos are listed cover first, as the owner arranged them.
- **What moves `updatedAt`:** the owner editing the draft so that what gets posted differs, adding, deleting or rearranging photos, marking the flip ready, and picking different channels. Re-marking ready also puts the owner's `failed` and `declined` channels back to `ready` and moves `updatedAt`, so pressing "Ready to list" again is how the owner retries; Hatbot sees a new revision with those channels `ready`. Saving an unchanged draft doesn't move it, and `scout_flip_listed` never does.
- **What takes a flip out of `scout_flips_to_list`:** the owner cancelling, recording a sale, or deleting the flip. Channels already `listed` keep their record and URL on the flip either way; the others are dropped.
- **A listed channel stays picked.** The owner can't unpick it (editing or taking down a live listing is out of scope).
- **`scout_flip_listed`** checks the flip and channel exist and, for `listed`, that `url` is `https://` on the channel's host or a subdomain (`www.olx.pl`, `m.olx.pl`). Then:
  - `listed` is always recorded, even if the owner cancelled meanwhile: the listing is live, so Scout keeps its URL and adds the channel to `listedOn`.
  - `failed` and `declined` are recorded for a picked channel that isn't `listed`; for a channel already `listed` or not picked they change nothing and still return `{ ok: true }`.
  - Repeating a call changes nothing. `error` is kept to 500 characters.
- **Prices** are złoty, as the owner set them for each channel (or `basePrice` for a channel without one).

## Scout's REST side (web and iOS)

- `PUT /api/flips/:id/ready {channels: ["OLX", "Vinted"]}` marks a flip ready, or re-marks it with these channels; it answers 400 with "Before it can be listed, add …" when something's missing. `DELETE /api/flips/:id/ready` cancels.
- `PUT /api/flips/:id/listing` takes an optional `delivery`; left out, the stored delivery is kept, so older clients don't wipe it.
- Each flip carries `readyToList` (boolean), `listingChannels` (`[{channel, status, url, error, updatedAt}]`) and `listingRevisedAt` (the revision `scout_flip` reports as `updatedAt`).

## Connecting Hatbot

Added 2026-10-25, so the owner never edits `SCOUT_API_TOKENS`: in Hatbot, Settings → Plugins → Scout, the owner types Scout's address and presses Connect, presses Allow on Scout's "Let Hatbot in?" page, and lands back in Hatbot, connected. Hatbot's brain then calls Scout's `/mcp` with the Bearer token it got. It's OAuth 2.1 with PKCE for public clients, as in MCP's authorization spec, built in `server/oauth.ts`; the paths and shapes are as agreed:

- `GET /.well-known/oauth-authorization-server` → `{ issuer, authorization_endpoint: "<origin>/oauth/authorize", token_endpoint: "<origin>/oauth/token", registration_endpoint: "<origin>/oauth/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }`, where `<origin>` is the origin the request came in on, or `SCOUT_PUBLIC_ORIGIN` when that is set and the request came through a proxy (it has forwarded headers).
- `GET /.well-known/oauth-protected-resource` → `{ resource: "<origin>/mcp", authorization_servers: ["<origin>"] }`. A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- `POST /oauth/register` (JSON `{ client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method: "none" }`) → 201 `{ client_id, client_name, redirect_uris }`.
- `GET /oauth/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256` → the page; Allow 302s to `redirect_uri?code=…&state=…`, Cancel to `redirect_uri?error=access_denied&state=…`.
- `POST /oauth/token` (form: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`) → `{ access_token, token_type: "Bearer" }`, no `expires_in`. Errors: 400 `{ error, error_description }`, `invalid_grant` for a used, expired or mismatched code or a wrong verifier.

Decisions made while building, which Hatbot can rely on:

- **The token** is `scout_app_` plus 32 random bytes (base64url), stored only as a SHA-256 digest with the app's name and when it was made and last used. It works on `/mcp` only, with the same tools as a `SCOUT_API_TOKENS` token minus `scout_debug_*`. On `/api`, `/events` and the dashboard's sign-in it's refused with 401. It lasts until the owner presses **Disconnect** (Settings → Connected apps, web and iOS), which revokes it before the next request; `/mcp` then answers 401 with the `resource_metadata` challenge, which is Hatbot's cue to connect again.
- **Register on every Connect is fine** (as Hatbot's T3 plugin does). Scout keeps at most 50 apps and drops ones holding no token a day after they registered (never connected, or since disconnected). At the cap it drops the oldest app holding no token to make room, and refuses (`invalid_client_metadata`) only when all 50 hold tokens. A token from an earlier Connect stays listed until the owner disconnects it; Scout doesn't replace it by name.
- **Registration** accepts `grant_types` that include `authorization_code`, `response_types` that include `code`, and only `token_endpoint_auth_method: "none"`. Up to 10 redirect URIs, each http(s), no fragment, no credentials. Rate-limited to 10 per minute per IP; the token endpoint and Allow to 30.
- **The page** checks the request before showing Allow: an unknown `client_id`, a `redirect_uri` not registered for it (an exact string match), a `response_type` other than `code`, or a missing S256 `code_challenge` shows an error on Scout's page and redirects nowhere. `state` is echoed as sent (up to 1000 characters) and left out when Hatbot sends none. No `iss` parameter is added.
- **Allow is a plain form post** from Scout's own page, under the same CSRF rules as the dashboard (a signed-in same-origin session; with sign-in off, Host pinning and the cross-site check). To let the browser follow the 302 to Hatbot, that page's CSP adds the `redirect_uri`'s origin to `form-action`; every other page keeps `form-action 'self'`.
- **The code** is single-use and lasts 5 minutes, bound to the `client_id`, `redirect_uri` and `code_challenge`. A wrong verifier, client or `redirect_uri` doesn't use it up, so a retry with the right values still works. Replaying a code that was already exchanged revokes the token it gave (RFC 6749 §4.1.2).
- **With sign-in off** (`SCOUT_AUTH=off`, or no credentials on loopback) the flow is the same and Allow needs no sign-in. `/mcp` accepts everything as before, except a `scout_app_` token that isn't connected (or was disconnected), which still gets the 401, so Disconnect works there too.
- The OAuth tables (`oauth_clients`, `oauth_codes`, `connected_app_tokens`) are private like the flip ledger: hidden from the Debug API.

## Not in this

Answering buyers, taking a sold flip off its other channels (the delist checklist already does that), editing or relisting a live listing, and paid promotion.
