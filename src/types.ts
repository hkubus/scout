export type Theme = 'light' | 'dark' | 'system';
export type View = 'overview' | 'search' | 'watches' | 'market-research' | 'listings' | 'messages' | 'connectors' | 'logs' | 'settings';
export type Marketplace = 'OLX' | 'Allegro Lokalnie' | 'Vinted';
export type DealLabel = 'Exceptional' | 'Very strong' | 'Strong' | 'Watch';
export type NotificationPriority = 'strong' | 'very-strong' | 'exceptional';
export type ListingDecision = 'buy' | 'watch' | 'pass';

export type ListingNormalizationCondition = 'new' | 'like-new' | 'very-good' | 'good' | 'acceptable' | 'for-parts' | 'unknown';

export interface ListingNormalizationAttribute {
  name: string;
  value: string;
}

export interface ListingNormalization {
  canonicalTitle: string;
  category: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  attributes: ListingNormalizationAttribute[];
  condition: ListingNormalizationCondition;
  conditionNotes: string[];
  flags: string[];
  confidence: number;
  evidence: string[];
}

export type ListingDescriptionVerificationDecision = 'pass' | 'reject' | 'unknown';
export type ListingDescriptionVerificationStatus = ListingDescriptionVerificationDecision | 'pending' | 'not-configured' | 'fallback';

export interface ListingDescriptionVerification {
  decision: ListingDescriptionVerificationDecision;
  confidence: number;
  summary: string;
  issues: string[];
  evidence: string[];
}

export interface ListingDetailSnapshot {
  title: string;
  price: number;
  condition?: string | null;
  location?: string | null;
  url: string;
  description: string | null;
  capturedAt: string;
  verificationStatus?: ListingDescriptionVerificationStatus | null;
}

export interface Listing {
  id: string;
  /** Global marketplace identity, safe for external links and triage actions. */
  marketplaceListingKey?: string;
  /** Watch-specific identity used by the UI and detail requests. */
  associationId?: string;
  watchId?: string | null;
  watchListingId?: number | null;
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
  priceNegotiable?: boolean | null;
  listingId?: string;
  decision?: ListingDecision | null;
  note?: string;
  aiNormalization?: ListingNormalization | null;
  aiNormalizationAt?: string | null;
  aiNormalizationError?: string | null;
  aiDescriptionVerification?: ListingDescriptionVerification | null;
  aiDescriptionVerificationAt?: string | null;
  aiDescriptionVerificationStatus?: ListingDescriptionVerificationStatus | null;
  aiDescriptionVerificationError?: string | null;
}

export interface PriceHistoryPoint {
  price: number;
  observedAt: string;
}

export interface ListingAction {
  decision: ListingDecision | null;
  note: string;
  updatedAt?: string | null;
}

export interface ListingDetail {
  listing: Listing;
  history: PriceHistoryPoint[];
  action: ListingAction;
  descriptionSnapshot?: ListingDetailSnapshot | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type SellerMessageStatus = 'sent' | 'failed';
export type SellerMessageSource = 'manual' | 'automatic';

export interface SellerMessage {
  id: number;
  marketplace: Marketplace;
  listingId: string;
  listingTitle: string;
  listingUrl: string;
  message: string;
  offerPrice: number | null;
  model: string;
  source: SellerMessageSource;
  status: SellerMessageStatus;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface NegotiationResult {
  message: SellerMessage;
}

export interface NegotiationDraft {
  message: string;
  model: string;
  askingPrice: number;
  offerPrice: number | null;
  marketplace: Marketplace;
  listingId: string;
  title: string;
}

export type NegotiationRecommendationStatus = 'ready' | 'budget-required' | 'not-negotiable' | 'manual-review' | 'budget-too-low' | 'no-room';

export interface NegotiationRecommendation {
  status: NegotiationRecommendationStatus;
  askingPrice: number;
  maxTotalCost: number | null;
  knownCosts: number;
  ceilingPrice: number | null;
  openingOffer: number | null;
  counterOffers: number[];
  openingDiscountPercent: number | null;
  rationale: string;
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
  status: 'Learning' | 'Ready' | 'Paused' | 'Archived';
  interval: number;
  nextScan: string;
  enabled: boolean;
  exactUrls: string[];
  sensitivity: number;
  shippingOnly: boolean;
  typoVariants: boolean;
  aiRelevance: boolean;
  minPrice: number | null;
  maxPrice: number | null;
  archivedAt?: string | null;
}

export interface WatchAnalyticsPoint {
  date: string;
  medianPrice: number | null;
  lowerPrice: number | null;
  upperPrice: number | null;
  listingCount: number;
}

export interface WatchAnalyticsSource {
  source: Marketplace;
  medianPrice: number | null;
  listingCount: number;
  strongDealCount: number;
}

export interface WatchAnalytics {
  watchId: string;
  watchName: string;
  rangeDays: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  totalObservations: number;
  current: {
    medianPrice: number | null;
    lowerPrice: number | null;
    upperPrice: number | null;
    minPrice: number | null;
    maxPrice: number | null;
    listingCount: number;
    strongDealCount: number;
    strongDealRate: number | null;
  };
  medianChangePercent: number | null;
  points: WatchAnalyticsPoint[];
  sources: WatchAnalyticsSource[];
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
  typoVariants: boolean;
  enabled: boolean;
  nextScan: string;
  lastScan: string;
  totalListings: number;
  activeListings: number;
  endedListings: number;
  estimatedMedianPrice: number | null;
  activeVersionId?: string | null;
}

export type MarketWatchInput = Pick<MarketWatch, 'name' | 'query' | 'terms' | 'excluded' | 'location' | 'condition' | 'sources' | 'intervalHours' | 'minPrice' | 'maxPrice' | 'shippingOnly' | 'typoVariants'>;

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
  status: 'active' | 'ended' | 'superseded';
  availabilityStatus?: 'live' | 'terminal' | 'unknown' | null;
  endedReason?: string | null;
  missingScans: number;
  observations: number;
  snapshotStatus?: 'pending' | 'saved' | 'failed' | null;
}

export interface MarketListingSnapshotImage {
  id: number;
  position: number;
  byteSize: number;
}

export interface MarketListingSnapshot {
  id: number;
  marketplace: Marketplace;
  listingId: string;
  title: string;
  price: number;
  condition: string | null;
  location: string | null;
  url: string;
  description: string | null;
  capturedAt: string;
  images: MarketListingSnapshotImage[];
}

export interface MarketResearchData {
  watches: MarketWatch[];
  listings: MarketTrackedListing[];
  aggregates?: {
    overallMedianPrice: number | null;
    endedCount: number;
    activeCount: number;
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    hasNext: boolean;
  };
}

export interface Connector {
  name: Marketplace | 'Discord' | 'ntfy';
  kind: 'marketplace' | 'discord' | 'ntfy';
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

export interface LogEntry {
  id: number;
  at: string;
  level: 'info' | 'error';
  scope: 'watch' | 'research';
  message: string;
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
  nightInterval: number;
  webhookConfigured: boolean;
  webhookMasked: string | null;
  discordMinimumPriority: NotificationPriority;
  dailyDigest: DailyDigestSettings;
  ntfy: NtfySettings;
  ai: AiSettings;
  autoNegotiation: AutoNegotiationSettings;
  publicExposureWarning: boolean;
  marketplaceSessions: MarketplaceSession[];
}

export interface DailyDigestSettings {
  enabled: boolean;
  time: string;
  discord: boolean;
  ntfy: boolean;
  lastSentAt: string | null;
}

export interface AiSettings {
  configured: boolean;
  model: string;
  source: 'settings' | 'environment' | 'none';
}

export interface AutoNegotiationSettings {
  enabled: boolean;
  maxTotalCost: number | null;
  shippingCost: number;
  otherCosts: number;
  minimumDiscountPercent: number;
  openingDiscountPercent: number;
  dailyLimit: number;
  sentToday: number;
  attemptedToday: number;
}

export interface NtfySettings {
  configured: boolean;
  serverUrl: string | null;
  topicMasked: string | null;
  tokenConfigured: boolean;
  minimumPriority: NotificationPriority;
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
