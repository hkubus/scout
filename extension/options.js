const api = globalThis.browser;
const form = document.getElementById("form");
const serverUrl = document.getElementById("serverUrl");
const apiToken = document.getElementById("apiToken");
const result = document.getElementById("result");

api.storage.local.get(["serverUrl", "apiToken"]).then((stored) => {
  serverUrl.value = stored.serverUrl || "";
  apiToken.value = stored.apiToken || "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  let origin;
  try {
    const url = new URL(serverUrl.value.trim());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    origin = url.origin;
  } catch {
    result.textContent = "Enter the address you open Scout at, e.g. https://scout.example.com.";
    return;
  }
  // Firefox asks once for access to the Scout server; the marketplaces were
  // granted at install.
  const granted = await api.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    result.textContent = "Firefox needs permission to reach your Scout server.";
    return;
  }
  await api.storage.local.set({ serverUrl: origin, apiToken: apiToken.value.trim() });
  result.textContent = "Testing…";
  const reply = await api.runtime.sendMessage({ type: "flips" });
  result.textContent = reply?.ok
    ? `Connected. ${reply.result.flips.filter((flip) => !flip.soldOn).length} unsold flips.`
    : `Saved, but Scout said: ${reply?.error || "no answer"}`;
});
