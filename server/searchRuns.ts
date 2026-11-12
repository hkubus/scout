/**
 * Manual-search runs. At most `slots` searches run at once and the rest wait
 * their turn instead of being refused; identical searches (the same key)
 * share one run. The coordinator knows nothing about marketplaces: a run
 * reports parts (one per marketplace) as they finish, and every caller
 * attached to the run sees each part once, including the ones that finished
 * before it joined.
 */

import type { SearchFilters } from '../src/types';

/**
 * Inputs that never change a search's result: they name or pace the call.
 * Everything else, including inputs added later, is part of the key.
 */
const NOT_IN_KEY = new Set(['searchId', 'deadlineMs', 'refresh', 'format']);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([name, entry]) => `${JSON.stringify(name)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Two searches with the same key return the same result. Defaults are filled
 * in so the web form, the apps and MCP (which omit different fields) agree;
 * the query keeps its case (typo spellings echo it), and sources keep their
 * order (the response lists them in it).
 */
export function manualSearchKey(input: SearchFilters): string {
  const key: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!NOT_IN_KEY.has(name)) key[name] = value;
  }
  Object.assign(key, {
    query: input.query.trim().replace(/\s+/g, ' '),
    sources: [...new Set(input.sources)],
    terms: (input.terms ?? '').trim(),
    excluded: (input.excluded ?? '').trim(),
    minPrice: input.minPrice ?? null,
    maxPrice: input.maxPrice ?? null,
    shippingOnly: Boolean(input.shippingOnly),
    condition: (input.condition ?? '').trim() || 'Any',
    ownerType: input.ownerType ?? null,
    // Only the id reaches the marketplace; label and path are display.
    olxCategory: input.olxCategory?.id ?? null,
    page: Math.min(Math.max(Math.floor(input.page ?? 1), 1), 10),
    sort: input.sort ?? 'relevance',
    aiRelevance: input.aiRelevance !== false,
    verificationChecks: input.verificationChecks ?? [],
    scoreAgainst: input.scoreAgainst?.trim() || null,
    ignoreBackoff: Boolean(input.ignoreBackoff),
    typoVariants: Boolean(input.typoVariants),
  });
  return stableJson(key);
}

/** A caller's search did not get a slot before its deadline. */
export class SearchQueueTimeoutError extends Error {
  constructor() {
    super('Three manual searches are already running. Try again shortly.');
    this.name = 'SearchQueueTimeoutError';
  }
}

export interface SearchRunSettings {
  /** Runs at once; more wait in FIFO order. */
  slots: number;
  /** How long a caller waits for its search, the queue included. */
  deadlineMs: number;
}

export interface SearchRunHandle<Part> {
  /** One finished part, shown to every caller attached now or later. */
  report(part: Part): void;
}

export interface SearchCall<Part, Result> {
  /** Runs the search; only the call that starts a run executes it, joiners share its result. */
  execute: (run: SearchRunHandle<Part>) => Promise<Result>;
  /** Each finished part, once. */
  onPart?: (part: Part) => void;
}

interface Caller<Part> {
  onPart?: (part: Part) => void;
}

interface Run<Part, Result> {
  key: string;
  parts: Part[];
  callers: Set<Caller<Part>>;
  /** Settles with the search; rejects with SearchQueueTimeoutError when dropped from the queue. */
  result: Promise<Result>;
  /** Resolves once the run holds a slot. */
  started: Promise<void>;
  holdsSlot: boolean;
  grant: () => void;
  drop: () => void;
}

export class SearchRuns<Part, Result> {
  private readonly inFlight = new Map<string, Run<Part, Result>>();
  private readonly running = new Set<Run<Part, Result>>();
  private readonly queued: Array<Run<Part, Result>> = [];

  constructor(private readonly settings: SearchRunSettings) {}

  /** Searches currently holding a slot and waiting for one; for tests and diagnostics. */
  get load() {
    return { running: this.running.size, queued: this.queued.length };
  }

  async search(key: string, call: SearchCall<Part, Result>): Promise<Result> {
    const deadlineAt = Date.now() + this.settings.deadlineMs;
    const run = this.inFlight.get(key) ?? this.start(key, call.execute);
    const caller: Caller<Part> = { onPart: call.onPart };
    run.callers.add(caller);
    for (const part of run.parts) caller.onPart?.(part);
    try {
      if (!run.holdsSlot) await this.waitForSlot(run, deadlineAt);
      return await run.result;
    } finally {
      run.callers.delete(caller);
    }
  }

  private start(key: string, execute: SearchCall<Part, Result>['execute']): Run<Part, Result> {
    let grant!: () => void;
    let drop!: () => void;
    const started = new Promise<void>((resolve, reject) => {
      grant = resolve;
      drop = () => reject(new SearchQueueTimeoutError());
    });
    const run: Run<Part, Result> = {
      key,
      parts: [],
      callers: new Set(),
      started,
      holdsSlot: false,
      grant: () => { run.holdsSlot = true; this.running.add(run); grant(); },
      drop,
      result: Promise.resolve() as unknown as Promise<Result>,
    };
    const handle: SearchRunHandle<Part> = {
      report: (part) => {
        run.parts.push(part);
        for (const caller of run.callers) caller.onPart?.(part);
      },
    };
    run.result = (async () => {
      try {
        await started;
        return await execute(handle);
      } finally {
        this.finish(run);
      }
    })();
    // A dropped run's rejection reaches only the callers still waiting on it.
    run.result.catch(() => {});
    this.inFlight.set(key, run);
    if (this.running.size < this.settings.slots) run.grant();
    else this.queued.push(run);
    return run;
  }

  /** Waits for the run's slot until the caller's deadline; a run nobody waits for leaves the queue. */
  private async waitForSlot(run: Run<Part, Result>, deadlineAt: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now())); });
    try {
      const outcome = await Promise.race([run.started.then(() => 'started' as const), timeout]);
      if (outcome === 'started') return;
      // Other callers may still wait on this run with later deadlines.
      if (run.callers.size <= 1 && !run.holdsSlot) {
        const index = this.queued.indexOf(run);
        if (index >= 0) this.queued.splice(index, 1);
        if (this.inFlight.get(run.key) === run) this.inFlight.delete(run.key);
        run.drop();
      }
      throw new SearchQueueTimeoutError();
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(run: Run<Part, Result>) {
    if (this.inFlight.get(run.key) === run) this.inFlight.delete(run.key);
    if (!this.running.delete(run)) return;
    this.queued.shift()?.grant();
  }
}
