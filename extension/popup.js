// Lists unsold flips; each marketplace button opens that site's listing form
// in a new tab, where the content script offers to fill it.
const api = globalThis.browser;
const PLATFORMS = ["OLX", "Allegro Lokalnie", "Vinted"];
const content = document.getElementById("content");

document.getElementById("options").addEventListener("click", (event) => {
  event.preventDefault();
  api.runtime.openOptionsPage();
  window.close();
});

async function send(type, extra = {}) {
  const reply = await api.runtime.sendMessage({ type, ...extra });
  if (!reply?.ok) throw new Error(reply?.error || "No answer from the extension");
  return reply.result;
}

function message(text) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  content.replaceChildren(p);
}

async function load() {
  const status = await send("status");
  if (!status.configured) {
    message("Set your Scout address and API token in Options first.");
    return;
  }
  const { flips } = await send("flips");
  const unsold = flips.filter((flip) => !flip.soldOn);
  if (!unsold.length) {
    message("No unsold flips. Add one in Scout → Flips or with “I bought this”.");
    return;
  }
  content.replaceChildren(...unsold.map((flip) => {
    const card = document.createElement("section");
    card.className = "flip";
    const title = document.createElement("div");
    title.className = "flip-title";
    title.textContent = flip.listing?.title || flip.title;
    const detail = document.createElement("div");
    detail.className = "muted";
    const photos = flip.photos.length;
    detail.textContent = flip.listing
      ? `${photos} photo${photos === 1 ? "" : "s"}${flip.listing.description ? "" : " · no description yet"}`
      : "No listing text yet. Add it in Scout → Flips (megaphone button).";
    const buttons = document.createElement("div");
    buttons.className = "platforms";
    for (const channel of PLATFORMS) {
      const button = document.createElement("button");
      const listed = flip.listedOn.includes(channel);
      const price = flip.listing?.prices?.[channel];
      button.textContent = `${listed ? "✓ " : ""}${channel}${price ? ` · ${Math.round(price)} zł` : ""}`;
      button.title = listed ? `Already listed on ${channel}; opens the form again` : `Open the ${channel} listing form and fill it`;
      if (listed) button.className = "listed";
      button.addEventListener("click", async () => {
        try {
          await send("open", { flipId: flip.id, channel });
          window.close();
        } catch (error) {
          message(error.message);
        }
      });
      buttons.append(button);
    }
    card.append(title, detail, buttons);
    return card;
  }));
}

load().catch((error) => message(error.message));
