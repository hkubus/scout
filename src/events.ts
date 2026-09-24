/**
 * Shared server-sent-event subscription. App.tsx keeps its own EventSource for
 * the global refresh signals; feature pages (search progress) use this one so
 * they do not have to thread a subscription through props. One EventSource per
 * caller group, named event types, and no replay — callers treat a missed event
 * as "reconcile from the next HTTP response".
 */
type Handler = (payload: unknown) => void;

const listeners = new Map<string, Set<Handler>>();
const bound = new Set<string>();
let source: EventSource | null = null;

function attach(event: string) {
  if (!source || bound.has(event)) return;
  bound.add(event);
  source.addEventListener(event, (message) => {
    let payload: unknown;
    try {
      payload = JSON.parse((message as MessageEvent).data);
    } catch {
      return;
    }
    for (const handler of listeners.get(event) ?? []) handler(payload);
  });
}

function ensureSource() {
  if (source) return;
  source = new EventSource("/events");
  for (const event of listeners.keys()) attach(event);
}

/** Subscribe to one named event; returns an unsubscribe function. */
export function subscribe(event: string, handler: Handler) {
  const handlers = listeners.get(event) ?? new Set<Handler>();
  handlers.add(handler);
  listeners.set(event, handlers);
  ensureSource();
  attach(event);
  return () => {
    handlers.delete(handler);
    if (!handlers.size) listeners.delete(event);
  };
}
