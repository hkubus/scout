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
