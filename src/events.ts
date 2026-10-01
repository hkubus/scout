/**
 * The tab's only server-sent-event stream. App.tsx (refresh signals and the
 * online indicator) and feature pages (search progress, logs) all subscribe
 * here, so a tab holds one /events connection however many views it visits;
 * browsers share six HTTP/1.1 connections per host across every tab.
 *
 * The source opens with the first listener and closes with the last, and it
 * also closes after the tab has been hidden for a while and reopens when the
 * tab is shown again. There is no replay: status listeners get `reconnected`
 * whenever a stream comes back after a gap, and callers reconcile from HTTP.
 */
import { api, UNAUTHORIZED_EVENT } from "./api";

type Handler = (payload: unknown) => void;
export type StreamStatus = "online" | "offline";
type StatusHandler = (status: StreamStatus, reconnected: boolean) => void;

/** How long a hidden tab keeps its stream before releasing the connection. */
const HIDDEN_GRACE_MS = 45_000;
/** Retry delay once the browser gives up on a stream (non-2xx, e.g. a proxy 502). */
const CLOSED_RETRY_MS = 5_000;

const listeners = new Map<string, Set<Handler>>();
const statusListeners = new Set<StatusHandler>();
const bound = new Set<string>();
let source: EventSource | null = null;
let status: StreamStatus | null = null;
/** True once any stream was open or failed, so the next "ready" is a reconnect. */
let wasOpen = false;
/** True from opening a source (or an error) until its "ready" arrives. */
let awaitingReady = false;
let hiddenTimer: number | null = null;
let retryTimer: number | null = null;
let closedWhileHidden = false;

const hasListeners = () => listeners.size > 0 || statusListeners.size > 0;

function setStatus(next: StreamStatus, reconnected = false) {
  if (next === status && !reconnected) return;
  status = next;
  for (const handler of statusListeners) handler(next, reconnected);
}

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

function closeSource() {
  source?.close();
  source = null;
  bound.clear();
}

function startHiddenTimer() {
  if (hiddenTimer !== null || !source) return;
  hiddenTimer = window.setTimeout(() => {
    hiddenTimer = null;
    if (!document.hidden || !source) return;
    closeSource();
    closedWhileHidden = true;
  }, HIDDEN_GRACE_MS);
}

/**
 * EventSource cannot see status codes, so a CLOSED stream checks the session
 * before reopening: a lapsed or revoked one sends the app to the sign-in
 * screen instead of retrying every few seconds.
 */
function retryClosedSource() {
  api.authSession().then(
    (session) => {
      if (session.authEnabled && !session.authenticated) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      else ensureSource();
    },
    () => ensureSource(),
  );
}

function ensureSource() {
  if (!hasListeners() || (typeof document !== "undefined" && document.hidden && closedWhileHidden)) return;
  // A CLOSED source never reconnects by itself (for example after a 401 before
  // re-login, or a proxy error page), so replace it.
  if (source && source.readyState !== EventSource.CLOSED) return;
  closeSource();
  closedWhileHidden = false;
  const current = new EventSource("/events");
  source = current;
  awaitingReady = true;
  current.addEventListener("ready", () => {
    if (source !== current) return;
    awaitingReady = false;
    // Native auto-reconnects, reopened streams and a first stream after
    // failed attempts all land here after a gap.
    setStatus("online", wasOpen);
    wasOpen = true;
  });
  current.onerror = () => {
    if (source !== current) return;
    // A page loaded while the server was down reconciles on its first "ready".
    wasOpen = true;
    awaitingReady = true;
    setStatus("offline");
    if (current.readyState === EventSource.CLOSED && retryTimer === null) {
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        retryClosedSource();
      }, CLOSED_RETRY_MS);
    }
  };
  for (const event of listeners.keys()) attach(event);
  // A tab opened in the background releases its stream like one hidden later.
  if (typeof document !== "undefined" && document.hidden) startHiddenTimer();
}

function releaseIfUnused() {
  if (hasListeners()) return;
  closeSource();
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  // Nobody saw the gap, so the next stream starts fresh rather than as a reconnect.
  status = null;
  wasOpen = false;
  awaitingReady = false;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      startHiddenTimer();
      return;
    }
    if (hiddenTimer !== null) window.clearTimeout(hiddenTimer);
    hiddenTimer = null;
    if (closedWhileHidden) {
      closedWhileHidden = false;
      ensureSource();
    }
  });
}

/**
 * Whether a stream is coming back after a gap, so its "ready" will report
 * `reconnected` and callers can leave reconciling to that (one refetch
 * instead of one now and another on "ready").
 */
export function reconnectPending() {
  return source !== null && wasOpen && awaitingReady;
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
    releaseIfUnused();
  };
}

/**
 * Follow the stream's connection state: "online" on each "ready" event (with
 * `reconnected` set when it follows a gap) and "offline" on errors. The last
 * known state is replayed to a new listener. Returns an unsubscribe function.
 */
export function subscribeStatus(handler: StatusHandler) {
  statusListeners.add(handler);
  ensureSource();
  if (status) handler(status, false);
  return () => {
    statusListeners.delete(handler);
    releaseIfUnused();
  };
}
