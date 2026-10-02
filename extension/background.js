// Scout listing helper: background page.
// Holds the Scout address and API token, talks to the Scout server, and hands
// each marketplace tab the flip it should fill. Content scripts never see the
// token; they only get the listing text and photo bytes.

const api = globalThis.browser;

/** The "add a listing" page of each marketplace. */
const FORM_URLS = {
  OLX: "https://www.olx.pl/adding/",
  "Allegro Lokalnie": "https://allegrolokalnie.pl/o/oferty/wystaw",
  Vinted: "https://www.vinted.pl/items/new",
};

async function settings() {
  const { serverUrl = "", apiToken = "" } = await api.storage.local.get(["serverUrl", "apiToken"]);
  return { serverUrl: serverUrl.replace(/\/+$/, ""), apiToken };
}

async function scout(path, init = {}) {
  const { serverUrl, apiToken } = await settings();
  if (!serverUrl) throw new Error("Set your Scout address in the extension's options first.");
  const headers = { Accept: "application/json", ...(init.headers || {}) };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const response = await fetch(`${serverUrl}${path}`, { ...init, headers, credentials: "omit" });
  if (!response.ok) {
    let message = `Scout answered ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* not JSON */ }
    if (response.status === 401) message = "Scout rejected the API token. Check it in the extension's options.";
    throw new Error(message);
  }
  return response;
}

async function scoutJson(path, init) {
  return (await scout(path, init)).json();
}

// Jobs survive the background page being unloaded between messages.
const jobKey = (tabId) => `job:${tabId}`;
async function setJob(tabId, job) {
  if (api.storage.session) await api.storage.session.set({ [jobKey(tabId)]: job });
  else await api.storage.local.set({ [jobKey(tabId)]: job });
}
async function getJob(tabId) {
  const area = api.storage.session || api.storage.local;
  return (await area.get(jobKey(tabId)))[jobKey(tabId)] || null;
}
async function clearJob(tabId) {
  const area = api.storage.session || api.storage.local;
  await area.remove(jobKey(tabId));
}
api.tabs.onRemoved.addListener((tabId) => { void clearJob(tabId); });

async function flipById(flipId) {
  const data = await scoutJson("/api/flips");
  const flip = data.flips.find((item) => item.id === flipId);
  if (!flip) throw new Error("That flip no longer exists in Scout.");
  return { flip, feePresets: data.feePresets };
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function photoPayloads(flip) {
  const photos = [];
  for (const [index, photo] of flip.photos.entries()) {
    const response = await scout(`/api/flip-photos/${photo.id}`);
    photos.push({ name: `photo-${index + 1}.${extension[photo.mime] || "jpg"}`, type: photo.mime, data: base64(await response.arrayBuffer()) });
  }
  return photos;
}

const handlers = {
  async status() {
    const { serverUrl, apiToken } = await settings();
    return { configured: Boolean(serverUrl), serverUrl, hasToken: Boolean(apiToken) };
  },
  async flips() {
    return scoutJson("/api/flips");
  },
  async open({ flipId, channel }) {
    if (!FORM_URLS[channel]) throw new Error(`No form address for ${channel}`);
    const tab = await api.tabs.create({ url: FORM_URLS[channel], active: true });
    // `filled` lists the fields already done, so a form that spreads over
    // several pages fills each field once, on whichever page shows it.
    await setJob(tab.id, { flipId, channel, openedAt: Date.now(), following: false, filled: [] });
    return { tabId: tab.id };
  },
  async job(_message, sender) {
    const job = sender.tab ? await getJob(sender.tab.id) : null;
    if (!job) return null;
    if (job.mode === "record") return { mode: job.mode, channel: job.channel, steps: job.steps.length };
    const { flip, feePresets } = await flipById(job.flipId);
    const { parcelSize = "" } = await api.storage.local.get("parcelSize");
    return { ...job, flip, feePresets, parcelSize };
  },
  async progress({ following, filled }, sender) {
    const job = sender.tab ? await getJob(sender.tab.id) : null;
    if (!job) throw new Error("This tab has no Scout listing to fill.");
    await setJob(sender.tab.id, { ...job, following: Boolean(following), filled: Array.isArray(filled) ? filled : [] });
    return { ok: true };
  },
  async photos(_message, sender) {
    const job = sender.tab ? await getJob(sender.tab.id) : null;
    if (!job) throw new Error("This tab has no Scout listing to fill.");
    const { flip } = await flipById(job.flipId);
    return photoPayloads(flip);
  },
  async downloadPhotos(_message, sender) {
    const job = sender.tab ? await getJob(sender.tab.id) : null;
    if (!job) throw new Error("This tab has no Scout listing to fill.");
    const { flip } = await flipById(job.flipId);
    const folder = `Scout/${flip.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || `flip-${flip.id}`}`;
    for (const [index, photo] of flip.photos.entries()) {
      const blob = await (await scout(`/api/flip-photos/${photo.id}`)).blob();
      const url = URL.createObjectURL(blob);
      try {
        await api.downloads.download({ url, filename: `${folder}/${index + 1}.${extension[photo.mime] || "jpg"}`, conflictAction: "overwrite" });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    }
    return { count: flip.photos.length };
  },
  async markListed(_message, sender) {
    const job = sender.tab ? await getJob(sender.tab.id) : null;
    if (!job) throw new Error("This tab has no Scout listing to fill.");
    const { flip } = await flipById(job.flipId);
    const listedOn = flip.listedOn.includes(job.channel) ? flip.listedOn : [...flip.listedOn, job.channel];
    await scoutJson(`/api/flips/${flip.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listedOn }) });
    await clearJob(sender.tab.id);
    return { listedOn };
  },
  // Recording: the operator walks a listing form by hand and Scout keeps the
  // shape of every step (labels, options, buttons, clicks; never typed
  // values), so the filling can be taught each marketplace's real flow.
  async record({ channel }) {
    if (!FORM_URLS[channel]) throw new Error(`No form address for ${channel}`);
    const tab = await api.tabs.create({ url: FORM_URLS[channel], active: true });
    await setJob(tab.id, { mode: "record", channel, startedAt: new Date().toISOString(), steps: [], clicks: [] });
    return { tabId: tab.id };
  },
  recordStep({ step }, sender) {
    return serially(async () => {
      const job = sender.tab ? await getJob(sender.tab.id) : null;
      if (job?.mode !== "record") throw new Error("This tab is not recording.");
      if (job.steps.length < 80) job.steps.push(step);
      await setJob(sender.tab.id, job);
      return { steps: job.steps.length };
    });
  },
  recordClick({ click }, sender) {
    return serially(async () => {
      const job = sender.tab ? await getJob(sender.tab.id) : null;
      if (job?.mode !== "record") return { ok: false };
      if (job.clicks.length < 600) job.clicks.push(click);
      await setJob(sender.tab.id, job);
      return { ok: true };
    });
  },
  finishRecording: (message, sender) => serially(() => finishRecording(message, sender)),
  async dismiss(_message, sender) {
    if (sender.tab) await clearJob(sender.tab.id);
    return { ok: true };
  },
};

// Recording updates read, change and write the whole job; one at a time.
let queue = Promise.resolve();
function serially(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

async function finishRecording(_message, sender) {
  const job = sender.tab ? await getJob(sender.tab.id) : null;
  if (job?.mode !== "record") throw new Error("This tab is not recording.");
  const { version } = api.runtime.getManifest();
  const recording = { kind: "scout-form-recording", extension: version, channel: job.channel, startedAt: job.startedAt, finishedAt: new Date().toISOString(), steps: job.steps, clicks: job.clicks };
  const url = URL.createObjectURL(new Blob([JSON.stringify(recording, null, 1)], { type: "application/json" }));
  const stamp = recording.finishedAt.slice(0, 16).replace(/[:T]/g, "-");
  const filename = `Scout/form-recordings/${job.channel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}.json`;
  try {
    await api.downloads.download({ url, filename, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  await clearJob(sender.tab.id);
  return { filename, steps: job.steps.length };
}

api.runtime.onMessage.addListener((message, sender) => {
  const handler = message && handlers[message.type];
  if (!handler) return undefined;
  // Errors come back as data: rejected promises lose their message in transit.
  return handler(message, sender).then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});
