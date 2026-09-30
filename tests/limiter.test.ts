import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, mapPool } from '../server/limiter';

test('runs at most the limit at once and starts waiters in FIFO order', async () => {
  const limiter = new Limiter(2);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const releases: Array<() => void> = [];
  const tasks = [0, 1, 2, 3, 4].map((id) => limiter.run(async () => {
    started.push(id);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return id;
  }));
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.deepEqual(started, [0, 1]);
  while (releases.length) {
    releases.shift()!();
    await flush();
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

test('releases the slot when a task rejects', async () => {
  const limiter = new Limiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('blocked'); }), /blocked/);
  assert.equal(await limiter.run(async () => 'next'), 'next');
});

test('mapPool keeps input order, caps concurrency and refills a slot as soon as it frees', async () => {
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  // Item 0 is slow; with fixed batches of 2, item 2 would wait for it.
  const delays = [60, 5, 5, 5, 5, 5];
  const startedAt: number[] = [];
  const t0 = Date.now();
  const results = await mapPool(delays, 2, async (delay, index) => {
    started.push(index);
    startedAt[index] = Date.now() - t0;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index * 10;
  });
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.ok(startedAt[5] < 50, `the fast items do not wait for the slow one (item 5 started at ${startedAt[5]} ms)`);
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
  assert.deepEqual(await mapPool([1, 2, 3], 0, async (value) => value * 2), [2, 4, 6]);
});

test('mapPool runs each synchronous prefix in index order before the next item starts', async () => {
  const order: string[] = [];
  await mapPool(['a', 'b', 'c', 'd'], 3, async (value) => {
    order.push(`start ${value}`);
    await Promise.resolve();
    order.push(`end ${value}`);
  });
  assert.deepEqual(order.slice(0, 3), ['start a', 'start b', 'start c']);
  assert.equal(order.indexOf('start d') > order.indexOf('end a'), true);
});
