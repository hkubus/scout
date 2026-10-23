# Hatbot listing — Scout's side (N6, step L1)

Handoff shared with Hatbot (`/root/hatbot`, PLAN.md §3.3 "N6, listing"). Hatbot builds its side against the contract below, so the tool names and shapes are fixed. Written 2026-10-24.

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

## Not in this

Answering buyers, taking a sold flip off its other channels (the delist checklist already does that), editing or relisting a live listing, and paid promotion.
