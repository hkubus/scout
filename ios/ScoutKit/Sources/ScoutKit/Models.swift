import Foundation

// Mirrors the subset of `src/types.ts` the iOS app reads. Server-controlled
// string unions are modelled as open string wrappers so a new marketplace,
// deal label, or status never breaks decoding of an otherwise valid payload.

public struct Marketplace: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let olx = Marketplace(rawValue: "OLX")
    public static let allegroLokalnie = Marketplace(rawValue: "Allegro Lokalnie")
    public static let vinted = Marketplace(rawValue: "Vinted")
    public static let all: [Marketplace] = [.olx, .allegroLokalnie, .vinted]
}

public struct DealLabel: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let exceptional = DealLabel(rawValue: "Exceptional")
    public static let veryStrong = DealLabel(rawValue: "Very strong")
    public static let strong = DealLabel(rawValue: "Strong")
    public static let watch = DealLabel(rawValue: "Watch")
}

public enum ListingDecision: String, Codable, Hashable, Sendable, CaseIterable {
    case buy, watch, pass
}

public struct Pagination: Codable, Hashable, Sendable {
    public var page: Int
    public var pageSize: Int
    public var total: Int
    public var hasNext: Bool

    public init(page: Int, pageSize: Int, total: Int, hasNext: Bool) {
        self.page = page
        self.pageSize = pageSize
        self.total = total
        self.hasNext = hasNext
    }
}

public struct ListingDescriptionVerification: Codable, Hashable, Sendable {
    public var decision: String
    public var confidence: Double
    public var summary: String
    public var issues: [String]
    public var evidence: [String]
}

public struct Listing: Codable, Hashable, Sendable {
    /// Global marketplace identity (`"<marketplace>:<listing id>"`).
    public var id: String
    public var marketplaceListingKey: String?
    /// Watch-specific identity; the same listing can appear under several watches.
    public var associationId: String?
    public var watchId: String?
    public var watchListingId: Int?
    public var title: String
    public var subtitle: String
    public var marketplace: Marketplace
    public var price: Double
    public var typical: Double?
    public var typicalSource: String?
    public var variantKey: String?
    public var variantLabel: String?
    public var variantSource: String?
    /// Signed percentage versus the typical asking price; negative is cheaper.
    public var belowTypical: Double?
    public var observed: String
    public var observedAt: String
    public var dealStrength: Double
    public var dealLabel: DealLabel
    public var image: String
    public var url: String
    public var watch: String
    public var condition: String?
    public var location: String?
    public var shippingAvailable: Bool?
    public var priceNegotiable: Bool?
    public var listingId: String?
    public var decision: ListingDecision?
    public var note: String?
    public var hidden: Bool?
    public var aiFiltered: Bool?
    public var aiDescriptionVerification: ListingDescriptionVerification?
    public var aiDescriptionVerificationAt: String?
    public var aiDescriptionVerificationStatus: String?
    public var aiDescriptionVerificationError: String?

    /// Unique per row in watch-scoped lists, where `id` can repeat.
    public var rowID: String { associationId ?? id }
    /// Key accepted by `/api/listing-detail` and `/api/listing-actions`.
    public var key: String { marketplaceListingKey ?? id }
    public var observedDate: Date? { ScoutDate.parse(observedAt) }
    public var imageURL: URL? { image.isEmpty ? nil : URL(string: image) }
    public var webURL: URL? { URL(string: url) }
}

public struct PriceHistoryPoint: Codable, Hashable, Sendable {
    public var price: Double
    public var observedAt: String
    public var date: Date? { ScoutDate.parse(observedAt) }
}

public struct ListingAction: Codable, Hashable, Sendable {
    public var decision: ListingDecision?
    public var note: String
    public var hidden: Bool
    public var updatedAt: String?

    public init(decision: ListingDecision?, note: String, hidden: Bool, updatedAt: String? = nil) {
        self.decision = decision
        self.note = note
        self.hidden = hidden
        self.updatedAt = updatedAt
    }
}

public struct ListingDetailSnapshot: Codable, Hashable, Sendable {
    public var title: String
    public var price: Double
    public var condition: String?
    public var location: String?
    public var url: String
    public var description: String?
    public var capturedAt: String
    public var verificationStatus: String?
}

public struct VariantGroup: Codable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var terms: String
    public var exclude: String?
}

public struct ListingDetail: Codable, Hashable, Sendable {
    public var listing: Listing
    public var history: [PriceHistoryPoint]
    public var action: ListingAction
    public var descriptionSnapshot: ListingDetailSnapshot?
    public var firstSeenAt: String
    public var lastSeenAt: String
    public var verificationModel: String?
    public var variantGroups: [VariantGroup]?
}

public struct WatchVariantStat: Codable, Hashable, Sendable {
    public var key: String
    public var label: String
    public var samples: Int
    public var targetSamples: Int
    public var observationHours: Double
    public var readiness: Double
    public var typical: Double?
}

public struct WatchDealCounts: Codable, Hashable, Sendable {
    public var exceptional: Int
    public var veryStrong: Int
    public var strong: Int
    public var total: Int { exceptional + veryStrong + strong }
}

public struct Watch: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var query: String
    public var terms: String
    public var excluded: String
    public var sources: [Marketplace]
    public var location: String
    public var condition: String
    public var samples: Int
    public var targetSamples: Int
    public var observationHours: Double
    /// 0–100.
    public var readiness: Double
    /// `Learning`, `Ready`, `Paused`, or `Archived`.
    public var status: String
    /// Minutes between scans.
    public var interval: Double
    public var sourceIntervals: [String: Double]?
    public var nextScan: String
    public var enabled: Bool
    public var exactUrls: [String]
    public var sensitivity: Double
    public var shippingOnly: Bool
    public var typoVariants: Bool
    public var aiRelevance: Bool
    public var variantGroups: [VariantGroup]
    public var variants: [WatchVariantStat]
    public var dealCounts: WatchDealCounts
    public var referenceMarketWatchId: String?
    public var minPrice: Double?
    public var maxPrice: Double?
    public var archivedAt: String?

    public var isArchived: Bool { archivedAt != nil || status == "Archived" }
}

public struct WatchAnalyticsPoint: Codable, Hashable, Sendable {
    public var date: String
    public var medianPrice: Double?
    public var lowerPrice: Double?
    public var upperPrice: Double?
    public var listingCount: Int
    public var day: Date? { ScoutDate.parse(date) }
}

public struct WatchAnalyticsSource: Codable, Hashable, Sendable {
    public var source: Marketplace
    public var medianPrice: Double?
    public var listingCount: Int
    public var strongDealCount: Int
}

public struct WatchAnalytics: Codable, Hashable, Sendable {
    public struct Current: Codable, Hashable, Sendable {
        public var medianPrice: Double?
        public var lowerPrice: Double?
        public var upperPrice: Double?
        public var minPrice: Double?
        public var maxPrice: Double?
        public var listingCount: Int
        public var strongDealCount: Int
        public var strongDealRate: Double?
    }

    public var watchId: String
    public var watchName: String
    public var rangeDays: Int
    public var firstObservedAt: String?
    public var lastObservedAt: String?
    public var totalObservations: Int
    public var current: Current
    public var medianChangePercent: Double?
    public var points: [WatchAnalyticsPoint]
    public var sources: [WatchAnalyticsSource]
}

public struct Connector: Codable, Hashable, Sendable {
    public var name: String
    /// `marketplace`, `discord`, or `ntfy`.
    public var kind: String
    /// `OK`, `Warning`, `Degraded`, or `Idle`.
    public var status: String
    public var detail: String
    public var lastSuccess: String
    public var color: String
    public var requests: Int
    public var latency: String
}

public struct DashboardStats: Codable, Hashable, Sendable {
    public var watching: Int
    public var newToday: Int
    public var strongDeals: Int
}

public struct DashboardData: Codable, Hashable, Sendable {
    public var listings: [Listing]
    public var watches: [Watch]
    public var connectors: [Connector]
    public var stats: DashboardStats
    public var lastScan: String
    public var lastScanTime: String
}

public struct ListingsPage: Codable, Hashable, Sendable {
    public var listings: [Listing]
    public var pagination: Pagination
}

public struct Health: Codable, Hashable, Sendable {
    public var status: String
    public var service: String?
    public var version: String?
    public var now: String?
}

public struct Readiness: Codable, Hashable, Sendable {
    public struct Connectors: Codable, Hashable, Sendable {
        public var degraded: [String]
        public var degradedCount: Int
    }

    public struct Scheduler: Codable, Hashable, Sendable {
        public var lastTickAt: String?
        public var healthy: Bool
    }

    /// `ready` when the server answered 200, otherwise the reported status.
    public var status: String
    public var scheduler: Scheduler?
    public var connectors: Connectors?
    public var isReady: Bool { status == "ready" }
}

public struct ScanQueued: Codable, Hashable, Sendable {
    public var queued: Bool
    public var message: String
}

public struct WatchPatch: Codable, Hashable, Sendable {
    public var enabled: Bool?
    public var archived: Bool?

    public init(enabled: Bool? = nil, archived: Bool? = nil) {
        self.enabled = enabled
        self.archived = archived
    }
}

public enum ListingSort: String, Codable, Hashable, Sendable, CaseIterable {
    case newest, strongest, price
}

public enum ListingVisibility: String, Codable, Hashable, Sendable, CaseIterable {
    case visible, hidden, all
}

public struct ListingsQuery: Hashable, Sendable {
    public var page: Int
    public var pageSize: Int
    public var marketplace: Marketplace?
    public var search: String
    public var watchId: String?
    public var sort: ListingSort
    public var decision: ListingDecision?
    public var visibility: ListingVisibility

    public init(
        page: Int = 1,
        pageSize: Int = 50,
        marketplace: Marketplace? = nil,
        search: String = "",
        watchId: String? = nil,
        sort: ListingSort = .newest,
        decision: ListingDecision? = nil,
        visibility: ListingVisibility = .visible
    ) {
        self.page = page
        self.pageSize = pageSize
        self.marketplace = marketplace
        self.search = search
        self.watchId = watchId
        self.sort = sort
        self.decision = decision
        self.visibility = visibility
    }

    var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "pageSize", value: String(pageSize)),
            URLQueryItem(name: "sort", value: sort.rawValue),
            URLQueryItem(name: "visibility", value: visibility.rawValue),
        ]
        if let marketplace { items.append(URLQueryItem(name: "marketplace", value: marketplace.rawValue)) }
        let trimmed = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { items.append(URLQueryItem(name: "q", value: String(trimmed.prefix(240)))) }
        if let watchId { items.append(URLQueryItem(name: "watchId", value: watchId)) }
        if let decision { items.append(URLQueryItem(name: "decision", value: decision.rawValue)) }
        return items
    }
}

// MARK: - Manual search

public enum SearchCondition: String, Codable, Hashable, Sendable, CaseIterable {
    case any = "Any", new = "New", used = "Used"
}

public enum SellerType: String, Codable, Hashable, Sendable, CaseIterable {
    case `private`, business
}

/// Body of `POST /api/search`: a one-off marketplace search that neither
/// creates a watch nor touches any watch's price history.
public struct SearchFilters: Codable, Hashable, Sendable {
    public var query: String
    public var terms: String
    public var excluded: String
    public var sources: [Marketplace]
    public var minPrice: Double?
    public var maxPrice: Double?
    public var shippingOnly: Bool
    public var condition: SearchCondition
    public var location: String
    /// OLX only.
    public var ownerType: SellerType?
    /// 1-based marketplace result page; the server caps it at 10.
    public var page: Int
    /// Correlates the streamed `search` progress events with this request.
    public var searchId: String?
    public var aiRelevance: Bool

    public init(
        query: String = "",
        terms: String = "",
        excluded: String = "",
        sources: [Marketplace] = Marketplace.all,
        minPrice: Double? = nil,
        maxPrice: Double? = nil,
        shippingOnly: Bool = false,
        condition: SearchCondition = .any,
        location: String = "",
        ownerType: SellerType? = nil,
        page: Int = 1,
        searchId: String? = nil,
        aiRelevance: Bool = true
    ) {
        self.query = query
        self.terms = terms
        self.excluded = excluded
        self.sources = sources
        self.minPrice = minPrice
        self.maxPrice = maxPrice
        self.shippingOnly = shippingOnly
        self.condition = condition
        self.location = location
        self.ownerType = ownerType
        self.page = page
        self.searchId = searchId
        self.aiRelevance = aiRelevance
    }

    /// The price range the server accepts: both bounds optional, minimum ≥ 0,
    /// maximum > 0, and minimum not above maximum.
    public var hasValidPriceRange: Bool {
        if let minPrice, minPrice < 0 { return false }
        if let maxPrice, maxPrice <= 0 { return false }
        if let minPrice, let maxPrice, minPrice > maxPrice { return false }
        return true
    }

    public var canSearch: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sources.isEmpty && hasValidPriceRange
    }

    /// Trimmed copy for sending, with the web UI's `Polska` location default.
    func normalized() -> SearchFilters {
        var copy = self
        copy.query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(240))
        copy.terms = terms.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.excluded = excluded.trimmingCharacters(in: .whitespacesAndNewlines)
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.location = place.isEmpty ? "Polska" : place
        return copy
    }
}

public struct SearchSourceStatus: Codable, Hashable, Sendable {
    public var source: Marketplace
    /// `ok`, `error`, or the client-side placeholder `searching`.
    public var status: String
    public var count: Int
    public var pendingShipping: Int
    public var durationMs: Double
    public var message: String

    public init(source: Marketplace, status: String, count: Int, pendingShipping: Int, durationMs: Double, message: String) {
        self.source = source
        self.status = status
        self.count = count
        self.pendingShipping = pendingShipping
        self.durationMs = durationMs
        self.message = message
    }

    public static func searching(_ source: Marketplace) -> SearchSourceStatus {
        SearchSourceStatus(source: source, status: "searching", count: 0, pendingShipping: 0, durationMs: 0, message: "Searching…")
    }
}

public struct ManualSearchResponse: Codable, Hashable, Sendable {
    public var listings: [Listing]
    public var sources: [SearchSourceStatus]
}

/// Payload of the `search` server-sent event: one marketplace finished.
public struct SearchProgressEvent: Codable, Hashable, Sendable {
    public var searchId: String
    public var page: Int
    public var source: Marketplace
    public var status: SearchSourceStatus
    public var listings: [Listing]
}

extension Array where Element == Listing {
    /// Merges streamed or paged results by listing id, cheapest first.
    public func mergingSearchResults(_ incoming: [Listing]) -> [Listing] {
        var byID: [String: Listing] = [:]
        var order: [String] = []
        for listing in self + incoming {
            if byID[listing.id] == nil { order.append(listing.id) }
            byID[listing.id] = listing
        }
        return order.compactMap { byID[$0] }.sorted { $0.price < $1.price }
    }
}
