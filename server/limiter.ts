/** Why a Limiter waiter gave up before it got a slot. */
export class LimiterWaitError extends Error {
  constructor(readonly reason: 'timeout' | 'aborted') {
    super(reason === 'timeout' ? 'Timed out waiting for a free slot' : 'Stopped while waiting for a free slot');
    this.name = 'LimiterWaitError';
  }
}

export interface LimiterRunOptions {
  /** Aborting it removes a waiting task (it rejects with LimiterWaitError 'aborted'); a running task is left alone. */
  signal?: AbortSignal;
  /** Give up after waiting this long (LimiterWaitError 'timeout'); 0 fails at once when no slot is free. */
  maxWaitMs?: number;
  /** `high` waiters start before every `normal` one; each lane is FIFO. */
  priority?: 'high' | 'normal';
}

interface Waiter {
  grant: () => void;
}

/** FIFO concurrency limiter: at most `limit` tasks run at once; the rest wait their turn. */
export class Limiter {
  private active = 0;
  private readonly high: Waiter[] = [];
  private readonly normal: Waiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, options: LimiterRunOptions = {}): Promise<T> {
    await this.acquire(options);
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter so a newcomer can't jump the queue.
      const next = this.high.shift() ?? this.normal.shift();
      if (next) next.grant();
      else this.active -= 1;
    }
  }

  private acquire(options: LimiterRunOptions): Promise<void> {
    const { signal, maxWaitMs } = options;
    if (signal?.aborted) return Promise.reject(new LimiterWaitError('aborted'));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (maxWaitMs !== undefined && maxWaitMs <= 0) return Promise.reject(new LimiterWaitError('timeout'));
    const lane = options.priority === 'high' ? this.high : this.normal;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const giveUp = (reason: 'timeout' | 'aborted') => {
        const index = lane.indexOf(waiter);
        // Already granted: the slot is this task's, so it runs.
        if (index < 0) return;
        lane.splice(index, 1);
        cleanup();
        reject(new LimiterWaitError(reason));
      };
      const onAbort = () => giveUp('aborted');
      const waiter: Waiter = { grant: () => { cleanup(); resolve(); } };
      if (maxWaitMs !== undefined) timer = setTimeout(() => giveUp('timeout'), maxWaitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      lane.push(waiter);
    });
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
