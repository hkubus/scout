export type Theme = 'light' | 'dark' | 'system';
export type View = 'overview' | 'search' | 'watches' | 'market-research' | 'listings' | 'connectors' | 'settings';
export type Marketplace = 'OLX' | 'Allegro Lokalnie' | 'Vinted';
export type DealLabel = 'Exceptional' | 'Very strong' | 'Strong' | 'Watch';

export interface Listing {
  id: string;
  title: string;
  subtitle: string;
  marketplace: Marketplace;
  price: number;
  typical: number | null;
  belowTypical: number | null;
  observed: string;
  observedAt: string;
  dealStrength: number;
  dealLabel: DealLabel;
  image: string;
  url: string;
  watch: string;
  condition?: string;
  location?: string;
  shippingAvailable: boolean | null;
}

export interface Watch {
  id: string;
  name: string;
  query: string;
  terms: string;
  excluded: string;
  sources: Marketplace[];
  location: string;
  condition: string;
  samples: number;
  targetSamples: number;
  observationHours: number;
  readiness: number;
  status: 'Learning' | 'Ready' | 'Paused';
  interval: number;
  nextScan: string;
  enabled: boolean;
  exactUrls: string[];
  sensitivity: number;
  shippingOnly: boolean;
  minPrice: number | null;
  maxPrice: number | null;
}

export interface SearchFilters {
  query: string;
  terms?: string;
  excluded?: string;
  sources: Marketplace[];
  minPrice?: number | null;
  maxPrice?: number | null;
  shippingOnly?: boolean;
  condition?: string;
  location?: string;
}

export interface SearchSourceStatus {
  source: Marketplace;
  status: 'ok' | 'error';
  count: number;
  pendingShipping: number;
  durationMs: number;
  message: string;
}

export interface ManualSearchResponse {
  listings: Listing[];
  sources: SearchSourceStatus[];
}

export interface MarketWatch {
  id: string;
  name: string;
  query: string;
  terms: string;
  excluded: string;
  location: string;
  condition: string;
  sources: Marketplace[];
  intervalHours: number;
  minPrice: number | null;
  maxPrice: number | null;
  shippingOnly: boolean;
  enabled: boolean;
  nextScan: string;
  lastScan: string;
  totalListings: number;
  activeListings: number;
  endedListings: number;
  estimatedMedianPrice: number | null;
}

export type MarketWatchInput = Pick<MarketWatch, 'name' | 'query' | 'terms' | 'excluded' | 'location' | 'condition' | 'sources' | 'intervalHours' | 'minPrice' | 'maxPrice' | 'shippingOnly'>;

export interface MarketTrackedListing {
  id: number;
  marketWatchId: string;
  watchName: string;
  marketplace: Marketplace;
  listingId: string;
  title: string;
  url: string;
  image: string;
  firstPrice: number;
  lastPrice: number;
  lowestPrice: number;
  priceChangePercent: number;
  firstSeenAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  status: 'active' | 'ended';
  missingScans: number;
  observations: number;
}

export interface MarketResearchData {
  watches: MarketWatch[];
  listings: MarketTrackedListing[];
}

export interface Connector {
  name: Marketplace | 'Discord';
  kind: 'marketplace' | 'discord';
  status: 'OK' | 'Warning' | 'Degraded' | 'Idle';
  detail: string;
  lastSuccess: string;
  color: string;
  requests: number;
  latency: string;
}

export interface DashboardStats {
  watching: number;
  newToday: number;
  strongDeals: number;
}

export interface ConnectorRun {
  id: number;
  source: string;
  status: string;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
  duration: string;
}

export interface NotificationRecord {
  id: number;
  title: string;
  reason: string;
  observedAt: string;
  status: string;
}

export interface SettingsData {
  defaultInterval: number;
  webhookConfigured: boolean;
  webhookMasked: string | null;
  publicExposureWarning: boolean;
  marketplaceSessions: MarketplaceSession[];
}

export interface MarketplaceSession {
  marketplace: Marketplace;
  label: string;
  connected: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  detail: string;
}

export interface DashboardData {
  listings: Listing[];
  watches: Watch[];
  connectors: Connector[];
  stats: DashboardStats;
  lastScan: string;
  lastScanTime: string;
}
