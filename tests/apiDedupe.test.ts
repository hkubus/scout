import test from 'node:test';
import assert from 'node:assert/strict';

// GET de-duplication in src/api.ts against a fetch that answers on demand.
const pending: Array<(body: unknown) => void> = [];
Object.assign(globalThis, {
  window: globalThis,
  fetch: () => new Promise<Response>((resolve) => {
    pending.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })));
  }),
});
const { api, forgetInFlightGets } = await import('../src/api');

test('identical GETs share one request until a server event invalidates it', async () => {
  const first = api.connectors();
  const shared = api.connectors();
  assert.equal(pending.length, 1);
  forgetInFlightGets();
  const fresh = api.connectors();
  assert.equal(pending.length, 2, 'a GET after the event does not reuse the older response');
  pending[0]({ connectors: ['old'] });
  assert.deepEqual(await first, { connectors: ['old'] });
  assert.deepEqual(await shared, { connectors: ['old'] });
  // The older request settling leaves the newer one shared.
  const joined = api.connectors();
  assert.equal(pending.length, 2);
  pending[1]({ connectors: ['new'] });
  assert.deepEqual(await fresh, { connectors: ['new'] });
  assert.deepEqual(await joined, { connectors: ['new'] });
});
