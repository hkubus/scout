export type Theme = 'light' | 'dark' | 'system';
export type View = 'overview' | 'search' | 'watches' | 'market-research' | 'analytics' | 'listings' | 'connectors' | 'logs' | 'settings';
export type Marketplace = 'OLX' | 'Allegro Lokalnie' | 'Vinted';
export type DealLabel = 'Exceptional' | 'Very strong' | 'Strong' | 'Watch';
export type NotificationPriority = 'strong' | 'very-strong' | 'exceptional';
export type ListingDecision = 'buy' | 'watch' | 'pass';

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
  /** Where the displayed typical comes from: the watch's own history or a reference research series band. */
  typicalSource?: 'own-history' | 'reference-band' | null;
  belowTypical: number | null;
  observed: string;
  observedAt: string;
  dealStrength: number;
  dealLabel: DealLabel;
  image: string;
  url: string;
  watch: string;
  /** Model group the listing is scored in; null when its grouped watch matched no group, absent for ungrouped watches. */
  group?: string | null;
  groupKey?: string | null;
  /** How the group was chosen: the watch's rules, a Jev fallback pick, or a manual override. */
  groupSource?: 'rule' | 'jev' | 'manual' | null;
  condition?: string;
  location?: string;
  shippingAvailable: boolean | null;
  priceNegotiable?: boolean | null;
  listingId?: string;
  decision?: ListingDecision | null;
  note?: string;
  /** True when the listing was manually hidden by the user. Hidden rows stay stored but are removed from the overview and alerting. */
  hidden?: boolean;
  /** True when the watch's AI relevance filter classified this listing as irrelevant. Shown greyed-out on overview. */
  aiFiltered?: boolean;
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
  hidden: boolean;
  updatedAt?: string | null;
}

export interface ListingDetail {
  listing: Listing;
  history: PriceHistoryPoint[];
  action: ListingAction;
  descriptionSnapshot?: ListingDetailSnapshot | null;
  firstSeenAt: string;
  lastSeenAt: string;
  verificationTrace?: VerificationTraceEntry[] | null;
  verificationInputHash?: string | null;
  verificationModel?: string | null;
  /** The owning watch's model groups, for reassigning the listing; absent for ungrouped watches. */
  groups?: WatchGroup[];
}

export interface VerificationTraceEntry {
  id: number;
  createdAt: string;
  inputHash: string;
  jevModel: string;
  jevAnswer: unknown | null;
  jevConfidence: number | null;
  jevUnsure: boolean;
  jevError: string | null;
  deepseekDecision: string | null;
  agreement: boolean | null;
  visionVerdict: string | null;
  visionConfidence: number | null;
  visionImagesSeen: number | null;
  visionError: string | null;
  note: string | null;
}

export interface VerificationComparison {
  key: string;
  inputHash: string;
  jevModel: string;
  llmModel: string;
  jev: { ok: true; judgment: { decision: string; confidence: number | null; unsure: boolean }; raw: unknown } | { ok: false; error: string };
  llm: { ok: true; verification: ListingDescriptionVerification; raw: unknown } | { ok: false; error: string };
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
  referenceMarketWatchId: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  archivedAt?: string | null;
  /** Model groups; when present each listing is scored against its own group's typical price. */
  groups: WatchGroup[];
  /** Per-group baseline progress, present only for grouped watches. */
  groupStats?: WatchGroupStats[];
  /** Grouped watches only: comparable listings that matched no group and are not scored. */
  unassignedSamples?: number;
}

export interface WatchGroupStats {
  key: string;
  name: string;
  samples: number;
  targetSamples: number;
  /** Group median, shown once the group has its own sample floor. */
  typical: number | null;
  /** Scored and able to alert: group floor, pooled floor, and observation window all met. */
  ready: boolean;
}

/**
 * One model group of a watch. `terms` are comma-separated and must all appear
 * in the title as whole words; `|` separates alternatives within a term
 * (e.g. `pro max|promax`). `excluded` uses the same syntax. The most specific
 * matching group wins.
 */
export interface WatchGroup {
  key: string;
  name: string;
  terms: string;
  excluded: string;
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

export interface AnalyticsDiscountBucket {
  label: string;
  count: number;
}

export interface AnalyticsTrendPoint {
  date: string;
  medianPrice: number | null;
  lowerPrice: number | null;
  upperPrice: number | null;
  listingCount: number;
  strongDealCount: number;
}

export interface AnalyticsWatchLeaderboardRow {
  watchId: string;
  watchName: string;
  listings: number;
  strongDeals: number;
  medianDiscountPercent: number | null;
  lastSeenAt: string | null;
}

export interface AnalyticsMarketplaceDeals {
  marketplace: Marketplace;
  listings: number;
  strongDeals: number;
  medianDiscountPercent: number | null;
}

/**
 * A daily-deduped observation, one per (day, watch, listing). Aggregate deals
 * metrics live on the asking price versus the learned baseline; discount is
 * derived, never a confirmed sale.
 */
export interface AnalyticsMarketplaceRow extends AnalyticsMarketplaceDeals {
  scanRuns: number;
  scanSuccessRate: number | null;
  averageLatencyMs: number | null;
}

export interface AnalyticsOverview {
  trackedListings: number;
  newListings: number;
  strongDeals: number;
  medianDiscountPercent: number | null;
  scanRuns: number;
  scanSuccessRate: number | null;
}

export interface AnalyticsTriage {
  buy: number;
  watch: number;
  pass: number;
  none: number;
}

export interface AnalyticsAiQuality {
  relevanceJudged: number;
  relevancePassRate: number | null;
  shadowJudged: number;
  shadowAgreementRate: number | null;
}

export interface AnalyticsData {
  rangeDays: number;
  watchId: string | null;
  marketplace: Marketplace | null;
  generatedAt: string;
  overview: AnalyticsOverview;
  trend: AnalyticsTrendPoint[];
  discountDistribution: AnalyticsDiscountBucket[];
  watchLeaderboard: AnalyticsWatchLeaderboardRow[];
  marketplaceComparison: AnalyticsMarketplaceRow[];
  triage: AnalyticsTriage;
  aiQuality: AnalyticsAiQuality;
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

/** Probable-sale estimate band — never a confirmed/completed-sale price. */
export interface SaleBand {
  p25: number | null;
  median: number | null;
  p75: number | null;
  sampleCount: number;
  eligibleCount: number;
  excludedStale: number;
  windowDays: number;
  computedAt: string;
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
  saleBand: SaleBand | null;
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

export interface MarketWatchTrendPoint {
  date: string;
  medianPrice: number | null;
  lowerPrice: number | null;
  upperPrice: number | null;
  listingCount: number;
}

export interface MarketWatchTrend {
  marketWatchId: string;
  watchName: string;
  rangeDays: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  totalObservations: number;
  probableSaleMedian: number | null;
  points: MarketWatchTrendPoint[];
}

export interface MarketResearchData {
  watches: MarketWatch[];
  listings: MarketTrackedListing[];
  aggregates?: {
    overallMedianPrice: number | null;
    endedCount: number;
    activeCount: number;
    saleBand?: SaleBand | null;
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
  scope: 'watch' | 'research' | 'diagnostics';
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
