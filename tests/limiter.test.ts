import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, LimiterWaitError, mapPool } from '../server/limiter';

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

test('mapPool starts no new items after a call rejects', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  const items = Array.from({ length: 10 }, (_, index) => index);
  await assert.rejects(mapPool(items, 3, async (index) => {
    started.push(index);
    if (index === 1) throw new Error('cache read failed');
    await new Promise((resolve) => setTimeout(resolve, 10));
    finished.push(index);
    return index;
  }), /cache read failed/);
  // Let the calls already in flight settle; none of them may pull another item.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(finished.sort(), [0, 2]);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function held(limiter: Limiter) {
  let release!: () => void;
  const done = limiter.run(() => new Promise<void>((resolve) => { release = resolve; }));
  return { done, release: () => release() };
}

test('a waiter that times out gives up without taking or leaking a slot', async () => {
  const limiter = new Limiter(1);
  const first = held(limiter);
  await assert.rejects(limiter.run(async () => 'late', { maxWaitMs: 10 }), (error: unknown) => error instanceof LimiterWaitError && error.reason === 'timeout');
  // No slot free and no wait allowed: fails at once.
  await assert.rejects(limiter.run(async () => 'now', { maxWaitMs: 0 }), (error: unknown) => error instanceof LimiterWaitError && error.reason === 'timeout');
  first.release();
  await first.done;
  // The slot is free again and still exactly one wide.
  const second = held(limiter);
  const third = limiter.run(async () => 'third');
  await flush();
  second.release();
  assert.equal(await third, 'third');
  assert.equal(await limiter.run(async () => 'free', { maxWaitMs: 0 }), 'free');
});

test('aborting removes a waiter, and an aborted signal never waits', async () => {
  const limiter = new Limiter(1);
  const first = held(limiter);
  const controller = new AbortController();
  let ran = false;
  const waiting = limiter.run(async () => { ran = true; }, { signal: controller.signal });
  const after = limiter.run(async () => 'after');
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof LimiterWaitError && error.reason === 'aborted');
  await assert.rejects(limiter.run(async () => 'never', { signal: controller.signal }), (error: unknown) => error instanceof LimiterWaitError && error.reason === 'aborted');
  first.release();
  assert.equal(await after, 'after');
  assert.equal(ran, false);
});

test('high-priority waiters go first, and each lane stays FIFO', async () => {
  const limiter = new Limiter(1);
  const first = held(limiter);
  const order: string[] = [];
  const tasks = [
    limiter.run(async () => { order.push('normal-1'); }),
    limiter.run(async () => { order.push('high-1'); }, { priority: 'high' }),
    limiter.run(async () => { order.push('normal-2'); }),
    limiter.run(async () => { order.push('high-2'); }, { priority: 'high' }),
  ];
  await flush();
  first.release();
  await Promise.all(tasks);
  assert.deepEqual(order, ['high-1', 'high-2', 'normal-1', 'normal-2']);
});
