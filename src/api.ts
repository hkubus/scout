import type { AnalyticsData, ConnectorRun, DashboardData, ListingAction, ListingDetail, ListingDecision, LogEntry, ManualSearchResponse, MarketListingSnapshot, MarketResearchData, MarketWatch, MarketWatchInput, MarketWatchTrend, Marketplace, NotificationPriority, NotificationRecord, PriceHistoryPoint, SearchFilters, SettingsData, VerificationComparison, Watch, WatchAnalytics } from './types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const inFlightGets = new Map<string, Promise<unknown>>();

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

async function fetchJson<T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(new ApiError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, 0)),
    timeoutMs,
  );
  const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
  try {
    const response = await fetch(path, { ...init, signal });
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status);
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const canDedupe = (init?.method ?? 'GET').toUpperCase() === 'GET';
  if (!canDedupe) return fetchJson<T>(path, init, timeoutMs);
  const dedupeKey = `${path}::${timeoutMs ?? 20_000}`;

  const existing = inFlightGets.get(dedupeKey);
  if (existing) return init?.signal ? abortable(existing as Promise<T>, init.signal) : existing as Promise<T>;

  // Keep the shared transport independent from any one component's abort signal.
  // Each caller still gets an abortable view of the same response below.
  const pending = fetchJson<T>(path, undefined, timeoutMs);
  inFlightGets.set(dedupeKey, pending);
  const clear = () => {
    if (inFlightGets.get(dedupeKey) === pending) inFlightGets.delete(dedupeKey);
  };
  pending.then(clear, clear);
  return init?.signal ? abortable(pending, init.signal) : pending;
}

const json = (method: string, body?: unknown): RequestInit => body === undefined
  ? { method }
  : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

export const api = {
  dashboard: (signal?: AbortSignal) => request<DashboardData>('/api/dashboard', { signal }),
  listings: (options: { page?: number; pageSize?: number; marketplace?: Marketplace; q?: string; watchId?: string; sort?: 'newest' | 'strongest' | 'price'; decision?: ListingDecision; visibility?: 'visible' | 'hidden' | 'all' } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    if (options.marketplace) params.set('marketplace', options.marketplace);
    if (options.q) params.set('q', options.q);
    if (options.watchId) params.set('watchId', options.watchId);
    if (options.sort) params.set('sort', options.sort);
    if (options.decision) params.set('decision', options.decision);
    if (options.visibility) params.set('visibility', options.visibility);
    return request<{ listings: DashboardData['listings']; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/listings${params.toString() ? `?${params}` : ''}`, { signal });
  },
  watches: (includeArchived = false, signal?: AbortSignal) => request<{ watches: Watch[] }>(`/api/watches?includeArchived=${includeArchived ? 'true' : 'false'}`, { signal }),
  watchAnalytics: (id: string, days = 30, signal?: AbortSignal) => request<WatchAnalytics>(`/api/watches/${encodeURIComponent(id)}/analytics?days=${days}`, { signal }),
  analytics: (options: { days?: number; watchId?: string; marketplace?: Marketplace } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    params.set('days', String(options.days ?? 30));
    if (options.watchId) params.set('watchId', options.watchId);
    if (options.marketplace) params.set('marketplace', options.marketplace);
    return request<AnalyticsData>(`/api/analytics?${params}`, { signal });
  },
  createWatch: (watch: Omit<Watch, 'id'> & { id?: string }) => request<{ watch: Watch }>('/api/watches', json('POST', watch)),
  updateWatch: (id: string, patch: Partial<Pick<Watch, 'name' | 'query' | 'terms' | 'excluded' | 'sources' | 'location' | 'condition' | 'interval' | 'sourceIntervals' | 'exactUrls' | 'sensitivity' | 'shippingOnly' | 'aiRelevance' | 'typoVariants' | 'variantGroups' | 'referenceMarketWatchId' | 'minPrice' | 'maxPrice' | 'enabled'>> & { archived?: boolean }) => request<{ ok: true }>(`/api/watches/${encodeURIComponent(id)}`, json('PATCH', patch)),
  search: (filters: SearchFilters, signal?: AbortSignal) => request<ManualSearchResponse>('/api/search', { ...json('POST', filters), signal }, 90_000),
  marketResearch: (options: { page?: number; pageSize?: number; watchId?: string; status?: 'active' | 'ended' | 'superseded' } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    if (options.watchId) params.set('watchId', options.watchId);
    if (options.status) params.set('status', options.status);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<MarketResearchData>(`/api/market-watches${suffix}`, { signal });
  },
  createMarketWatch: (watch: MarketWatchInput) => request<{ watch: MarketWatch }>('/api/market-watches', json('POST', watch)),
  updateMarketWatch: (id: string, patch: Partial<Pick<MarketWatch, 'name' | 'query' | 'enabled' | 'intervalHours' | 'terms' | 'excluded' | 'location' | 'condition' | 'sources' | 'minPrice' | 'maxPrice' | 'shippingOnly' | 'typoVariants'>>) => request<{ ok: true }>(`/api/market-watches/${encodeURIComponent(id)}`, json('PATCH', patch)),
  deleteMarketWatch: (id: string) => request<{ ok: true }>(`/api/market-watches/${encodeURIComponent(id)}`, json('DELETE')),
  scanMarketWatch: (id: string) => request<{ queued: boolean; message: string }>(`/api/market-watches/${encodeURIComponent(id)}/scan`, { method: 'POST' }),
  marketWatchTrend: (id: string, days = 90, signal?: AbortSignal) => request<MarketWatchTrend>(`/api/market-watches/${encodeURIComponent(id)}/trend?days=${days}`, { signal }),
  marketListingSnapshot: (id: number, signal?: AbortSignal) => request<{ snapshot: MarketListingSnapshot | null }>(`/api/market-listings/${id}/snapshot`, { signal }),
  marketListingHistory: (id: number, signal?: AbortSignal) => request<{ points: PriceHistoryPoint[] }>(`/api/market-listings/${id}/history`, { signal }),
  captureMarketListingSnapshot: (id: number) => request<{ snapshot: MarketListingSnapshot | null }>(`/api/market-listings/${id}/snapshot`, { method: 'POST' }, 60_000),
  marketSnapshotImageUrl: (imageId: number) => `/api/market-snapshot-images/${imageId}`,
  deleteWatch: (id: string) => request<{ ok: true }>(`/api/watches/${encodeURIComponent(id)}`, json('DELETE')),
  listingDetail: (key: string, watchId?: string | null) => request<ListingDetail>(`/api/listing-detail?key=${encodeURIComponent(key)}${watchId ? `&watchId=${encodeURIComponent(watchId)}` : ''}`),
  compareVerification: (key: string) => request<VerificationComparison>('/api/ai/compare-verification', json('POST', { key }), 60_000),
  listingAction: (key: string) => request<ListingAction>(`/api/listing-actions?key=${encodeURIComponent(key)}`),
  setListingVariant: (key: string, watchId: string, variantId: string | null) => request<ListingDetail>('/api/listing-variant', json('PUT', { key, watchId, variantId })),
  updateListingAction: (key: string, action: { decision: ListingDecision | null; note: string; hidden?: boolean }) => request<{ action: ListingAction }>('/api/listing-actions', json('PATCH', { key, ...action })),
  scan: (watchId?: string) => request<{ queued: boolean; message: string }>('/api/scans', json('POST', watchId ? { watchId } : {})),
  settings: () => request<SettingsData>('/api/settings'),
  saveSettings: (settings: { interval: number; nightInterval?: number; webhook?: string; clearWebhook?: boolean; discordMinimumPriority?: NotificationPriority; dailyDigest?: { enabled?: boolean; time?: string; discord?: boolean; ntfy?: boolean }; clearNtfy?: boolean; ntfy?: { serverUrl?: string; topic?: string; token?: string; minimumPriority?: NotificationPriority }; ai?: { apiKey?: string; clearApiKey?: boolean; model?: string } }) => request<SettingsData>('/api/settings', json('PATCH', settings)),
  saveMarketplaceSession: (marketplace: Marketplace, label: string, storageState: unknown) => request<SettingsData>(`/api/marketplace-sessions/${encodeURIComponent(marketplace)}`, json('PUT', { label, storageState })),
  deleteMarketplaceSession: (marketplace: Marketplace) => request<SettingsData>(`/api/marketplace-sessions/${encodeURIComponent(marketplace)}`, json('DELETE')),
  testWebhook: () => request<{ delivered: boolean }>('/api/settings/webhook/test', { method: 'POST' }),
  testNtfy: () => request<{ delivered: boolean }>('/api/settings/ntfy/test', { method: 'POST' }),
  resetAiResults: () => request<{ ok: true; cleared: { relevance: number; shadowLog: number; detailSnapshots: number; verification: number } }>('/api/settings/ai/reset', { method: 'POST' }, 60_000),
  notifications: (options: { page?: number; pageSize?: number } = {}, signal?: AbortSignal) => request<{ notifications: NotificationRecord[]; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/notifications?page=${options.page ?? 1}&pageSize=${options.pageSize ?? 100}`, { signal }),
  connectorRuns: (options: { page?: number; pageSize?: number } = {}, signal?: AbortSignal) => request<{ runs: ConnectorRun[]; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/connector-runs?page=${options.page ?? 1}&pageSize=${options.pageSize ?? 100}`, { signal }),
  logs: (signal?: AbortSignal) => request<{ logs: LogEntry[] }>('/api/logs', { signal }),
  exportData: () => request<Record<string, unknown>>('/api/export'),
  backup: () => request<{ backup: string; message: string }>('/api/backup', { method: 'POST' }),
  systemUpdate: () => request<{ ok: true; message: string; steps: { command: string; success: boolean; output: string }[] }>('/api/system/update', { method: 'POST' }, 360_000),
};
