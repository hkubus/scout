// Scout listing helper: content script on OLX, Allegro Lokalnie and Vinted.
// Only acts in a tab the extension opened for a flip. It fills the listing
// form and attaches the photos; the operator checks the form and publishes.
// Fields are found by their visible labels rather than fixed selectors, so a
// redesign degrades to "fill that field yourself" instead of breaking.

(() => {
  const api = globalThis.browser;
  if (!api?.runtime?.sendMessage || globalThis.__scoutListingHelper) return;
  globalThis.__scoutListingHelper = true;

  const CHANNEL_BY_HOST = {
    "www.olx.pl": "OLX",
    "olx.pl": "OLX",
    "allegrolokalnie.pl": "Allegro Lokalnie",
    "www.allegrolokalnie.pl": "Allegro Lokalnie",
    "www.vinted.pl": "Vinted",
    "vinted.pl": "Vinted",
  };
  const channel = CHANNEL_BY_HOST[location.hostname];
  if (!channel) return;

  // How each marketplace words the condition Scout stores.
  const CONDITION_LABELS = {
    new: { OLX: "Nowe", "Allegro Lokalnie": "Nowy", Vinted: "Nowy bez metki" },
    "like-new": { OLX: "Używane", "Allegro Lokalnie": "Używany", Vinted: "Bardzo dobry" },
    good: { OLX: "Używane", "Allegro Lokalnie": "Używany", Vinted: "Dobry" },
    damaged: { OLX: "Uszkodzone", "Allegro Lokalnie": "Uszkodzony", Vinted: "Zadowalający" },
  };

  const send = async (type, extra = {}) => {
    const reply = await api.runtime.sendMessage({ type, ...extra });
    if (!reply?.ok) throw new Error(reply?.error || "The Scout extension did not answer");
    return reply.result;
  };

  // --- Finding fields -------------------------------------------------------

  const norm = (text) => (text || "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return element.getClientRects().length > 0;
  };

  /** Everything a person would read as the field's name. */
  const describe = (element) => {
    const parts = [
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("name"),
      element.id,
      element.getAttribute("data-testid"),
      element.getAttribute("data-cy"),
    ];
    for (const label of element.labels || []) parts.push(label.textContent);
    for (const id of (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent);
    // Headings or labels shortly before the field inside its form group.
    let node = element;
    for (let depth = 0; depth < 3 && node?.parentElement; depth += 1) {
      node = node.parentElement;
      const heading = node.querySelector("label, legend, h2, h3, h4, [class*='label' i], [class*='title' i]");
      if (heading && heading !== element && !heading.contains(element) && heading.textContent.length < 80) {
        parts.push(heading.textContent);
        break;
      }
    }
    return parts.filter(Boolean).join(" | ");
  };

  const textFields = () => [...document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']")]
    .filter((element) => isVisible(element))
    .filter((element) => !(element instanceof HTMLInputElement) || !["hidden", "file", "checkbox", "radio", "submit", "button", "image", "reset", "search", "email", "password", "tel"].includes(element.type));

  const FIELD_PATTERNS = {
    title: /\b(tytul|title|nazwa ogloszenia|nazwa przedmiotu)\b/,
    description: /\b(opis|description)\b/,
    price: /\b(cena|price|kwota)\b/,
  };
  const NOT_A_FORM_FIELD = /\b(szukaj|search|wyszukaj|newsletter|kod pocztowy|telefon|e-?mail)\b/;

  function findField(kind) {
    const matches = textFields()
      .map((element) => ({ element, text: norm(describe(element)) }))
      .filter(({ text }) => FIELD_PATTERNS[kind].test(text) && !NOT_A_FORM_FIELD.test(text));
    const rank = ({ element }) => {
      const multiline = element instanceof HTMLTextAreaElement || element.isContentEditable;
      if (kind === "description") return multiline ? 0 : 2;
      if (kind === "price") return element instanceof HTMLInputElement ? 0 : 2;
      return multiline ? 1 : 0;
    };
    return matches.sort((a, b) => rank(a) - rank(b))[0]?.element || null;
  }

  // --- Filling ------------------------------------------------------------

  /**
   * Set a value the way typing does, so React and Vue forms notice: use the
   * native setter (bypassing the framework's own), then fire input/change.
   */
  function setValue(element, value) {
    element.focus();
    if (element.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, value);
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    element.dispatchEvent(new Event("blur", { bubbles: true }));
    element.blur();
    return norm(element.isContentEditable ? element.textContent : element.value) === norm(value);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Pick the condition in a <select>, a radio group, or an open dropdown. */
  async function chooseCondition(label) {
    const wanted = norm(label);
    for (const select of document.querySelectorAll("select")) {
      if (!isVisible(select)) continue;
      const option = [...select.options].find((item) => norm(item.textContent) === wanted);
      if (option) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    const clickable = () => [...document.querySelectorAll("button, [role='option'], [role='radio'], [role='menuitem'], label, li")]
      .filter((element) => isVisible(element) && norm(element.textContent) === wanted);
    let target = clickable()[0];
    if (!target) {
      // Custom dropdowns list their options only once opened.
      const opener = [...document.querySelectorAll("button, [role='combobox'], [aria-haspopup], input[readonly], div[tabindex]")]
        .find((element) => isVisible(element) && /\b(stan|condition)\b/.test(norm(describe(element) + " " + element.textContent)));
      if (!opener) return false;
      opener.click();
      await wait(400);
      target = clickable()[0];
    }
    if (!target) return false;
    target.click();
    return true;
  }

  function findPhotoInput() {
    const inputs = [...document.querySelectorAll("input[type='file']")];
    return inputs.find((input) => /image|jpe?g|png|webp/i.test(input.accept || "") && input.multiple)
      || inputs.find((input) => /image|jpe?g|png|webp/i.test(input.accept || ""))
      || inputs[0]
      || null;
  }

  function toFile(photo) {
    const binary = atob(photo.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new File([bytes], photo.name, { type: photo.type });
  }

  async function attachPhotos(photos) {
    const input = findPhotoInput();
    if (!input) return { attached: 0, reason: "no photo field found on this page yet" };
    const files = photos.map(toFile);
    const batch = input.multiple ? files : files.slice(0, 1);
    const transfer = new DataTransfer();
    for (const file of batch) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { attached: batch.length, reason: input.multiple ? "" : "the photo field takes one file at a time" };
  }

  async function fill(job) {
    const listing = job.flip.listing;
    const results = [];
    const report = (ok, text) => results.push({ ok, text });
    const title = listing?.title || job.flip.title;
    const price = listing?.prices?.[channel] ?? listing?.basePrice ?? null;

    const titleField = findField("title");
    report(Boolean(titleField && setValue(titleField, title)), titleField ? "Title" : "Title: field not found");
    if (listing?.description) {
      const descriptionField = findField("description");
      report(Boolean(descriptionField && setValue(descriptionField, listing.description)), descriptionField ? "Description" : "Description: field not found");
    } else {
      report(false, "Description: none in Scout yet");
    }
    if (price) {
      const priceField = findField("price");
      report(Boolean(priceField && setValue(priceField, String(Math.round(price)))), priceField ? `Price ${Math.round(price)} zł` : `Price ${Math.round(price)} zł: field not found`);
    } else {
      report(false, "Price: none set in Scout");
    }
    if (listing?.condition) {
      const label = CONDITION_LABELS[listing.condition]?.[channel];
      const picked = label ? await chooseCondition(label) : false;
      report(picked, picked ? `Condition: ${label}` : `Condition: choose “${label}” yourself`);
    }
    if (job.flip.photos.length) {
      setStatus("Downloading photos from Scout…");
      try {
        const photos = await send("photos");
        const { attached, reason } = await attachPhotos(photos);
        report(attached === photos.length, attached ? `Photos: ${attached} of ${photos.length}${reason ? ` (${reason})` : ""}` : `Photos: ${reason}`);
      } catch (error) {
        report(false, `Photos: ${error.message}`);
      }
    } else {
      report(false, "Photos: none in Scout yet");
    }
    return results;
  }

  /** Every form control on the page, for tuning the matching to a redesign. */
  function fieldReport() {
    const controls = [...document.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='combobox']")];
    return JSON.stringify({
      channel,
      url: location.href.split("?")[0],
      at: new Date().toISOString(),
      controls: controls.slice(0, 120).map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || undefined,
        name: element.getAttribute("name") || undefined,
        id: element.id || undefined,
        testid: element.getAttribute("data-testid") || element.getAttribute("data-cy") || undefined,
        accept: element.getAttribute("accept") || undefined,
        multiple: element.hasAttribute("multiple") || undefined,
        visible: isVisible(element),
        describes: describe(element).slice(0, 160),
      })),
    }, null, 1);
  }

  // --- Panel ------------------------------------------------------------------

  let panel;
  let statusLine;
  let resultList;

  const setStatus = (text) => { if (statusLine) statusLine.textContent = text; };

  function button(label, onClick, primary = false) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    if (primary) element.className = "primary";
    element.addEventListener("click", async () => {
      element.disabled = true;
      try { await onClick(); } catch (error) { setStatus(error.message); } finally { element.disabled = false; }
    });
    return element;
  }

  function showPanel(job) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box { width: 300px; font: 13px/1.4 system-ui, sans-serif; color: #1c2433; background: #fff; border: 1px solid #d6dbe4; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.18); padding: 12px 14px; }
      .kicker { color: #1d61e8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
      .title { font-weight: 700; margin: 2px 0 8px; }
      .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      button { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 10px; border-radius: 7px; border: 1px solid #c3cad6; background: #fff; color: #1c2433; cursor: pointer; }
      button.primary { background: #1d61e8; border-color: #1d61e8; color: #fff; }
      button:disabled { opacity: .5; cursor: default; }
      .status { color: #5c6678; font-size: 12px; margin-top: 8px; }
      ul { list-style: none; padding: 0; margin: 8px 0 0; font-size: 12px; }
      li.ok::before { content: "✓ "; color: #3aab61; font-weight: 700; }
      li.todo::before { content: "• "; color: #f15a35; font-weight: 700; }
      .close { position: absolute; top: 6px; right: 8px; border: 0; background: transparent; font-size: 16px; padding: 2px 6px; }
    `;
    const box = document.createElement("div");
    box.className = "box";
    const listing = job.flip.listing;
    const price = listing?.prices?.[channel] ?? listing?.basePrice ?? null;
    const kicker = document.createElement("div");
    kicker.className = "kicker";
    kicker.textContent = `Scout · ${channel}`;
    const heading = document.createElement("div");
    heading.className = "title";
    heading.textContent = `${listing?.title || job.flip.title}${price ? ` · ${Math.round(price)} zł` : ""}`;
    box.append(kicker, heading);
    const close = button("×", async () => { await send("dismiss"); host.remove(); });
    close.className = "close";
    close.title = "Stop filling in this tab";
    const actions = document.createElement("div");
    actions.className = "row";
    actions.append(
      button("Fill this form", async () => {
        setStatus("Filling…");
        const results = await fill(job);
        resultList.replaceChildren(...results.map((item) => { const li = document.createElement("li"); li.className = item.ok ? "ok" : "todo"; li.textContent = item.text; return li; }));
        const done = results.filter((item) => item.ok).length;
        setStatus(`Filled ${done} of ${results.length}. Check the category, shipping and parcel size, then publish. Open a later step and press Fill again if the form has more pages.`);
      }, true),
      button("I published it", async () => {
        await send("markListed");
        setStatus(`Marked as listed on ${channel} in Scout.`);
        setTimeout(() => host.remove(), 2500);
      }),
    );
    const extras = document.createElement("div");
    extras.className = "row";
    extras.append(
      button("Download photos", async () => { const { count } = await send("downloadPhotos"); setStatus(count ? `Saved ${count} photos to Downloads/Scout. Drag them into the form.` : "This flip has no photos in Scout."); }),
      button("Report form fields", async () => { await navigator.clipboard.writeText(fieldReport()); setStatus("Copied a description of this form's fields. Paste it into your Scout chat if filling misses something."); }),
    );
    statusLine = document.createElement("div");
    statusLine.className = "status";
    statusLine.textContent = "Open the step with the title and description, then press Fill this form.";
    resultList = document.createElement("ul");
    box.append(close, actions, resultList, statusLine, extras);
    root.append(style, box);
    document.documentElement.append(host);
    panel = host;
  }

  send("job").then((job) => { if (job && job.channel === channel && !panel) showPanel(job); }).catch(() => { /* not a Scout tab, or Scout is unreachable */ });
})();
