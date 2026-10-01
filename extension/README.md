# Scout listing helper (Firefox)

Fills the OLX, Allegro Lokalnie and Vinted "add listing" forms from a flip in
your Scout server: title, description, price, condition, and photos. **You
always check the form and press Publish yourself.** The extension never
submits a form, so the marketplaces see you listing from your own browser.

## Set up

1. In Scout, open **Flips**, press the megaphone button on an unsold flip, and
   add the listing text, a price, and photos. Photos can also be added from
   the iOS app, in the flip's editor.
2. Install the extension (see below), open its **Options**, and enter your
   Scout address and one of the server's `SCOUT_API_TOKENS`. Firefox asks once
   for access to that address. Scout must have sign-in enabled, since the
   extension authenticates with the token.

## Use

1. Click the Scout toolbar button and choose a platform for an unsold flip.
   The listing form opens in a new tab, and a small Scout panel appears.
2. Go to the step with the title and description (log in or pick a category
   first if the site asks), then press **Fill this form**. The panel shows what
   was filled and what is left, usually the category, shipping and parcel size.
3. Check everything, publish, then press **I published it**. Scout ticks the
   platform in the flip's "Listed on", which feeds the delist checklist when it
   sells.

If a field isn't filled after a site redesign, press **Report form fields**. It
copies a description of the form's fields (names and labels, not your data) so
the matching can be updated. **Download photos** saves the photos to
`Downloads/Scout/…` so you can drag them in by hand.

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
