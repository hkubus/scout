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
    "new-with-tags": { OLX: "Nowe", "Allegro Lokalnie": "Nowy", Vinted: "Nowy z metką" },
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

  const CONTROLS = "input:not([type='hidden']), textarea, select, [role='combobox']";

  /** The nearest heading before an element in reading order. */
  function precedingHeading(element) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = element;
    for (let steps = 0; steps < 300 && walker.previousNode(); steps += 1) {
      const node = walker.currentNode;
      if (node.matches("h1, h2, h3, h4, legend, label") && !node.contains(element) && node.textContent.length < 80) return node.textContent;
    }
    return "";
  }

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
    // The label of the field's own group: climb while the group holds no
    // other control, so a neighbouring field's label is never borrowed (OLX
    // puts "Stan" a few levels above an unlinked "Wybierz" dropdown).
    let node = element;
    for (let depth = 0; depth < 6 && node?.parentElement; depth += 1) {
      node = node.parentElement;
      if ([...node.querySelectorAll(CONTROLS)].filter((control) => control !== element && isVisible(control)).length) break;
      const heading = node.querySelector("label, legend, h2, h3, h4, [class*='label' i], [class*='title' i]");
      if (heading && heading !== element && !heading.contains(element) && heading.textContent.length < 80) {
        parts.push(heading.textContent);
        return parts.filter(Boolean).join(" | ");
      }
    }
    // Rich-text editors (Allegro Lokalnie's description) carry no name at
    // all; the heading just above them is the only label.
    if (element.isContentEditable) parts.push(precedingHeading(element));
    return parts.filter(Boolean).join(" | ");
  };

  const textFields = () => [...document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']")]
    .filter((element) => isVisible(element))
    .filter((element) => !(element instanceof HTMLInputElement) || !["hidden", "file", "checkbox", "radio", "submit", "button", "image", "reset", "search", "email", "password", "tel"].includes(element.type));

  const FIELD_PATTERNS = {
    title: /\b(tytul|title|nazwa ogloszenia|nazwa przedmiotu|co sprzedajesz)\b/,
    description: /\b(opis|description)\b/,
    price: /\b(cena|price|kwota)\b/,
  };
  const NOT_A_FORM_FIELD = /\b(szukaj|search|wyszukaj|newsletter|kod pocztowy|telefon|e-?mail)\b/;
  // Delivery steps also say "cena"; only the item's own price is filled.
  const NOT_THIS_FIELD = { price: /(dostaw|wysylk|przesylk|kurier|paczk|minimaln|odbior|delivery|shipping)/ };

  function findField(kind) {
    const matches = textFields()
      .map((element) => ({ element, text: norm(describe(element)) }))
      .filter(({ text }) => FIELD_PATTERNS[kind].test(text) && !NOT_A_FORM_FIELD.test(text) && !NOT_THIS_FIELD[kind]?.test(text));
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
  function setValue(element, value, { blur = true } = {}) {
    element.focus();
    if (element.isContentEditable) {
      // Rich-text editors build paragraphs from a paste; plain insertText
      // is the fallback for editors that ignore synthetic pastes.
      document.execCommand("selectAll", false);
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      if (squash(element.textContent) !== squash(value)) {
        document.execCommand("selectAll", false);
        document.execCommand("insertText", false, value);
      }
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (blur) {
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      element.blur();
    }
    return element.isContentEditable ? squash(element.textContent) === squash(value) : norm(element.value) === norm(value);
  }

  /** "1450" or "1449,99", the way Polish forms show a price. */
  const formatPrice = (price) => (Number.isInteger(price) ? String(price) : price.toFixed(2).replace(".", ","));

  /** What a price field holds as a number: "1 449,99 zł" and "1449.99" are both 1449.99. */
  function readPrice(field) {
    const text = (field.value || "").replace(/[^\d,.]/g, "");
    const value = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
    return text && Number.isFinite(value) ? value : null;
  }

  /**
   * Type the price with its grosze when it has any, in the comma form first,
   * then with a dot, and check what the field kept. A site that takes whole
   * złoty only gets the price rounded.
   */
  async function fillPrice(field, price) {
    const whole = Math.round(price);
    const tries = Number.isInteger(price) ? [String(price)] : [formatPrice(price), price.toFixed(2), String(whole)];
    for (const text of tries) {
      setValue(field, text);
      await wait(150);
      const kept = readPrice(field);
      if (kept !== null && Math.abs(kept - price) < 0.005) return { ok: true, final: true, note: `${formatPrice(price)} zł` };
      if (text === String(whole) && kept === whole) return { ok: true, final: true, note: `${whole} zł, the site takes whole złoty` };
    }
    return { ok: false, final: false, note: "check it, the site may have changed it" };
  }

  // Editors drop the line breaks from textContent, so compare without spaces.
  const squash = (text) => norm(text).replace(/\s+/g, "");

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const CONDITION_WORD = /\b(stan|stan przedmiotu|condition)\b/;

  /**
   * The control that opens the condition list: a combobox or a condition
   * input first, then short buttons. Containers that merely hold the word
   * "Stan" somewhere in a long text are never taken.
   */
  function conditionOpener() {
    return [...document.querySelectorAll("[role='combobox'], input[name*='condition' i], input[data-testid*='condition' i], button, [aria-haspopup], input[readonly], div[tabindex]")]
      .filter((element) => isVisible(element))
      .map((element) => ({ element, own: norm(describe(element)), text: norm(element.textContent) }))
      .filter(({ own, text }) => CONDITION_WORD.test(own) || (text.length < 40 && CONDITION_WORD.test(text)))
      // A field named just "Stan" beats "Stan baterii"; real dropdowns beat buttons.
      .map((item) => ({ ...item, exact: item.own.split("|").some((part) => /^(stan|stan przedmiotu|condition)\*?$/.test(part.trim())) ? 0 : 1, rank: item.element.matches("[role='combobox'], input") ? 0 : 1 }))
      .sort((a, b) => a.exact - b.exact || a.rank - b.rank || a.text.length - b.text.length)[0]?.element || null;
  }

  const pressEscape = (element) => {
    for (const type of ["keydown", "keyup"]) (element || document.activeElement || document.body).dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true }));
  };

  /**
   * Pick the condition in a <select>, a radio group, or a dropdown. Returns
   * "picked", "missing" when the list opened without the wanted option (it is
   * closed again), or null when the page has no condition field yet.
   */
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
    // Options can carry an explanation after the name ("Bardzo dobryUżywany
    // przedmiot…" on Vinted); once a dropdown is open, those count too.
    // Real options rank before look-alike buttons and labels elsewhere.
    const clickable = (loose = false) => [...document.querySelectorAll("[role='option'], [role='radio'], [role='menuitem'], button, label, li")]
      .filter((element) => isVisible(element))
      .map((element) => ({ element, text: norm(element.textContent), option: element.matches("[role='option'], [role='radio'], [role='menuitem']") ? 0 : 1 }))
      .filter(({ text }) => text === wanted || (loose && text.startsWith(wanted)))
      .sort((a, b) => a.option - b.option || a.text.length - b.text.length)
      .map(({ element }) => element);
    let target = clickable()[0];
    let opener = null;
    if (!target) {
      // Custom dropdowns list their options only once opened.
      opener = conditionOpener();
      if (!opener) return null;
      opener.click();
      await wait(500);
      target = clickable(true)[0];
      if (!target) {
        pressEscape(opener);
        return "missing";
      }
    }
    target.click();
    await wait(200);
    return "picked";
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

  // --- Following the form across its steps ------------------------------------

  // Allegro Lokalnie asks for the title first and the price pages later, and
  // OLX and Vinted can re-render between sections. After the first Fill the
  // panel keeps watching the page and fills each field once, as it appears.
  const FIELDS = [
    { kind: "title", label: "Title" },
    { kind: "description", label: "Description" },
    { kind: "price", label: "Price" },
    { kind: "condition", label: "Condition" },
    { kind: "photos", label: "Photos" },
    { kind: "category", label: "Category", channels: ["Allegro Lokalnie", "Vinted"] },
    { kind: "brand", label: "Brand", channels: ["Vinted"] },
    // Rechecked on every change until done: the operator completes it.
    { kind: "details", label: "Item details", channels: ["Allegro Lokalnie"], live: true },
    { kind: "delivery", label: "Shipping" },
    { kind: "promotion", label: "Promotion", channels: ["Allegro Lokalnie"] },
  ].filter((field) => !field.channels || field.channels.includes(channel));

  const visible = (selector) => [...document.querySelectorAll(selector)].filter((element) => isVisible(element));
  const onPage = (path) => location.pathname.replace(/\/+$/, "").endsWith(path);

  // "Next" buttons that only move between steps; every site's publish
  // button ("Dodaj ogłoszenie", "Wystaw…", Vinted's "Dodaj") is never pressed.
  // OLX shows the rest of its form after the title. Allegro Lokalnie's first
  // page moves on once its product and required features are picked too.
  const NEXT_STEPS = {
    OLX: [{ button: /^dalej$/, ready: () => results.get("title")?.ok && !findField("price") }],
    "Allegro Lokalnie": [
      {
        button: /^kolejny krok$/,
        ready: () => onPage("/wystaw") && results.get("title")?.ok && results.get("category")?.ok
          && hasText(findField("description")) && allegroItemDetails()?.ok,
      },
      { button: /^kolejny krok$/, ready: () => onPage("/wystaw/szczegoly") && results.get("price")?.ok && results.has("delivery") },
      { button: /^kolejny krok$/, ready: () => onPage("/wystaw/wyroznij") && results.get("promotion")?.ok },
    ],
  };
  const advancedOn = new Set();

  function advance() {
    if (advancedOn.has(location.href)) return false;
    const rule = (NEXT_STEPS[channel] || []).find((item) => item.ready());
    const next = rule && visible("button").find((element) => rule.button.test(norm(element.textContent)));
    if (!next) return false;
    advancedOn.add(location.href);
    next.click();
    return true;
  }

  const hasText = (field) => Boolean(field) && !isEmpty(field);

  /**
   * Allegro Lokalnie's item details after the category: the catalogue
   * product, the condition and the required features (Cechy) such as
   * "Nośnik*". The product and features depend on the item, so they stay the
   * operator's; this tracks what is left, which gates the next step.
   */
  function allegroItemDetails() {
    if (!onPage("/wystaw")) return null;
    if (!visible("h1, h2, h3, h4").some((heading) => /^(cechy|stan)\*?$/.test(norm(heading.textContent)))) return null;
    const missing = visible("[role='combobox']")
      .map((element) => ({ element, own: describe(element) }))
      .filter(({ element, own }) => (own.includes("*") || CONDITION_WORD.test(norm(own))) && /^wybierz/.test(norm(element.textContent)))
      .map(({ own }) => own.split("|").map((part) => part.trim()).filter((part) => part && !/^downshift/.test(part)).at(-1)?.replace(/\*$/, "") || "a feature");
    const products = visible("[data-testid='product-item']");
    const productMissing = products.length > 0 && !products.some((item) => item.querySelector("input:checked"));
    if (!missing.length && !productMissing) return { ok: true, final: true, note: "done" };
    const todo = [...(productMissing ? ["the product or “Żaden z powyższych”"] : []), ...new Set(missing)];
    return { ok: false, final: false, note: `pick ${todo.join(", ")}` };
  }

  /**
   * Vinted's brand: search the title's first words and take only a result
   * named exactly that; anything else is left to the operator.
   */
  async function chooseVintedBrand(job) {
    const input = document.querySelector("[data-testid='brand-select-dropdown-input']");
    if (!input || !isVisible(input)) return null;
    if (input.value) return { ok: true, final: true, note: "already chosen" };
    const [first = "", second = ""] = (job.flip.listing?.title || job.flip.title).trim().split(/\s+/);
    const names = [...new Set([`${first} ${second}`.trim(), first])].filter((name) => /\p{L}{2}/u.test(name));
    input.click();
    await wait(500);
    const search = visible("input").find((element) => element !== input && /search|szukaj/.test(norm(describe(element))) && /brand|mark/.test(norm(describe(element))));
    if (!search) {
      pressEscape(input);
      return { ok: false, final: true, note: "choose it yourself" };
    }
    for (const name of names) {
      setValue(search, name, { blur: false });
      await wait(900);
      const firstLine = (element) => norm((element.innerText || element.textContent).split("\n")[0]);
      const match = visible("[role='option'], [role='radio'], [role='button'], li, label")
        .filter((element) => !element.contains(search) && firstLine(element) === norm(name))
        .sort((a, b) => a.textContent.length - b.textContent.length)[0];
      if (!match) continue;
      match.click();
      await wait(300);
      return { ok: true, final: true, note: `${name}, check it` };
    }
    pressEscape(search);
    return { ok: false, final: true, note: "no exact match, choose it yourself" };
  }

  // --- Choosing a category ------------------------------------------------------

  /** Words worth matching on, as typed: no model codes, numbers or short fillers. */
  // Paths run together ("Kultura i rozrywkaMuzyka") are split at the capital.
  const words = (text) => [...new Set((text || "").replace(/(\p{Ll})(\p{Lu})|(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1$3 $2$4").split(/[^\p{L}]+/u).filter((word) => word.length > 3))];
  // Polish inflects ("słuchawki", "słuchawkowe"): words match on their first five letters.
  const stem = (word) => norm(word).slice(0, 5);

  /**
   * How well a category fits the item. The category keyword from Scout
   * ("Słuchawki") counts three times as much as a word of the title, and
   * each word of the category's own name that says nothing about the item
   * costs half, so "Słuchawki" beats "Słuchawki dla dzieci".
   */
  function categoryScore(text, job, leaf = "") {
    const stems = new Set(words(text).map(stem));
    const hits = (list) => list.filter((word) => stems.has(stem(word))).length;
    const item = [...words(job.flip.listing?.category), ...words(job.flip.listing?.title || job.flip.title)];
    const itemStems = new Set(item.map(stem));
    const unrelated = words(leaf).filter((word) => !itemStems.has(stem(word))).length;
    return hits(words(job.flip.listing?.category)) * 3 + hits(words(job.flip.listing?.title || job.flip.title)) - unrelated / 2;
  }

  /** The best-scoring element; the site's own order breaks ties. */
  function bestCategory(elements, job, leafOf) {
    return elements
      .map((element, index) => ({ element, index, score: categoryScore(element.textContent, job, leafOf(element)) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
  }

  /** Allegro Lokalnie suggests categories from the title; take the one that fits best. */
  async function chooseCategory(job) {
    if (channel === "Allegro Lokalnie") {
      const suggestions = visible("[data-testid='suggested-category-selection']");
      if (!suggestions.length) return null;
      const best = bestCategory(suggestions, job, categoryName);
      const checked = suggestions.find((label) => label.querySelector("input:checked"));
      // A suggestion already picked stays unless another fits better.
      const chosen = checked && categoryScore(checked.textContent, job, categoryName(checked)) >= best.score ? checked : best.element;
      if (!chosen.querySelector("input:checked")) chosen.click();
      return { ok: true, final: true, note: `${categoryName(chosen)}${best.score > 0 ? "" : ", Allegro's first guess"}, check it` };
    }
    if (channel === "Vinted") return chooseVintedCategory(job);
    return null;
  }

  // "Kultura i rozrywkaMuzyka": the path is run together; show the leaf.
  const categoryName = (element) => element.textContent.trim().split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).at(-1) || element.textContent.trim();

  /**
   * Vinted has no suggestions: search its categories with Scout's category
   * keyword, then with the title's longest words, and take the result that
   * fits the item best.
   */
  // "SłuchawkiElektronika > Audio": the result's own name comes first.
  const vintedLeaf = (element) => element.textContent.trim().split(/(?<=\p{Ll})(?=\p{Lu})/u)[0];

  async function chooseVintedCategory(job) {
    const input = document.querySelector("[data-testid='catalog-select-dropdown-input']");
    if (!input || !isVisible(input)) return null;
    if (input.value) return { ok: true, final: true, note: "already chosen" };
    input.click();
    await wait(500);
    const search = document.querySelector("input[name='catalog-search-input']");
    if (!search) return { ok: false, final: true, note: "choose it yourself" };
    const category = (job.flip.listing?.category || "").trim();
    const titleWords = words(job.flip.listing?.title || job.flip.title).sort((a, b) => b.length - a.length).slice(0, 4);
    const queries = [...new Set([category, ...(words(category).length > 1 ? words(category) : []), ...titleWords])].filter(Boolean).slice(0, 6);
    for (const query of queries) {
      // Typing into the search, without leaving it, which closes the list.
      setValue(search, query, { blur: false });
      await wait(900);
      const results = visible("[role='radio'][id^='catalog-search'], [id^='catalog-search-'][id$='-result'], [data-testid^='catalog-search-'][data-testid$='-result']");
      if (!results.length) continue;
      const { element } = bestCategory(results, job, vintedLeaf);
      element.click();
      await wait(300);
      return { ok: true, final: true, note: `${vintedLeaf(element)}, check it` };
    }
    pressEscape(search);
    return { ok: false, final: true, note: "no match, choose it yourself" };
  }

  // A parcel size picked in Options, as each site names it.
  const PARCEL = {
    "Allegro Lokalnie": { S: "mala paczka", M: "srednia paczka", L: "duza paczka", XL: "duza paczka" },
    Vinted: { S: "5 kg", M: "5 kg", L: "10 kg", XL: "20 kg" },
  };

  /** OLX parcel sizes read "SPłyta CD…", "XLLampa…": the size, then an example. */
  const parcelSizeOf = (element) => (element.textContent.trim().match(/^(XL|S|M|L)(?=\p{Lu})/u) || [])[1];

  async function chooseDelivery(size) {
    if (channel === "OLX") {
      // Switch on Przesyłka OLX and pick the parcel size from the options.
      const toggle = document.querySelector("input[data-testid^='switch-opt-in']");
      if (!toggle || !isVisible(toggle.closest("label") || toggle.parentElement || toggle)) return null;
      if (!toggle.checked) {
        toggle.click();
        await wait(700);
      }
      const option = visible("[role='button']").find((element) => parcelSizeOf(element) === size);
      if (!option) return { ok: false, final: false, note: `pick size ${size} yourself` };
      option.click();
      return { ok: true, final: true, note: `Przesyłka OLX, size ${size}` };
    }
    if (channel === "Allegro Lokalnie") {
      if (!onPage("/wystaw/szczegoly")) return null;
      const wanted = PARCEL[channel][size];
      const option = visible("button").find((element) => norm(element.textContent).includes(wanted));
      if (!option) return null;
      // These buttons may toggle; one already open stays as it is.
      const open = ["aria-pressed", "aria-expanded", "aria-selected", "aria-checked"].some((name) => option.getAttribute(name) === "true");
      if (!open) option.click();
      return { ok: true, final: true, note: option.querySelector("h1, h2, h3, h4, h5")?.textContent || wanted };
    }
    if (channel === "Vinted") {
      const options = [...document.querySelectorAll("input[type='radio'][name^='package_type_selector']")];
      if (!options.length) return null;
      const wanted = PARCEL[channel][size];
      const option = options.find((input) => norm(describe(input)).includes(wanted));
      if (!option) return { ok: false, final: true, note: "choose it yourself" };
      if (!option.checked) (option.labels?.[0] || option).click();
      return { ok: true, final: true, note: wanted };
    }
    return null;
  }

  /** Allegro Lokalnie offers paid promotion before the summary; take the free option. */
  function choosePromotion() {
    const option = visible("[data-testid='promotion-radio-selection']").find((label) => norm(label.textContent).startsWith("nie chce wyrozniac"));
    if (!option) return null;
    if (!option.querySelector("input:checked")) option.click();
    return { ok: true, final: true, note: "none (free)" };
  }

  const isEmpty = (element) => !norm(element.isContentEditable ? element.textContent : element.value);

  /**
   * Fill one field if the current page shows it. Returns null when the field
   * is not on this page yet, otherwise { ok, note }. Fields that already hold
   * text are left alone while following, so later steps never undo an edit.
   */
  async function fillField(kind, job, { following }) {
    const listing = job.flip.listing;
    const price = listing?.prices?.[channel] ?? listing?.basePrice ?? null;
    if (kind === "price") {
      if (!price) return { ok: false, final: true, note: "none set in Scout" };
      const field = findField(kind);
      if (!field) return null;
      if (following && !isEmpty(field)) return { ok: true, final: true, note: "already filled" };
      return fillPrice(field, price);
    }
    if (kind === "title" || kind === "description") {
      const value = kind === "title" ? listing?.title || job.flip.title : listing?.description || "";
      if (!value) return { ok: false, final: true, note: "none in Scout yet" };
      const field = findField(kind);
      if (!field) return null;
      if (following && !isEmpty(field)) return { ok: true, final: true, note: "already filled" };
      const ok = setValue(field, value);
      return { ok, final: ok, note: ok ? "" : "check it, the site may have changed it" };
    }
    if (kind === "condition") {
      if (!listing?.condition) return { ok: false, final: true, note: "not set in Scout" };
      const label = CONDITION_LABELS[listing.condition]?.[channel];
      if (!label) return { ok: false, final: true, note: "choose it yourself" };
      // A list that opened without the option is retried on the next change
      // the page makes, up to the attempt limit, then left to the operator.
      const picked = await chooseCondition(label);
      if (!picked) return null;
      return picked === "picked" ? { ok: true, final: true, note: label } : { ok: false, final: false, note: `pick “${label}” yourself` };
    }
    if (kind === "photos") {
      if (!job.flip.photos.length) return { ok: false, final: true, note: "none in Scout yet" };
      if (!findPhotoInput()) return null;
      setStatus("Downloading photos from Scout…");
      const photos = await send("photos");
      const { attached, reason } = await attachPhotos(photos);
      return { ok: attached === photos.length, final: attached > 0, note: `${attached} of ${photos.length}${reason ? `, ${reason}` : ""}` };
    }
    if (kind === "category") return chooseCategory(job);
    if (kind === "brand") return chooseVintedBrand(job);
    if (kind === "details") return allegroItemDetails();
    if (kind === "delivery") {
      if (!job.parcelSize) return { ok: false, final: true, note: "choose it yourself, or set a parcel size in Options" };
      return chooseDelivery(job.parcelSize);
    }
    if (kind === "promotion") return choosePromotion();
    return null;
  }

  // kind -> { ok, note } for fields that are done; anything missing is pending.
  const results = new Map();
  const attempts = new Map();
  const MAX_ATTEMPTS = 3;
  let following = false;
  let filling = false;
  let observer = null;
  let observeTimer = 0;

  async function fillAvailable(job, { firstPress = false } = {}) {
    if (filling) return 0;
    filling = true;
    let filledNow = 0;
    try {
      for (const { kind, live } of FIELDS) {
        if (results.has(kind) && !(live && !results.get(kind).ok)) continue;
        let outcome;
        try {
          outcome = await fillField(kind, job, { following: !firstPress });
        } catch (error) {
          outcome = { ok: false, final: true, note: error.message };
        }
        if (!outcome) continue;
        if (live) {
          results.set(kind, outcome);
          continue;
        }
        // A site that keeps clearing a field gets three tries, then it is
        // left for the operator instead of fighting their own typing.
        attempts.set(kind, (attempts.get(kind) || 0) + 1);
        if (outcome.final || firstPress || attempts.get(kind) >= MAX_ATTEMPTS) results.set(kind, outcome);
        if (outcome.ok) filledNow += 1;
      }
      if (following && advance()) setStatus("Going to the next step…");
      await send("progress", { following, filled: [...results.entries()].map(([kind, outcome]) => ({ kind, ...outcome })) }).catch(() => {});
    } finally {
      filling = false;
      renderResults();
    }
    return filledNow;
  }

  /** Every field has its outcome and every live one is done. */
  const settled = () => FIELDS.every(({ kind, live }) => results.has(kind) && (!live || results.get(kind).ok));

  function startFollowing(job) {
    following = true;
    if (observer) return;
    observer = new MutationObserver(() => {
      if (settled()) return;
      clearTimeout(observeTimer);
      observeTimer = setTimeout(() => { void fillAvailable(job); }, 700);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    renderResults();
  }

  function stopFollowing() {
    following = false;
    observer?.disconnect();
    observer = null;
    clearTimeout(observeTimer);
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

  // Scout's own look: its tokens, light and dark, inside a closed shadow root
  // so the marketplace's CSS cannot reach it.
  const PANEL_CSS = `
    :host { all: initial; }
    .box { --surface: #fff; --surface-muted: #f8faff; --text: #182133; --text-strong: #101827; --muted: #667085; --line: #e1e6ee; --line-strong: #d6dce6; --blue: #1d61e8; --blue-deep: #1556d2; --blue-soft: #eaf1ff; --green: #3aab61; --orange: #f15a35; --amber: #f4b734;
      position: relative; width: 320px; box-sizing: border-box; font: 13px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 24px 80px rgba(0, 0, 0, .22); overflow: hidden; }
    @media (prefers-color-scheme: dark) {
      .box { --surface: #15181c; --surface-muted: #171b20; --text: #dce2ed; --text-strong: #f7f9fc; --muted: #a2adbd; --line: #2a3039; --line-strong: #353c48; --blue: #2b70ff; --blue-deep: #1b5be5; --blue-soft: #182642; box-shadow: 0 14px 36px rgba(0, 0, 0, .45); }
    }
    * { box-sizing: border-box; }
    header { display: flex; align-items: center; gap: 9px; padding: 12px 10px 10px 14px; border-bottom: 1px solid var(--line); }
    header svg { width: 22px; height: 22px; flex: 0 0 auto; }
    .brand { color: var(--text-strong); font-size: 15px; font-weight: 750; letter-spacing: -.4px; }
    .chip { padding: 2px 8px; border-radius: 999px; background: var(--blue-soft); color: var(--blue); font-size: 11px; font-weight: 650; }
    .spacer { flex: 1; }
    .icon { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--muted); font-size: 16px; line-height: 1; cursor: pointer; }
    .icon:hover { background: var(--surface-muted); color: var(--text); }
    main { padding: 12px 14px 14px; }
    .kicker { color: var(--blue); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .title { margin: 3px 0 0; color: var(--text-strong); font-size: 14px; font-weight: 650; letter-spacing: -.2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ul { list-style: none; display: grid; gap: 6px; margin: 12px 0 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-muted); }
    li { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    li .dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--line-strong); }
    li.ok .dot { background: var(--green); box-shadow: 0 0 0 3px rgba(58, 171, 97, .14); }
    li.todo .dot { background: var(--orange); box-shadow: 0 0 0 3px rgba(241, 90, 53, .14); }
    li.waiting .dot { background: var(--amber); }
    li strong { font-weight: 600; color: var(--text); }
    li span { margin-left: auto; color: var(--muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
    .status { margin: 10px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    button.primary, button.outline { min-height: 36px; padding: 0 13px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .18s ease, border-color .18s ease, color .18s ease; }
    button.primary { flex: 1; border: 0; background: var(--blue); color: #fff; box-shadow: 0 6px 12px rgba(29, 97, 232, .16); }
    button.primary:hover { background: var(--blue-deep); }
    button.outline { border: 1px solid var(--line-strong); background: var(--surface); color: var(--text); }
    button.outline:hover { border-color: var(--blue); color: var(--blue); }
    button:disabled { opacity: .45; cursor: default; }
    footer { display: flex; gap: 14px; padding: 9px 14px 11px; border-top: 1px solid var(--line); }
    .link { border: 0; padding: 0; background: transparent; color: var(--blue); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .bubble { width: 48px; height: 48px; display: grid; place-items: center; border: 0; border-radius: 14px; background: #1d61e8; box-shadow: 0 10px 30px rgba(0, 0, 0, .25); cursor: pointer; padding: 0; }
    .bubble svg { width: 30px; height: 30px; }
  `;
  /** Scout's magnifier mark, as in the app's favicon. */
  function logo() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of [
      ["rect", { width: 64, height: 64, rx: 15, fill: "#1d61e8" }],
      ["circle", { cx: 29, cy: 28, r: 14, fill: "none", stroke: "#fff", "stroke-width": 7 }],
      ["path", { d: "m40 39 12 12", stroke: "#fff", "stroke-width": 7, "stroke-linecap": "round" }],
    ]) {
      const shape = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, String(value));
      svg.append(shape);
    }
    return svg;
  }

  let panel;
  let statusLine;
  let resultList;
  let fillButton;

  const setStatus = (text) => { if (statusLine) statusLine.textContent = text; };

  const el = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  function button(label, className, onClick) {
    const element = el("button", className, label);
    element.type = "button";
    element.addEventListener("click", async () => {
      element.disabled = true;
      try { await onClick(); } catch (error) { setStatus(error.message); } finally { element.disabled = false; }
    });
    return element;
  }

  function renderResults() {
    if (!resultList) return;
    resultList.replaceChildren(...FIELDS.map(({ kind, label }) => {
      const outcome = results.get(kind);
      const state = outcome ? (outcome.ok ? "ok" : "todo") : following ? "waiting" : "";
      const item = el("li", state);
      const note = outcome ? outcome.note || "filled" : following ? "waiting for its step" : "";
      item.append(el("i", "dot"), el("strong", "", label), el("span", "", note));
      item.title = note;
      return item;
    }));
    if (fillButton) fillButton.textContent = following ? "Fill again" : "Fill this form";
    const waiting = FIELDS.filter(({ kind, live }) => !results.has(kind) || (live && !results.get(kind).ok)).length;
    if (!following) return;
    setStatus(waiting
      ? "Go through the form. Scout fills the rest as each step appears. Check everything, then publish."
      : "Everything Scout knows is filled. Add the item details only you know, check every step, then publish.");
  }

  function showPanel(job) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const listing = job.flip.listing;
    const price = listing?.prices?.[channel] ?? listing?.basePrice ?? null;

    const box = el("div", "box");
    const header = el("header");
    const minimize = button("–", "icon", async () => { box.replaceWith(bubble); });
    minimize.title = "Minimize";
    const close = button("×", "icon", async () => { stopFollowing(); await send("dismiss"); host.remove(); });
    close.title = "Stop filling in this tab";
    header.append(logo(), el("span", "brand", "Scout"), el("span", "chip", channel), el("span", "spacer"), minimize, close);

    const main = el("main");
    main.append(el("div", "kicker", price ? `Listing · ${formatPrice(price)} zł` : "Listing"), el("div", "title", listing?.title || job.flip.title));
    resultList = el("ul");
    statusLine = el("p", "status", "Open the first step of the form, then press Fill. Scout keeps filling as later steps appear.");
    fillButton = button("Fill this form", "primary", async () => {
      // A press refills this page even if a field was done on an earlier one.
      for (const [kind, outcome] of results) if (!outcome.ok) results.delete(kind);
      attempts.clear();
      setStatus("Filling…");
      startFollowing(job);
      await fillAvailable(job, { firstPress: true });
    });
    const published = button("I published it", "outline", async () => {
      await send("markListed");
      stopFollowing();
      setStatus(`Marked as listed on ${channel} in Scout.`);
      setTimeout(() => host.remove(), 2500);
    });
    const actions = el("div", "actions");
    actions.append(fillButton, published);
    main.append(resultList, actions, statusLine);

    const footer = el("footer");
    footer.append(
      button("Download photos", "link", async () => { const { count } = await send("downloadPhotos"); setStatus(count ? `Saved ${count} photos to Downloads/Scout. Drag them into the form.` : "This flip has no photos in Scout."); }),
      button("Report form fields", "link", async () => { await navigator.clipboard.writeText(fieldReport()); setStatus("Copied a description of this page's fields. Paste it into your Scout chat if filling misses something."); }),
    );
    box.append(header, main, footer);

    const bubble = el("button", "bubble");
    bubble.type = "button";
    bubble.title = "Scout listing helper";
    bubble.append(logo());
    bubble.addEventListener("click", () => bubble.replaceWith(box));

    root.append(style, box);
    document.documentElement.append(host);
    panel = host;

    // Coming back from a page load mid-form: keep the earlier results and
    // carry on filling what is left.
    for (const item of job.filled || []) if (item?.kind) results.set(item.kind, { ok: Boolean(item.ok), final: true, note: item.note || "" });
    renderResults();
    if (job.following) {
      startFollowing(job);
      void fillAvailable(job);
    }
  }

  // --- Recording a form ------------------------------------------------------

  const clip = (text, length) => (text || "").replace(/\s+/g, " ").trim().slice(0, length) || undefined;
  const testid = (element) => element.getAttribute("data-testid") || element.getAttribute("data-cy") || element.getAttribute("data-test") || undefined;
  const CHOICES = "button, a[href], [role='button'], [role='option'], [role='radio'], [role='checkbox'], [role='menuitem'], [role='tab'], [role='switch'], [role='link'], [role='treeitem'], label";

  /**
   * The shape of the page the operator is looking at: headings, every form
   * control with its options, and the clickable choices. Typed values are
   * never kept, only whether a field has one.
   */
  function pageSnapshot() {
    const controls = [...document.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='combobox'], [role='listbox'], [role='radiogroup']")]
      .filter((element) => element.type !== "hidden")
      .slice(0, 150)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || undefined,
        role: element.getAttribute("role") || undefined,
        name: element.getAttribute("name") || undefined,
        id: element.id || undefined,
        testid: testid(element),
        accept: element.getAttribute("accept") || undefined,
        multiple: element.hasAttribute("multiple") || undefined,
        required: element.required || element.getAttribute("aria-required") === "true" || undefined,
        maxlength: element.getAttribute("maxlength") || undefined,
        inputmode: element.getAttribute("inputmode") || undefined,
        visible: isVisible(element),
        filled: element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) ? element.checked
          : Boolean(element.isContentEditable ? element.textContent.trim() : element.value),
        describes: clip(describe(element), 200),
        options: element instanceof HTMLSelectElement ? [...element.options].slice(0, 80).map((option) => clip(option.textContent, 80)) : undefined,
      }));
    const choices = [...document.querySelectorAll(CHOICES)]
      .filter((element) => isVisible(element))
      .slice(0, 200)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || undefined,
        testid: testid(element),
        text: clip(element.textContent, 80),
        aria: clip(element.getAttribute("aria-label"), 80),
        selected: element.getAttribute("aria-selected") === "true" || element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-pressed") === "true" || undefined,
        disabled: element.disabled || element.getAttribute("aria-disabled") === "true" || undefined,
      }))
      .filter((choice) => choice.text || choice.aria);
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, legend, [role='heading'], [role='dialog'] [class*='title' i]")]
      .filter((element) => isVisible(element))
      .slice(0, 40)
      .map((element) => clip(element.textContent, 120))
      .filter(Boolean);
    const dialogs = [...document.querySelectorAll("[role='dialog'], dialog[open], [aria-modal='true']")].filter((element) => isVisible(element)).length;
    return { url: location.origin + location.pathname, at: new Date().toISOString(), title: clip(document.title, 120), headings, dialogs, controls, choices };
  }

  /** What was clicked, as a person would name it. */
  function clickedThing(target) {
    const element = target instanceof Element ? target.closest(`${CHOICES}, input, textarea, select, li, [onclick], [tabindex]`) || target : null;
    if (!element) return null;
    const typing = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
    return {
      at: new Date().toISOString(),
      url: location.origin + location.pathname,
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || undefined,
      role: element.getAttribute("role") || undefined,
      name: element.getAttribute("name") || undefined,
      testid: testid(element),
      text: typing ? undefined : clip(element.textContent, 80),
      aria: clip(element.getAttribute("aria-label"), 80),
      describes: clip(describe(element), 160),
    };
  }

  function showRecorder(job) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;

    let steps = job.steps || 0;
    let lastSignature = "";
    let timer;
    const box = el("div", "box");
    const header = el("header");
    const minimize = button("–", "icon", async () => { box.replaceWith(bubble); });
    minimize.title = "Minimize";
    header.append(logo(), el("span", "brand", "Scout"), el("span", "chip", "Recording"), el("span", "spacer"), minimize);
    const main = el("main");
    const count = el("div", "kicker");
    const showCount = () => { count.textContent = `${channel} · ${steps} step${steps === 1 ? "" : "s"} recorded`; };
    showCount();
    main.append(count, el("div", "title", "Fill the form as for a real item"));
    statusLine = el("p", "status", "Go through every step: category, details, price, delivery. Open the dropdowns you would use. Don't publish. Then press Finish. Scout keeps the form's layout and your clicks, never what you type.");
    const finish = button("Finish and save", "primary", async () => {
      clearTimeout(timer);
      await snapshot();
      observer?.disconnect();
      document.removeEventListener("click", onClick, true);
      const { filename, steps: saved } = await send("finishRecording");
      setStatus(`Saved ${saved} steps to Downloads/${filename}. Attach that file in your Scout chat.`);
      finish.remove();
      cancel.remove();
      setTimeout(() => host.remove(), 15_000);
    });
    const cancel = button("Cancel", "outline", async () => {
      observer?.disconnect();
      document.removeEventListener("click", onClick, true);
      await send("dismiss");
      host.remove();
    });
    const actions = el("div", "actions");
    actions.append(finish, cancel);
    main.append(actions, statusLine);
    box.append(header, main);

    const bubble = el("button", "bubble");
    bubble.type = "button";
    bubble.title = "Scout is recording this form";
    bubble.append(logo());
    bubble.addEventListener("click", () => bubble.replaceWith(box));
    root.append(style, box);
    document.documentElement.append(host);
    panel = host;

    async function snapshot() {
      const step = pageSnapshot();
      const signature = JSON.stringify([step.url, step.headings, step.dialogs, step.controls.map((item) => [item.describes, item.visible, item.filled, item.options?.length]), step.choices.map((item) => item.text || item.aria)]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      ({ steps } = await send("recordStep", { step }));
      showCount();
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(() => { void snapshot().catch((error) => setStatus(error.message)); }, 1200); };
    function onClick(event) {
      if (event.composedPath().includes(host)) return;
      const click = clickedThing(event.target);
      if (click) void send("recordClick", { click }).catch(() => {});
      later();
    }
    document.addEventListener("click", onClick, true);
    observer = new MutationObserver(later);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded", "aria-selected", "aria-checked", "open"] });
    later();
  }

  send("job").then((job) => {
    if (!job || job.channel !== channel || panel) return;
    if (job.mode === "record") showRecorder(job);
    else showPanel(job);
  }).catch(() => { /* not a Scout tab, or Scout is unreachable */ });
})();
