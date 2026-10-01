import type { LogEntry } from "./types";

/** Matches the server's in-memory LOG_BUFFER_LIMIT. */
export const LOG_LIMIT = 500;

/** Prepend one live entry (newest first, like GET /api/logs) unless it is already shown. */
export function prependLog(current: LogEntry[], entry: LogEntry) {
  return current.some((log) => log.id === entry.id) ? current : [entry, ...current].slice(0, LOG_LIMIT);
}

/**
 * Combine a GET /api/logs result with the live entries (newest first) that
 * arrived while it was in flight: the response may have been built before
 * them. After a server restart ids start over, but every live entry received
 * during the request comes from the server that answered it.
 */
export function mergeLogs(live: readonly LogEntry[], fetched: LogEntry[]) {
  if (!live.length) return fetched;
  const fetchedIds = new Set(fetched.map((log) => log.id));
  return [...live.filter((log) => !fetchedIds.has(log.id)), ...fetched].slice(0, LOG_LIMIT);
}
