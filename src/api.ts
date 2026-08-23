import type { ConnectorRun, DashboardData, ManualSearchResponse, MarketResearchData, MarketWatch, MarketWatchInput, Marketplace, NotificationRecord, SearchFilters, SettingsData, Watch } from './types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status);
  return payload as T;
}

const json = (method: string, body?: unknown): RequestInit => body === undefined
  ? { method }
  : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

export const api = {
  dashboard: () => request<DashboardData>('/api/dashboard'),
  createWatch: (watch: Watch) => request<{ watch: Watch }>('/api/watches', json('POST', watch)),
  updateWatch: (id: string, patch: Partial<Pick<Watch, 'enabled' | 'interval' | 'shippingOnly' | 'minPrice' | 'maxPrice'>>) => request<{ ok: true }>(`/api/watches/${encodeURIComponent(id)}`, json('PATCH', patch)),
  search: (filters: SearchFilters) => request<ManualSearchResponse>('/api/search', json('POST', filters)),
  marketResearch: () => request<MarketResearchData>('/api/market-watches'),
  createMarketWatch: (watch: MarketWatchInput) => request<{ watch: MarketWatch }>('/api/market-watches', json('POST', watch)),
  updateMarketWatch: (id: string, patch: Partial<Pick<MarketWatch, 'name' | 'query' | 'enabled' | 'intervalHours' | 'terms' | 'excluded' | 'location' | 'condition' | 'sources' | 'minPrice' | 'maxPrice' | 'shippingOnly'>>) => request<{ ok: true }>(`/api/market-watches/${encodeURIComponent(id)}`, json('PATCH', patch)),
  deleteMarketWatch: (id: string) => request<{ ok: true }>(`/api/market-watches/${encodeURIComponent(id)}`, json('DELETE')),
  scanMarketWatch: (id: string) => request<{ queued: boolean; message: string }>(`/api/market-watches/${encodeURIComponent(id)}/scan`, { method: 'POST' }),
  deleteWatch: (id: string) => request<{ ok: true }>(`/api/watches/${encodeURIComponent(id)}`, json('DELETE')),
  scan: (watchId?: string) => request<{ queued: boolean; message: string }>('/api/scans', json('POST', watchId ? { watchId } : {})),
  settings: () => request<SettingsData>('/api/settings'),
  saveSettings: (settings: { interval: number; webhook?: string; clearWebhook?: boolean }) => request<SettingsData>('/api/settings', json('PATCH', settings)),
  saveMarketplaceSession: (marketplace: Marketplace, label: string, storageState: unknown) => request<SettingsData>(`/api/marketplace-sessions/${encodeURIComponent(marketplace)}`, json('PUT', { label, storageState })),
  deleteMarketplaceSession: (marketplace: Marketplace) => request<SettingsData>(`/api/marketplace-sessions/${encodeURIComponent(marketplace)}`, json('DELETE')),
  testWebhook: () => request<{ delivered: boolean }>('/api/settings/webhook/test', { method: 'POST' }),
  notifications: () => request<{ notifications: NotificationRecord[] }>('/api/notifications'),
  connectorRuns: () => request<{ runs: ConnectorRun[] }>('/api/connector-runs'),
};
