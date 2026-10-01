/** FIFO concurrency limiter: at most `limit` tasks run at once; the rest wait their turn. */
export class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter so a newcomer can't jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/**
 * Map `items` through `fn` with at most `concurrency` calls in flight. Workers
 * take items strictly in index order, each call's synchronous prefix runs
 * before the next item is started, and results keep the input order. Unlike
 * fixed batches, a slow item holds only its own slot. Once any call rejects,
 * no new items start (calls already in flight still finish) and the returned
 * promise rejects with the first error.
 */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  // After a rejection the result is discarded, so start no further items.
  let failed = false;
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const width = Math.min(Math.max(1, Math.floor(concurrency) || 1), items.length);
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}
