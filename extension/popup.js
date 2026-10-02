// Lists unsold flips; each marketplace button opens that site's listing form
// in a new tab, where the content script offers to fill it.
const api = globalThis.browser;
const PLATFORMS = ["OLX", "Allegro Lokalnie", "Vinted"];
const content = document.getElementById("content");

document.getElementById("options").addEventListener("click", () => {
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
  document.getElementById("server").textContent = status.serverUrl.replace(/^https?:\/\//, "");
  content.replaceChildren(...unsold.map((flip) => {
    const card = document.createElement("section");
    card.className = "flip";
    const title = document.createElement("div");
    title.className = "flip-title";
    title.textContent = flip.listing?.title || flip.title;
    title.title = title.textContent;
    const detail = document.createElement("div");
    const photos = flip.photos.length;
    const missing = !flip.listing ? "No listing yet. Open it in Scout → Flips (megaphone) to draft one." : !flip.listing.description ? "No description yet" : "";
    detail.className = missing ? "flip-meta warn" : "flip-meta";
    detail.textContent = [`${photos} photo${photos === 1 ? "" : "s"}`, missing].filter(Boolean).join(" · ");
    const buttons = document.createElement("div");
    buttons.className = "platforms";
    for (const channel of PLATFORMS) {
      const button = document.createElement("button");
      const listed = flip.listedOn.includes(channel);
      const price = flip.listing?.prices?.[channel];
      button.type = "button";
      button.className = listed ? "platform listed" : "platform";
      const name = document.createElement("strong");
      name.textContent = channel;
      const sub = document.createElement("span");
      sub.textContent = listed ? "✓ Listed" : price ? `${Math.round(price)} zł` : "No price";
      button.append(name, sub);
      button.title = listed ? `Already listed on ${channel}; opens the form again` : `Open the ${channel} listing form and fill it`;
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

for (const channel of PLATFORMS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record-button";
  button.textContent = channel;
  button.title = `Open the ${channel} listing form and record its steps`;
  button.addEventListener("click", async () => {
    try {
      await send("record", { channel });
      window.close();
    } catch (error) {
      message(error.message);
    }
  });
  document.getElementById("record").append(button);
}

load().catch((error) => message(error.message));
