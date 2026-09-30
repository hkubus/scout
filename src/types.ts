export type Theme = 'light' | 'dark' | 'system';
export type View = 'overview' | 'search' | 'watches' | 'market-research' | 'analytics' | 'listings' | 'connectors' | 'logs' | 'settings';
export type Marketplace = 'OLX' | 'Allegro Lokalnie' | 'Vinted';
export type DealLabel = 'Exceptional' | 'Very strong' | 'Strong' | 'Watch';
export type NotificationPriority = 'strong' | 'very-strong' | 'exceptional';
export type ListingDecision = 'buy' | 'watch' | 'pass';

/**
 * One model bucket inside a watch. A watch searches broadly (e.g. "1660") and
 * these groups split the matches into separately scored products (1660,
 * 1660 Super, 1660 Ti), each with its own learned baseline and readiness.
 */
export interface VariantGroup {
  /** Stable identity; renaming the label must not reset the learned baseline. */
  id: string;
  label: string;
  /** Comma-separated terms; every term must be present in the listing title. */
  terms: string;
  /** Optional comma-separated terms that veto a match. */
  exclude?: string;
}

/** Groups proposed from a watch's saved listings; nothing is stored until the watch is saved. */
export interface VariantSuggestions {
  groups: VariantGroup[];
  /** Listings the proposal was drawn from. */
  listings: number;
  /** 'ai' when OpenRouter proposed them, 'titles' for the built-in title analysis. */
  method: 'ai' | 'titles';
}

/** Per-model progress shown on the watch card once variant groups exist. */
export interface WatchVariantStat {
  key: string;
  label: string;
  samples: number;
  targetSamples: number;
  observationHours: number;
  readiness: number;
  typical: number | null;
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

export type SellerType = 'private' | 'business';

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
  /** Model-variant bucket this listing scored against, when the watch groups variants. */
  variantKey?: string | null;
  variantLabel?: string | null;
  /** How the variant was chosen: the variant's term rules, a Jev fallback pick, or a manual override. */
  variantSource?: 'rule' | 'jev' | 'manual' | null;
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
  /** When Scout first saw the listing (for this watch). */
  firstSeenAt?: string | null;
  /** When the seller posted it, where the marketplace says (OLX). */
  postedAt?: string | null;
  /** The seller's latest refresh or paid bump (OLX). */
  refreshedAt?: string | null;
  /** Paid placement or highlight; null when unknown. */
  promoted?: boolean | null;
  /** From the marketplace's business-account flag; null when unknown. */
  sellerType?: SellerType | null;
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
  /** The owning watch's model variants, for reassigning the listing; absent for ungrouped watches. */
  variantGroups?: VariantGroup[];
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

/**
 * Current visible Strong+ findings for one watch, split by deal tier. Counts
 * are listings still seen within the feed freshness window, excluding rows the
 * watch filters out and any the user marked as hidden. All zeros means the
 * watch has no qualifying findings right now (or is still learning).
 */
export interface WatchDealCounts {
  exceptional: number;
  veryStrong: number;
  strong: number;
}

/**
 * An OLX category a watch or search is scoped to, picked from OLX's own facet
 * counts. `path` is OLX's slug path; only `id` is sent to OLX.
 */
export interface OlxCategory {
  id: number;
  label: string;
  path: string;
}

export interface OlxCategoryOption extends OlxCategory {
  /** OLX hits for the query in this category (includes subcategories). */
  count: number;
}

export interface Watch {
  id: string;
  name: string;
  query: string;
  terms: string;
  excluded: string;
  sources: Marketplace[];
  /** Always "Polska": Scout no longer filters by location; kept for older iOS builds. */
  location: string;
  condition: string;
  samples: number;
  targetSamples: number;
  observationHours: number;
  readiness: number;
  status: 'Learning' | 'Ready' | 'Paused' | 'Archived';
  interval: number;
  /** Optional per-marketplace check cadence in minutes; unset sources use interval. */
  sourceIntervals?: Partial<Record<Marketplace, number>>;
  nextScan: string;
  enabled: boolean;
  exactUrls: string[];
  sensitivity: number;
  shippingOnly: boolean;
  typoVariants: boolean;
  aiRelevance: boolean;
  variantGroups: VariantGroup[];
  /** No groups yet and Scout will propose them from listing titles once enough are saved. */
  variantGroupsAuto?: boolean;
  /** Per-model sample/readiness/typical breakdown; empty without configured groups. */
  variants: WatchVariantStat[];
  /** How many Exceptional/Very strong/Strong findings this watch currently has. */
  dealCounts: WatchDealCounts;
  referenceMarketWatchId: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** OLX scans only search this category; null searches all of OLX. */
  olxCategory?: OlxCategory | null;
  /** Only learn from and alert on this seller type; null is any seller. */
  sellerType?: SellerType | null;
  /** Skip paid placements and highlights. */
  ignorePromoted?: boolean;
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
  /** OLX only: private sellers or business accounts. */
  ownerType?: "private" | "business" | null;
  /** OLX only: search a single category. */
  olxCategory?: OlxCategory | null;
  /** 1-based marketplace result page; the UI pages past the per-request cap. */
  page?: number;
  /** Client-generated id that correlates streamed per-source progress events. */
  searchId?: string;
  /** Run the Jev/LLM relevance filter for this search; default true when omitted. */
  aiRelevance?: boolean;
}

export interface SearchSourceStatus {
  source: Marketplace;
  /** `searching` is a client-side placeholder until the source reports back. */
  status: "ok" | "error" | "searching";
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
  /** Always "Polska": Scout no longer filters by location; kept for older iOS builds. */
  location: string;
  condition: string;
  sources: Marketplace[];
  intervalHours: number;
  minPrice: number | null;
  maxPrice: number | null;
  shippingOnly: boolean;
  typoVariants: boolean;
  /** Part of the research criteria: changing it starts a new series. */
  olxCategory?: OlxCategory | null;
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

export type MarketWatchInput = Pick<MarketWatch, 'name' | 'query' | 'terms' | 'excluded' | 'condition' | 'sources' | 'intervalHours' | 'minPrice' | 'maxPrice' | 'shippingOnly' | 'typoVariants' | 'olxCategory'>;

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
  authEnabled: boolean;
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
  /** Alerts open the Scout iOS app; the marketplace page becomes an action button. */
  openInApp: boolean;
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
