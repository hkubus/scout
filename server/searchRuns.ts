/**
 * Manual-search runs. At most `slots` searches run at once and the rest wait
 * their turn instead of being refused; identical searches (the same key)
 * share one run. The coordinator knows nothing about marketplaces: a run
 * reports parts (one per marketplace) as they finish, and every caller
 * attached to the run sees each part once, including the ones that finished
 * before it joined.
 *
 * Each caller has its own deadline, the wait for a slot included. At the
 * deadline a running search answers with the parts that finished; one still
 * queued gets the busy error. The run itself keeps going for whoever repeats
 * the search, until `maxRunMs`, until every caller has disconnected, or until
 * a queued search needs its slot and no caller is waiting on it any more.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { SearchFilters } from '../src/types';

/**
 * What a manual search's own work runs under: marketplace requests and AI
 * calls read it to stop waiting for a slot once the search is stopped.
 */
export interface SearchScope {
  signal: AbortSignal;
}
export const searchScope = new AsyncLocalStorage<SearchScope>();

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

/** A run was stopped (every caller left, a queued search took its slot, or it ran too long), or a caller left. */
export class SearchStoppedError extends Error {
  constructor(readonly reason: 'aborted' | 'preempted' | 'max-time') {
    super(reason === 'aborted' ? 'Search cancelled' : reason === 'preempted' ? 'Search stopped to free its slot for a waiting search' : 'Search stopped after its time limit');
    this.name = 'SearchStoppedError';
  }
}

export interface SearchCacheSettings {
  /** How long a stored result answers repeats; 0 turns the cache off. */
  ttlMs: number;
  /** Results kept at most; the least recently used goes first. */
  entries: number;
}

export interface CachedSearch<Value> {
  value: Value;
  /** When the search that produced it finished (ms since the epoch). */
  storedAt: number;
}

/**
 * Finished searches, answered again from memory for a short while so a
 * repeat (an agent paging back, a retry after a deadline) costs no fetch,
 * no slot and no AI call. Keyed like runs, by manualSearchKey.
 */
export class SearchCache<Value> {
  private readonly entries = new Map<string, CachedSearch<Value> & { expiresAt: number }>();

  constructor(private readonly settings: SearchCacheSettings) {}

  get size() {
    return this.entries.size;
  }

  get(key: string): CachedSearch<Value> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-inserted on every hit, so Map order is least recently used first.
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return { value: entry.value, storedAt: entry.storedAt };
  }

  /** Stores a result for the TTL, or until `notAfter` (ms) when that is sooner. */
  set(key: string, value: Value, notAfter = Number.POSITIVE_INFINITY) {
    if (this.settings.ttlMs <= 0 || this.settings.entries <= 0) return;
    const storedAt = Date.now();
    const expiresAt = Math.min(storedAt + this.settings.ttlMs, notAfter);
    this.entries.delete(key);
    if (expiresAt <= storedAt) return;
    this.entries.set(key, { value, storedAt, expiresAt });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.settings.entries) break;
      this.entries.delete(oldest);
    }
  }
}

export interface SearchRunSettings {
  /** Runs at once; more wait in FIFO order. */
  slots: number;
  /** A caller's deadline when it names none, the queue included. */
  deadlineMs: number;
  /** The longest a run may hold a slot. */
  maxRunMs: number;
}

export interface SearchRunHandle<Part> {
  /** One finished part, shown to every caller still waiting now or joining later. */
  report(part: Part): void;
  /** Throws SearchStoppedError once the run has been stopped; call it before each phase. */
  checkpoint(): void;
  /** Whether the run has been stopped; its result may then be missing work. */
  readonly stopped: boolean;
}

export interface SearchCall<Part, Result> {
  /** Runs the search; only the call that starts a run executes it, joiners share its result. */
  execute: (run: SearchRunHandle<Part>) => Promise<Result>;
  /** Each finished part, once, while this caller waits. */
  onPart?: (part: Part) => void;
  /** This caller's deadline; the settings' default when omitted. */
  deadlineMs?: number;
  /** The caller went away (disconnected): it stops waiting, and a run nobody else wants stops. */
  signal?: AbortSignal;
  /** What this caller gets at its deadline from the parts finished by then. */
  partial: (parts: Part[]) => Result;
}

export interface SearchOutcome<Result> {
  result: Result;
  /** False when the deadline cut the search short. */
  complete: boolean;
}

interface Caller<Part> {
  onPart?: (part: Part) => void;
  state: 'waiting' | 'expired' | 'aborted' | 'done';
}

interface Run<Part, Result> {
  key: string;
  parts: Part[];
  callers: Set<Caller<Part>>;
  controller: AbortController;
  /** Settles with the search; rejects with SearchQueueTimeoutError when dropped from the queue. */
  result: Promise<Result>;
  holdsSlot: boolean;
  settled: boolean;
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

  search(key: string, call: SearchCall<Part, Result>): Promise<SearchOutcome<Result>> {
    if (call.signal?.aborted) return Promise.reject(new SearchStoppedError('aborted'));
    const deadlineAt = Date.now() + (call.deadlineMs ?? this.settings.deadlineMs);
    const run = this.inFlight.get(key) ?? this.start(key, call.execute);
    const caller: Caller<Part> = { onPart: call.onPart, state: 'waiting' };
    run.callers.add(caller);
    for (const part of run.parts) caller.onPart?.(part);
    return new Promise<SearchOutcome<Result>>((resolve, reject) => {
      const leave = (state: Caller<Part>['state'], answer: () => void) => {
        if (caller.state !== 'waiting') return;
        caller.state = state;
        clearTimeout(timer);
        call.signal?.removeEventListener('abort', onAbort);
        answer();
        this.callerLeft(run);
      };
      const onAbort = () => leave('aborted', () => reject(new SearchStoppedError('aborted')));
      const timer = setTimeout(() => leave('expired', () => {
        if (run.holdsSlot) resolve({ result: call.partial([...run.parts]), complete: false });
        else reject(new SearchQueueTimeoutError());
      }), Math.max(0, deadlineAt - Date.now()));
      call.signal?.addEventListener('abort', onAbort, { once: true });
      run.result.then(
        (result) => leave('done', () => resolve({ result, complete: true })),
        (error) => leave('done', () => reject(error)),
      );
    });
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
      controller: new AbortController(),
      holdsSlot: false,
      settled: false,
      grant: () => { run.holdsSlot = true; this.running.add(run); grant(); },
      drop,
      result: started as unknown as Promise<Result>,
    };
    const handle: SearchRunHandle<Part> = {
      report: (part) => {
        run.parts.push(part);
        for (const caller of run.callers) if (caller.state === 'waiting') caller.onPart?.(part);
      },
      checkpoint: () => {
        if (run.controller.signal.aborted) throw run.controller.signal.reason instanceof Error ? run.controller.signal.reason : new SearchStoppedError('aborted');
      },
      get stopped() { return run.controller.signal.aborted; },
    };
    run.result = (async () => {
      let limit: ReturnType<typeof setTimeout> | undefined;
      try {
        await started;
        limit = setTimeout(() => this.stop(run, 'max-time'), this.settings.maxRunMs);
        limit.unref?.();
        return await searchScope.run({ signal: run.controller.signal }, () => execute(handle));
      } finally {
        clearTimeout(limit);
        run.settled = true;
        this.release(run);
      }
    })();
    // A dropped run's rejection reaches only the callers still waiting on it.
    run.result.catch(() => {});
    this.inFlight.set(key, run);
    if (this.running.size < this.settings.slots) run.grant();
    else {
      this.queued.push(run);
      this.preemptOrphans();
    }
    return run;
  }

  /** A caller stopped waiting: a run nobody waits on leaves the queue, stops, or becomes an orphan. */
  private callerLeft(run: Run<Part, Result>) {
    const states = [...run.callers].map((caller) => caller.state);
    if (run.settled || states.includes('waiting')) return;
    if (!run.holdsSlot) {
      const index = this.queued.indexOf(run);
      if (index >= 0) this.queued.splice(index, 1);
      this.forget(run);
      run.drop();
      return;
    }
    if (states.every((state) => state === 'aborted')) {
      this.stop(run, 'aborted');
      return;
    }
    // Expired callers may repeat the search, so the run keeps going unless
    // a queued search needs the slot.
    this.preemptOrphans();
  }

  /** Frees slots held by runs no caller waits on, while a queued search needs one. */
  private preemptOrphans() {
    while (this.queued.length) {
      const orphan = [...this.running].find((run) => ![...run.callers].some((caller) => caller.state === 'waiting'));
      if (!orphan) return;
      this.stop(orphan, 'preempted');
      if (this.running.has(orphan)) return;
    }
  }

  /** Stops a run where it next checks in and frees its slot at once; its queued requests are dropped. */
  private stop(run: Run<Part, Result>, reason: SearchStoppedError['reason']) {
    if (run.settled || run.controller.signal.aborted) return;
    run.controller.abort(new SearchStoppedError(reason));
    this.forget(run);
    this.release(run);
  }

  private forget(run: Run<Part, Result>) {
    if (this.inFlight.get(run.key) === run) this.inFlight.delete(run.key);
  }

  private release(run: Run<Part, Result>) {
    this.forget(run);
    if (!this.running.delete(run)) return;
    this.queued.shift()?.grant();
  }
}
