# Scout listing helper (Firefox)

Fills the OLX, Allegro Lokalnie and Vinted "add listing" forms from a flip in
your Scout server: title, description, price, condition, and photos. **You
always check the form and press Publish yourself.** The extension never
submits a form, so the marketplaces see you listing from your own browser.

## Set up

1. In Scout, open **Flips**, press the megaphone button on an unsold flip, and
   add a price and photos. For a flip added with "I bought this", Scout drafts
   the title and description from the listing you bought it through (rewritten
   by AI when OpenRouter is configured, otherwise copied for you to edit),
   along with its condition and a category keyword such as "Słuchawki".
   Its photos are copied in too while the flip has none.
   **Rewrite from the original listing** drafts it again. For a flip added by
   hand, **Write with AI from these notes** writes it from the title, the
   description so far and the flip's note. **End prices in …9,99** rounds each
   asking price to the nearest one ending in 9,99. Photos are stored as WebP
   (at most 2000 px) and can also be added from the iOS app, in the flip's
   editor.
2. Install the extension (see below), open its **Options**, and enter your
   Scout address and one of the server's `SCOUT_API_TOKENS`. Firefox asks once
   for access to that address. Scout must have sign-in enabled, since the
   extension authenticates with the token.

## Use

1. Click the Scout toolbar button and choose a platform for an unsold flip.
   The listing form opens in a new tab, and a small Scout panel appears.
2. Log in or pick a category first if the site asks, then press **Fill this
   form**. Scout fills what the page shows and keeps watching: on forms with
   several steps, such as Allegro Lokalnie, where the price comes later, it
   fills each remaining field when its step appears. The panel lists each
   field as filled, waiting for its step, or left for you. Fields that already
   hold text are not overwritten, and the panel's minimize button gets it out
   of the way. Delivery is only picked with a default parcel size set in
   Options.
3. Check everything, publish, then press **I published it**. Scout ticks the
   platform in the flip's "Listed on", which feeds the delist checklist when it
   sells.

If a field isn't filled after a site redesign, press **Report form fields**. It
copies a description of the form's fields (names and labels, not your data) so
the matching can be updated. **Download photos** saves the photos to
`Downloads/Scout/…` so you can drag them in by hand.

Prices keep their grosze (1449,99) where the site takes them; a site that
only takes whole złoty gets the price rounded, and the panel says so.

What it does beyond the title, description, price, condition and photos:

- **OLX:** presses **Dalej** (next) after the title, and with a **Default parcel
  size** set in Options, switches on Przesyłka OLX with that size. OLX picks the
  category from the title. Its other item parameters are yours to fill.
- **Allegro Lokalnie:** takes the suggested category that best matches the
  flip's category keyword and title. The catalogue product and the required
  features (Cechy, such as "Nośnik*") depend on the item, so the panel lists
  which are left; once you pick them it presses **Kolejny krok** itself. Then
  it fills the price, picks the parcel size, chooses "Nie chcę wyróżniać" (no
  paid promotion), and stops on the summary page.
- **Vinted:** searches categories with the category keyword, then words from
  the title, and takes the result that fits best ("Słuchawki" over
  "Słuchawki dla dzieci"). It picks the brand only when a brand is named
  exactly like the title's first word or two, then the condition and the
  parcel weight.

Check the category it chose; the panel names it. It never presses a publish
button ("Dodaj ogłoszenie", "Wystaw…", Vinted's "Dodaj").

## Record a form

To teach Scout a marketplace's full flow (category pickers, item details,
delivery), press that marketplace under **Teach Scout a form** in the popup.
Go through the form as if listing a real item, without publishing, then press
**Finish and save**. The extension saves a JSON file to
`Downloads/Scout/form-recordings/` with each step's headings, form fields,
dropdown options and buttons, plus what you clicked. It never stores what you
type, only whether a field has a value. This runs in your own browser, so it
avoids the bot checks an automated browser runs into.

## Install

Firefox only runs signed add-ons permanently.

- **Try it:** open `about:debugging#/runtime/this-firefox`, click **Load
  Temporary Add-on**, and pick `extension/manifest.json`. It stays until
  Firefox restarts.
- **Keep it:** sign it as an unlisted add-on with a free Mozilla account. Get
  API keys at <https://addons.mozilla.org/developers/addon/api/key/>, run
  `npx web-ext sign --source-dir extension --channel unlisted --api-key … --api-secret …`,
  and open the `.xpi` it produces in Firefox. Unlisted add-ons are signed
  automatically and are not published on addons.mozilla.org.
- **Firefox Developer Edition, Nightly or ESR:** set
  `xpinstall.signatures.required` to `false` in `about:config` and install the
  zip from `npm run extension:build`.

`npm run extension:lint` checks the extension with Mozilla's linter.

## Privacy

The API token is stored in this Firefox profile and only sent to your Scout
address, from the extension's background page. The marketplace pages never
see it; they only receive the listing text and photos of the flip you chose.
The extension collects no data for anyone else.
