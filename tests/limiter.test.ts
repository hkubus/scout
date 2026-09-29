import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../server/limiter';

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
