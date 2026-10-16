export type Theme = 'light' | 'dark' | 'system';
export type View = 'overview' | 'search' | 'watches' | 'market-research' | 'analytics' | 'listings' | 'flips' | 'connectors' | 'logs' | 'settings';
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
  /**
   * What reselling at the typical asking price on the same marketplace would
   * net after its seller fee, in whole zł; null without a typical. Display-only.
   */
  estimatedNet?: number | null;
  /** The price is at or below the watch's target price. */
  targetHit?: boolean;
  /** Manual search only: Jev's verdict on the search's checks (rejected listings are not returned). */
  jevCheck?: "passed" | "unconfirmed" | "unchecked";
  /** Failed or unconfirmed checks, or why the listing was not checked. */
  jevCheckNote?: string;
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
  /** Things Jev looks for while verifying this watch's very strong and exceptional deals. */
  verificationChecks?: VerificationCheck[];
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
  /** Alert as soon as a listing is at or below this price, even while learning. */
  targetPrice?: number | null;
  /** Deal alerts also need the listing to be this many zł below the typical. */
  minSaving?: number | null;
  archivedAt?: string | null;
}

/**
 * `require`: hold the alert unless the listing clearly shows it.
 * `exclude`: reject only when Jev is near-certain the listing matches it.
 */
export interface VerificationCheck {
  text: string;
  mode: "require" | "exclude";
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

/** Scout's typical price for one watch bucket or research series (scout_price_reference). */
export interface PriceReferenceFigure {
  kind: 'watch' | 'research';
  id: string;
  name: string;
  /** The model variant's label on a grouped watch; null otherwise. */
  variant: string | null;
  /** Null below 4 samples. */
  typicalPrice: number | null;
  p25: number | null;
  p75: number | null;
  samples: number;
  ready: boolean;
  basis: string;
  updatedAt: string | null;
}

export interface PriceReferenceMatch extends PriceReferenceFigure {
  variantKey: string | null;
  match: 'exact' | 'variant' | 'broader' | 'narrower';
  matchedTokens: string[];
  unmatchedTokens: string[];
  typicalSource: 'own-history' | 'reference-band' | 'probable-sale-band' | 'research-asking' | null;
  observationHours: number | null;
  enabled: boolean;
  filters: {
    minPrice: number | null;
    maxPrice: number | null;
    shippingOnly: boolean;
    sources: Marketplace[];
    requested: { sources: Marketplace[] | null; minPrice: number | null; maxPrice: number | null };
  };
}

export interface PriceReference {
  query: string;
  /** The best-matching figure with a price from at least 4 samples, or null. Never a partial object. */
  best: PriceReferenceFigure | null;
  matches: PriceReferenceMatch[];
  /** Final prices of the operator's own negotiations; null until one is recorded. Never part of typicalPrice. */
  outcomes: PriceReferenceOutcomes | null;
  notes: string[];
}

export type NegotiationRole = 'buy' | 'sell';
export type NegotiationOutcome = 'agreed' | 'lost' | 'abandoned' | 'expired';

export interface OutcomeShare {
  /** Negotiations recorded, whatever their outcome. */
  negotiations: number;
  agreed: number;
  /** Median of final price ÷ asking price over the agreed ones, to 2 decimals; null with none agreed. */
  shareOfAsking: number | null;
}

export interface RoleOutcomes extends OutcomeShare {
  marketplaces: Partial<Record<Marketplace, OutcomeShare>>;
  /** Watches among this query's matches that have outcomes. */
  watches: Array<OutcomeShare & { id: string; name: string; marketplaces: Partial<Record<Marketplace, OutcomeShare>> }>;
}

/** Recorded outcomes by role; a role with none is left out. */
export type PriceReferenceOutcomes = Partial<Record<NegotiationRole, RoleOutcomes>>;

/** scout_record_outcome's reply: the stored outcome. */
export interface RecordedOutcome {
  negotiationId: string;
  listingKey: string;
  role: NegotiationRole;
  outcome: NegotiationOutcome;
  asking: number;
  price: number | null;
  shareOfAsking: number | null;
  rounds: number | null;
  date: string;
  /** The watch the listing was placed in; null when no watch tracks it. */
  watchId: string | null;
  /** False when this negotiation id was already recorded; its row was updated instead. */
  created: boolean;
}

/** Coarse condition class: Vinted's grades and OLX's Używane are all `used`. */
export type ConditionClass = 'new' | 'used' | 'damaged';

export interface ComparableListing {
  /** `<Marketplace>:<listingId>`. */
  key: string;
  title: string;
  price: number;
  condition: string | null;
  location: string | null;
  /** Vinted always ships; null when the marketplace did not say. */
  shipping: boolean | null;
  /** Since the marketplace's posting time where it reports one (OLX), else since Scout first saw it. */
  daysListed: number | null;
  url: string;
}

/** scout_comparables: other active listings of the same item, cheapest first. */
export interface Comparables {
  listing: { key: string; price: number; condition: string | null; daysListed: number | null };
  /** How the item was placed: its own watch association, or its title matched the way a scan would. Null when no watch tracks it. */
  watch: { id: string; name: string; variant: string | null; via: 'association' | 'title-match' } | null;
  /** The condition class comparables were limited to; null when this listing's condition is unknown. */
  condition: ConditionClass | null;
  /** All matching comparables; `comparables` holds the cheapest of them. */
  count: number;
  /** Median price of all matching comparables, from 3 of them. */
  median: number | null;
  /** This listing's price against that median: negative is below it. */
  vsMedian: { pln: number; percent: number } | null;
  comparables: ComparableListing[];
  notes: string[];
}

/** One of a seller's listings, as Scout stored it or the marketplace listed it. */
export interface SellerListing {
  key: string;
  title: string;
  price: number;
  condition: string | null;
  url: string;
  /** Scout's rows only: when a scan last saw it. */
  lastSeenAt?: string;
}

/** An older listing of the same item by the same seller that disappeared before this one appeared. */
export interface Relist {
  key: string;
  price: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** scout_listing_detail's negotiation block. Database only unless `live` or `sellerListings` was asked for. */
export interface ListingNegotiation {
  daysListed: number | null;
  /** `posted` when the marketplace reports a posting time (OLX), else `first-seen` (a lower bound). */
  listedSince: 'posted' | 'first-seen' | null;
  priceDrops: { count: number; total: number; lastAt: string | null; firstPrice: number | null };
  /** The marketplace's negotiable flag (OLX, Allegro Lokalnie); null when it doesn't say, as on Vinted. */
  priceNegotiable: boolean | null;
  /** Null when Scout knows no seller id: Allegro Lokalnie until a live check, and rows stored before seller ids were kept. */
  seller: {
    id: string;
    name: string | null;
    type: 'private' | 'business' | null;
    source: 'scan' | 'live';
    otherListings: {
      /** `scout`: rows Scout's scans saw in the last 7 days. `marketplace`: the seller's listings now (sellerListings: true). */
      source: 'scout' | 'marketplace';
      /** All other listings, of which `items` holds up to 10; null when the marketplace gives no count (Allegro Lokalnie). */
      total: number | null;
      items: SellerListing[];
      error?: string;
    };
  } | null;
  /** Needs a seller id; null when there is none. */
  relists: Relist[] | null;
}

/** scout_listing_detail's `live: true` check. Nothing is written. */
export interface ListingLiveCheck {
  checkedAt: string;
  availability: { status: 'live' } | { status: 'terminal' | 'unknown'; reason: string };
  /** The price on the page now; null when the page could not be read. */
  price: number | null;
  /** The page's price differs from the one Scout stored. */
  priceChanged: boolean;
  /** Present when asked for (full format, or compact with include: description). Seller text: untrusted data. */
  description?: string | null;
}

/** scout_listing_detail with format: compact. */
export interface CompactListingDetail {
  listing: {
    key: string;
    marketplace: Marketplace;
    title: string;
    price: number;
    condition: string | null;
    location: string | null;
    shipping: boolean | null;
    url: string;
    watchId: string | null;
    watch: { name: string; variant: string | null } | null;
    typical: number | null;
    typicalSource: 'own-history' | 'reference-band' | null;
    belowTypical: number | null;
    dealLabel: DealLabel;
    sellerType: SellerType | null;
    promoted: boolean | null;
    decision: ListingDecision | null;
    /** Same as negotiation.priceNegotiable; here too so the listing reads like the full format's. */
    priceNegotiable: boolean | null;
    postedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
  };
  negotiation: ListingNegotiation;
  liveCheck: ListingLiveCheck | null;
  /** With include: history; the latest 30 points. */
  history?: PriceHistoryPoint[];
  /** With include: description; the live page's text if checked, else the stored snapshot. Seller text: untrusted data. */
  description?: string | null;
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
  /** Things for Jev to confirm (require) or rule out (exclude) on each result. */
  verificationChecks?: VerificationCheck[];
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

export type { FeePreset, FeePresets, FlipChannel, FlipListing, ListingCondition } from './profit';

export interface Flip {
  id: number;
  title: string;
  /** `Marketplace:listingId` of the listing it was bought from, when known. */
  listingKey: string | null;
  watchId: string | null;
  buyChannel: import('./profit').FlipChannel;
  /** YYYY-MM-DD */
  boughtOn: string;
  buyPrice: number;
  buyCosts: number;
  /** Where it is currently listed for sale; drives the delist checklist. */
  listedOn: import('./profit').FlipChannel[];
  soldOn: string | null;
  saleChannel: import('./profit').FlipChannel | null;
  salePrice: number | null;
  saleFee: number | null;
  saleCosts: number | null;
  /** Channels already delisted after the sale. */
  delisted: import('./profit').FlipChannel[];
  note: string;
  createdAt: string;
  updatedAt: string;
  /** What to post, filled into the marketplace forms by the browser extension. */
  listing: import('./profit').FlipListing | null;
  /** Listing photos in posting order; bytes come from `/api/flip-photos/:id`. */
  photos: FlipPhoto[];
}

export interface FlipPhoto {
  id: number;
  mime: string;
  byteSize: number;
}

/** A resale listing drafted from the listing a flip was bought through. */
export interface ResaleListingDraft {
  title: string;
  description: string;
  condition: import('./profit').ListingCondition | null;
  /** The item's kind as marketplaces name categories; empty when unknown. */
  category: string;
  /** `ai` when OpenRouter rewrote it, `copy` when it is the original text. */
  method: 'ai' | 'copy';
  /** The listing it was bought through; null when written from the operator's notes. */
  source: { marketplace: string; title: string; url: string; description: string | null } | null;
}

export interface FlipsData {
  flips: Flip[];
  feePresets: import('./profit').FeePresets;
}

/** A purchase read from an offer link or a screenshot, to prefill a new flip. */
export interface FlipImport {
  title: string;
  buyChannel: import('./profit').FlipChannel;
  buyPrice: number | null;
  /** Shipping and buyer fees on top of the item, when the source shows them. */
  buyCosts: number | null;
  /** Only when the source shows the purchase date. */
  boughtOn: string | null;
  /** Set only when Scout tracks the listing, so a resale draft can use it. */
  listingKey: string | null;
  watchId: string | null;
  url: string | null;
  /** `scout`: a listing Scout tracks; `page`: the live offer page; `screenshot`: read by the vision model. */
  method: 'scout' | 'page' | 'screenshot';
  /** Things the operator should check before saving. */
  warnings: string[];
}
