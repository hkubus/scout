// Diagnostics shared by every fetch call site: undici pins the socket and its
// buffered data until a response body is consumed or cancelled, so each
// discard is counted by site to confirm the release happens and to show how
// often marketplaces serve the challenge/error pages that hit these paths.
const discardedBodies = new Map<string, number>();

export function discardResponse(response: Response, site: string) {
  const counts = discardedBodies.get(site) ?? 0;
  discardedBodies.set(site, counts + 1);
  try { void response.body?.cancel().catch(() => { /* socket already closed */ }); } catch { /* body already gone */ }
}

export function fetchDiscardSummary(): string {
  if (!discardedBodies.size) return 'none';
  return [...discardedBodies.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([site, count]) => `${site}=${count}`).join(' ');
}
