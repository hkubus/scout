import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser surface for src/events.ts: one fake EventSource class that
// records every instance, a hideable document, and window timers.
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, Array<(message: { data: string }) => void>>();
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(event: string, handler: (message: { data: string }) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  close() { this.readyState = FakeEventSource.CLOSED; }
  dispatch(event: string, payload: unknown = {}) {
    if (event === 'ready') this.readyState = FakeEventSource.OPEN;
    for (const handler of this.handlers.get(event) ?? []) handler({ data: JSON.stringify(payload) });
  }
  fail(closed = false) {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

class FakeDocument extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

mock.timers.enable({ apis: ['setTimeout'] });
const fakeDocument = new FakeDocument();
// window events (the unauthorized signal) and the session check a CLOSED stream makes.
const windowEvents = new EventTarget();
let session = { authEnabled: true, authenticated: true, passwordLogin: true };
let sessionChecks = 0;
Object.assign(globalThis, {
  window: globalThis,
  document: fakeDocument,
  EventSource: FakeEventSource,
  addEventListener: windowEvents.addEventListener.bind(windowEvents),
  removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
  dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
  fetch: async (path: string) => {
    assert.equal(path, '/api/auth/session');
    sessionChecks += 1;
    return new Response(JSON.stringify(session), { status: 200 });
  },
});
const { reconnectPending, subscribe, subscribeStatus } = await import('../src/events');
const { UNAUTHORIZED_EVENT } = await import('../src/api');
const settle = () => new Promise((resolve) => setImmediate(resolve));

const open = () => FakeEventSource.instances.filter((source) => source.readyState !== FakeEventSource.CLOSED);
const latest = () => FakeEventSource.instances.at(-1)!;

test('every subscriber in a tab shares one EventSource, closed with the last listener', () => {
  const seen: unknown[] = [];
  const offScan = subscribe('scan', (payload) => seen.push(['scan', payload]));
  const offStatus = subscribeStatus(() => {});
  const offSearch = subscribe('search', (payload) => seen.push(['search', payload]));
  assert.equal(FakeEventSource.instances.length, 1);
  latest().dispatch('scan', { watchId: 'a' });
  latest().dispatch('search', { searchId: 's' });
  assert.deepEqual(seen, [['scan', { watchId: 'a' }], ['search', { searchId: 's' }]]);
  offSearch();
  offScan();
  assert.equal(open().length, 1, 'a status listener alone keeps the stream');
  offStatus();
  assert.equal(open().length, 0);
});

test('reopens with every current event bound after the last listener left', () => {
  const seen: string[] = [];
  const off = subscribe('log', () => seen.push('log'));
  const offSearch = subscribe('search', () => seen.push('search'));
  offSearch();
  off();
  const offAgain = subscribe('log', () => seen.push('log2'));
  assert.equal(open().length, 1);
  latest().dispatch('log');
  latest().dispatch('search');
  assert.deepEqual(seen, ['log2']);
  offAgain();
});

test('status: online on ready, offline on error, reconnected only after a gap', () => {
  const statuses: Array<[string, boolean]> = [];
  const off = subscribeStatus((status, reconnected) => statuses.push([status, reconnected]));
  const source = latest();
  source.dispatch('ready');
  source.fail();
  source.dispatch('ready');
  assert.deepEqual(statuses, [['online', false], ['offline', false], ['online', true]]);
  // A late listener gets the current state replayed.
  const replay: string[] = [];
  const offReplay = subscribeStatus((status) => replay.push(status));
  assert.deepEqual(replay, ['online']);
  offReplay();
  off();
});

test('replaces a CLOSED source after a retry delay and a session check', async () => {
  const statuses: Array<[string, boolean]> = [];
  const off = subscribeStatus((status, reconnected) => statuses.push([status, reconnected]));
  const first = latest();
  first.dispatch('ready');
  first.fail(true);
  assert.equal(open().length, 0);
  const checks = sessionChecks;
  mock.timers.tick(5_000);
  await settle();
  assert.equal(sessionChecks, checks + 1);
  assert.notEqual(latest(), first);
  latest().dispatch('ready');
  assert.deepEqual(statuses, [['online', false], ['offline', false], ['online', true]]);
  off();
});

test('closes after the hidden grace period and reopens as a reconnect when shown', () => {
  const statuses: Array<[string, boolean]> = [];
  const off = subscribeStatus((status, reconnected) => statuses.push([status, reconnected]));
  const offScan = subscribe('scan', () => {});
  latest().dispatch('ready');
  const before = FakeEventSource.instances.length;
  fakeDocument.setHidden(true);
  mock.timers.tick(30_000);
  fakeDocument.setHidden(false);
  fakeDocument.setHidden(true);
  mock.timers.tick(30_000);
  assert.equal(open().length, 1, 'a short hide keeps the stream');
  mock.timers.tick(20_000);
  assert.equal(open().length, 0, 'closed after the grace period');
  fakeDocument.setHidden(false);
  assert.equal(FakeEventSource.instances.length, before + 1);
  latest().dispatch('ready');
  assert.deepEqual(statuses, [['online', false], ['online', true]]);
  offScan();
  off();
});

test('a CLOSED source with a lapsed session sends the app to sign-in instead of retrying', async () => {
  let unauthorized = 0;
  const onUnauthorized = () => { unauthorized += 1; };
  window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  session = { ...session, authenticated: false };
  const off = subscribeStatus(() => {});
  const first = latest();
  first.dispatch('ready');
  first.fail(true);
  mock.timers.tick(5_000);
  await settle();
  assert.equal(unauthorized, 1);
  assert.equal(latest(), first, 'no new stream');
  mock.timers.tick(30_000);
  await settle();
  assert.equal(unauthorized, 1, 'no further retries');
  off();
  window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  session = { ...session, authenticated: true };
});

test('a first stream after failed attempts reports a reconnect', () => {
  const statuses: Array<[string, boolean]> = [];
  const off = subscribeStatus((status, reconnected) => statuses.push([status, reconnected]));
  assert.equal(reconnectPending(), false, 'a fresh stream is not a reconnect');
  latest().fail();
  assert.equal(reconnectPending(), true);
  latest().dispatch('ready');
  assert.equal(reconnectPending(), false);
  assert.deepEqual(statuses, [['offline', false], ['online', true]]);
  off();
});

test('a tab opened in the background releases the stream and reconciles once when shown', () => {
  fakeDocument.hidden = true;
  const statuses: Array<[string, boolean]> = [];
  const off = subscribeStatus((status, reconnected) => statuses.push([status, reconnected]));
  latest().dispatch('ready');
  mock.timers.tick(45_000);
  assert.equal(open().length, 0, 'released without any visibilitychange');
  const before = FakeEventSource.instances.length;
  fakeDocument.setHidden(false);
  assert.equal(FakeEventSource.instances.length, before + 1);
  assert.equal(reconnectPending(), true, 'App leaves the refetch to the coming ready');
  latest().dispatch('ready');
  assert.equal(reconnectPending(), false);
  assert.deepEqual(statuses, [['online', false], ['online', true]]);
  off();
});
