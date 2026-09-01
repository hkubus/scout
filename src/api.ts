import type { ConnectorRun, DashboardData, ListingAction, ListingDetail, ListingDecision, LogEntry, ManualSearchResponse, MarketListingSnapshot, MarketResearchData, MarketWatch, MarketWatchInput, Marketplace, NegotiationDraft, NegotiationRecommendation, NegotiationResult, NotificationPriority, NotificationRecord, SearchFilters, SellerMessage, SettingsData, Watch, WatchAnalytics } from './types';

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

  const existing = inFlightGets.get(path);
  if (existing) return init?.signal ? abortable(existing as Promise<T>, init.signal) : existing as Promise<T>;

  // Keep the shared transport independent from any one component's abort signal.
  // Each caller still gets an abortable view of the same response below.
  const pending = fetchJson<T>(path);
  inFlightGets.set(path, pending);
  const clear = () => {
    if (inFlightGets.get(path) === pending) inFlightGets.delete(path);
  };
  pending.then(clear, clear);
  return init?.signal ? abortable(pending, init.signal) : pending;
}

const json = (method: string, body?: unknown): RequestInit => body === undefined
  ? { method }
  : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

export const api = {
  dashboard: (signal?: AbortSignal) => request<DashboardData>('/api/dashboard', { signal }),
  listings: (options: { page?: number; pageSize?: number; marketplace?: Marketplace; q?: string; watchId?: string } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    if (options.marketplace) params.set('marketplace', options.marketplace);
    if (options.q) params.set('q', options.q);
    if (options.watchId) params.set('watchId', options.watchId);
    return request<{ listings: DashboardData['listings']; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/listings${params.toString() ? `?${params}` : ''}`, { signal });
  },
  watches: (includeArchived = false) => request<{ watches: Watch[] }>(`/api/watches?includeArchived=${includeArchived ? 'true' : 'false'}`),
  watchAnalytics: (id: string, days = 30) => request<WatchAnalytics>(`/api/watches/${encodeURIComponent(id)}/analytics?days=${days}`),
  createWatch: (watch: Watch) => request<{ watch: Watch }>('/api/watches', json('POST', watch)),
  updateWatch: (id: string, patch: Partial<Pick<Watch, 'name' | 'query' | 'terms' | 'excluded' | 'sources' | 'location' | 'condition' | 'interval' | 'exactUrls' | 'sensitivity' | 'shippingOnly' | 'aiRelevance' | 'minPrice' | 'maxPrice' | 'enabled'>> & { archived?: boolean }) => request<{ ok: true }>(`/api/watches/${encodeURIComponent(id)}`, json('PATCH', patch)),
  search: (filters: SearchFilters) => request<ManualSearchResponse>('/api/search', json('POST', filters), 60_000),
  marketResearch: (options: { page?: number; pageSize?: number; watchId?: string; status?: 'active' | 'ended' | 'superseded' } = {}) => {
    const params = new URLSearchParams();
    if (options.page !== undefined) params.set('page', String(options.page));
    if (options.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
    if (options.watchId) params.set('watchId', options.watchId);
    if (options.status) params.set('status', options.status);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<MarketResearchData>(`/api/market-watches${suffix}`);
  },
  createMarketWatch: (watch: MarketWatchInput) => request<{ watch: MarketWatch }>('/api/market-watches', json('POST', watch)),
  updateMarketWatch: (id: string, patch: Partial<Pick<MarketWatch, 'name' | 'query' | 'enabled' | 'intervalHours' | 'terms' | 'excluded' | 'location' | 'condition' | 'sources' | 'minPrice' | 'maxPrice' | 'shippingOnly'>>) => request<{ ok: true }>(`/api/market-watches/${encodeURIComponent(id)}`, json('PATCH', patch)),
  deleteMarketWatch: (id: string) => request<{ ok: true }>(`/api/market-watches/${encodeURIComponent(id)}`, json('DELETE')),
  scanMarketWatch: (id: string) => request<{ queued: boolean; message: string }>(`/api/market-watches/${encodeURIComponent(id)}/scan`, { method: 'POST' }),
  marketListingSnapshot: (id: number) => request<{ snapshot: MarketListingSnapshot | null }>(`/api/market-listings/${id}/snapshot`),
  captureMarketListingSnapshot: (id: number) => request<{ snapshot: MarketListingSnapshot | null }>(`/api/market-listings/${id}/snapshot`, { method: 'POST' }, 60_000),
  marketSnapshotImageUrl: (imageId: number) => `/api/market-snapshot-images/${imageId}`,
  deleteWatch: (id: string) => request<{ ok: true }>(`/api/watches/${encodeURIComponent(id)}`, json('DELETE')),
  listingDetail: (key: string, watchId?: string | null) => request<ListingDetail>(`/api/listing-detail?key=${encodeURIComponent(key)}${watchId ? `&watchId=${encodeURIComponent(watchId)}` : ''}`),
  normalizeListing: (key: string, force = false) => request<ListingDetail>('/api/ai/normalize-listing', json('POST', { key, force })),
  recommendNegotiation: (key: string, input: { maxTotalCost: number | null; shippingCost?: number; otherCosts?: number }) => request<NegotiationRecommendation>('/api/negotiation/recommendation', json('POST', { key, ...input })),
  draftNegotiation: (key: string, offerPrice: number | null = null, budget?: { maxTotalCost: number; shippingCost?: number; otherCosts?: number }) => request<NegotiationDraft>('/api/ai/negotiate/draft', json('POST', { key, offerPrice, ...budget })),
  negotiateAndSend: (key: string, offerPrice: number | null = null, budget?: { maxTotalCost: number; shippingCost?: number; otherCosts?: number }, message?: string) => request<NegotiationResult>('/api/ai/negotiate', json('POST', { key, offerPrice, message, ...budget })),
  messages: (options: { page?: number; pageSize?: number } = {}) => request<{ messages: SellerMessage[]; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/messages?page=${options.page ?? 1}&pageSize=${options.pageSize ?? 100}`),
  listingAction: (key: string) => request<ListingAction>(`/api/listing-actions?key=${encodeURIComponent(key)}`),
  updateListingAction: (key: string, action: { decision: ListingDecision | null; note: string }) => request<{ action: ListingAction }>('/api/listing-actions', json('PATCH', { key, ...action })),
  scan: (watchId?: string) => request<{ queued: boolean; message: string }>('/api/scans', json('POST', watchId ? { watchId } : {})),
  settings: () => request<SettingsData>('/api/settings'),
  saveSettings: (settings: { interval: number; nightInterval?: number; webhook?: string; clearWebhook?: boolean; discordMinimumPriority?: NotificationPriority; dailyDigest?: { enabled?: boolean; time?: string; discord?: boolean; ntfy?: boolean }; clearNtfy?: boolean; ntfy?: { serverUrl?: string; topic?: string; token?: string; minimumPriority?: NotificationPriority }; ai?: { apiKey?: string; clearApiKey?: boolean; model?: string }; autoNegotiation?: { enabled?: boolean; maxTotalCost?: number | null; shippingCost?: number; otherCosts?: number; minimumDiscountPercent?: number; openingDiscountPercent?: number; dailyLimit?: number } }) => request<SettingsData>('/api/settings', json('PATCH', settings)),
  saveMarketplaceSession: (marketplace: Marketplace, label: string, storageState: unknown) => request<SettingsData>(`/api/marketplace-sessions/${encodeURIComponent(marketplace)}`, json('PUT', { label, storageState })),
  deleteMarketplaceSession: (marketplace: Marketplace) => request<SettingsData>(`/api/marketplace-sessions/${encodeURIComponent(marketplace)}`, json('DELETE')),
  testWebhook: () => request<{ delivered: boolean }>('/api/settings/webhook/test', { method: 'POST' }),
  testNtfy: () => request<{ delivered: boolean }>('/api/settings/ntfy/test', { method: 'POST' }),
  notifications: (options: { page?: number; pageSize?: number } = {}) => request<{ notifications: NotificationRecord[]; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/notifications?page=${options.page ?? 1}&pageSize=${options.pageSize ?? 100}`),
  connectorRuns: (options: { page?: number; pageSize?: number } = {}) => request<{ runs: ConnectorRun[]; pagination: { page: number; pageSize: number; total: number; hasNext: boolean } }>(`/api/connector-runs?page=${options.page ?? 1}&pageSize=${options.pageSize ?? 100}`),
  logs: () => request<{ logs: LogEntry[] }>('/api/logs'),
  exportData: () => request<Record<string, unknown>>('/api/export'),
  backup: () => request<{ backup: string; message: string }>('/api/backup', { method: 'POST' }),
};
