import Foundation

// Market research (`/api/market-watches`, `/api/market-listings`) and deal
// analytics (`/api/analytics`); mirrors src/types.ts. Research prices are
// asking prices. A listing's last asking price before it disappears is a
// probable-sale *estimate*, never a confirmed sale.

/// Probable-sale estimate band from listings verified as no longer available.
public struct SaleBand: Codable, Hashable, Sendable {
    public var p25: Double?
    public var median: Double?
    public var p75: Double?
    public var sampleCount: Int
    public var eligibleCount: Int
    public var excludedStale: Int
    public var windowDays: Int
    public var computedAt: String
}

public struct MarketWatch: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var query: String
    public var terms: String
    public var excluded: String
    public var location: String
    public var condition: String
    public var sources: [Marketplace]
    public var intervalHours: Int
    public var minPrice: Double?
    public var maxPrice: Double?
    public var shippingOnly: Bool
    public var typoVariants: Bool
    public var enabled: Bool
    public var nextScan: String
    public var lastScan: String
    public var totalListings: Int
    public var activeListings: Int
    public var endedListings: Int
    public var estimatedMedianPrice: Double?
    public var saleBand: SaleBand?
    public var activeVersionId: String?
}

public struct MarketTrackedListing: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var marketWatchId: String
    public var watchName: String
    public var marketplace: Marketplace
    public var listingId: String
    public var title: String
    public var url: String
    public var image: String
    public var firstPrice: Double
    public var lastPrice: Double
    public var lowestPrice: Double
    public var priceChangePercent: Double
    public var firstSeenAt: String
    public var lastSeenAt: String
    public var endedAt: String?
    /// `active`, `ended`, or `superseded` (from a previous search series).
    public var status: String
    public var availabilityStatus: String?
    public var endedReason: String?
    /// Consecutive scans that missed the listing; three verified misses end it.
    public var missingScans: Int
    public var observations: Int
    /// `pending`, `saved`, or `failed` for the preserved listing copy.
    public var snapshotStatus: String?

    public var imageURL: URL? { image.isEmpty ? nil : URL(string: image) }
    public var webURL: URL? { URL(string: url) }

    public var statusTitle: String {
        switch status {
        case "ended": "No longer available"
        case "superseded": "Previous series"
        default: missingScans > 0 ? "Verifying (\(missingScans)/3)" : "Active"
        }
    }
}

public struct MarketResearchData: Codable, Hashable, Sendable {
    public struct Aggregates: Codable, Hashable, Sendable {
        public var overallMedianPrice: Double?
        public var endedCount: Int
        public var activeCount: Int
        public var saleBand: SaleBand?
    }

    public var watches: [MarketWatch]
    public var listings: [MarketTrackedListing]
    public var aggregates: Aggregates?
    public var pagination: Pagination?
}

public struct MarketWatchTrend: Codable, Hashable, Sendable {
    public var marketWatchId: String
    public var watchName: String
    public var rangeDays: Int
    public var firstObservedAt: String?
    public var lastObservedAt: String?
    public var totalObservations: Int
    public var probableSaleMedian: Double?
    public var points: [WatchAnalyticsPoint]
}

public struct MarketListingSnapshot: Codable, Hashable, Sendable {
    public struct Image: Codable, Hashable, Sendable, Identifiable {
        public var id: Int
        public var position: Int
        public var byteSize: Int
    }

    public var id: Int
    public var marketplace: Marketplace
    public var listingId: String
    public var title: String
    public var price: Double
    public var condition: String?
    public var location: String?
    public var url: String
    public var description: String?
    public var capturedAt: String
    public var images: [Image]
}

public enum MarketListingStatus: String, CaseIterable, Hashable, Sendable {
    case active, ended, superseded
}

/// Fields of a research watch for `POST /api/market-watches` and `PATCH`.
public struct MarketWatchDraft: Hashable, Sendable {
    public static let conditions = ["Any", "New", "Used", "Like new", "Very good", "Good"]

    public var name: String
    public var query: String
    public var terms: String
    public var excluded: String
    public var location: String
    public var condition: String
    public var sources: [Marketplace]
    /// Hours between snapshots, 6–168.
    public var intervalHours: Int
    public var minPrice: Double?
    public var maxPrice: Double?
    public var shippingOnly: Bool
    public var typoVariants: Bool

    public init(
        name: String = "",
        query: String = "",
        terms: String = "",
        excluded: String = "",
        location: String = "Polska",
        condition: String = "Any",
        sources: [Marketplace] = Marketplace.all,
        intervalHours: Int = 24,
        minPrice: Double? = nil,
        maxPrice: Double? = nil,
        shippingOnly: Bool = false,
        typoVariants: Bool = false
    ) {
        self.name = name
        self.query = query
        self.terms = terms
        self.excluded = excluded
        self.location = location
        self.condition = condition
        self.sources = sources
        self.intervalHours = intervalHours
        self.minPrice = minPrice
        self.maxPrice = maxPrice
        self.shippingOnly = shippingOnly
        self.typoVariants = typoVariants
    }

    public init(watch: MarketWatch) {
        self.init(
            name: watch.name, query: watch.query, terms: watch.terms, excluded: watch.excluded,
            location: watch.location, condition: watch.condition, sources: watch.sources,
            intervalHours: watch.intervalHours, minPrice: watch.minPrice, maxPrice: watch.maxPrice,
            shippingOnly: watch.shippingOnly, typoVariants: watch.typoVariants
        )
    }

    public var validationError: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Give the research watch a name." }
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Enter what Scout should search for." }
        if sources.isEmpty { return "Pick at least one marketplace." }
        if !(6...168).contains(intervalHours) { return "The snapshot interval must be between 6 and 168 hours." }
        if let minPrice, minPrice < 0 { return "The minimum price can't be negative." }
        if let maxPrice, maxPrice <= 0 { return "The maximum price must be above zero." }
        if let minPrice, let maxPrice, minPrice > maxPrice { return "The minimum price can't exceed the maximum." }
        return nil
    }

    func normalized() -> MarketWatchDraft {
        var copy = self
        copy.name = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        copy.query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(240))
        copy.terms = terms.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.excluded = excluded.trimmingCharacters(in: .whitespacesAndNewlines)
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.location = place.isEmpty ? "Polska" : place
        return copy
    }
}

extension MarketWatchDraft: Codable {
    private enum CodingKeys: String, CodingKey {
        case name, query, terms, excluded, location, condition, sources, intervalHours
        case minPrice, maxPrice, shippingOnly, typoVariants
    }

    // Prices are always sent, as null when empty, so an edit can clear them.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(query, forKey: .query)
        try container.encode(terms, forKey: .terms)
        try container.encode(excluded, forKey: .excluded)
        try container.encode(location, forKey: .location)
        try container.encode(condition, forKey: .condition)
        try container.encode(sources, forKey: .sources)
        try container.encode(intervalHours, forKey: .intervalHours)
        try container.encode(minPrice, forKey: .minPrice)
        try container.encode(maxPrice, forKey: .maxPrice)
        try container.encode(shippingOnly, forKey: .shippingOnly)
        try container.encode(typoVariants, forKey: .typoVariants)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? name
        query = try container.decodeIfPresent(String.self, forKey: .query) ?? query
        terms = try container.decodeIfPresent(String.self, forKey: .terms) ?? terms
        excluded = try container.decodeIfPresent(String.self, forKey: .excluded) ?? excluded
        location = try container.decodeIfPresent(String.self, forKey: .location) ?? location
        condition = try container.decodeIfPresent(String.self, forKey: .condition) ?? condition
        sources = try container.decodeIfPresent([Marketplace].self, forKey: .sources) ?? sources
        intervalHours = try container.decodeIfPresent(Int.self, forKey: .intervalHours) ?? intervalHours
        minPrice = try container.decodeIfPresent(Double.self, forKey: .minPrice)
        maxPrice = try container.decodeIfPresent(Double.self, forKey: .maxPrice)
        shippingOnly = try container.decodeIfPresent(Bool.self, forKey: .shippingOnly) ?? shippingOnly
        typoVariants = try container.decodeIfPresent(Bool.self, forKey: .typoVariants) ?? typoVariants
    }
}

// MARK: - Analytics

/// `/api/analytics`: daily-deduplicated observations across deal watches.
/// Percentages are already 0–100.
public struct AnalyticsData: Codable, Hashable, Sendable {
    public struct Overview: Codable, Hashable, Sendable {
        public var trackedListings: Int
        public var newListings: Int
        public var strongDeals: Int
        public var medianDiscountPercent: Double?
        public var scanRuns: Int
        public var scanSuccessRate: Double?
    }

    public struct TrendPoint: Codable, Hashable, Sendable {
        public var date: String
        public var medianPrice: Double?
        public var lowerPrice: Double?
        public var upperPrice: Double?
        public var listingCount: Int
        public var strongDealCount: Int
        public var day: Date? { ScoutDate.parse(date) }
    }

    public struct DiscountBucket: Codable, Hashable, Sendable {
        public var label: String
        public var count: Int
    }

    public struct WatchRow: Codable, Hashable, Sendable {
        public var watchId: String
        public var watchName: String
        public var listings: Int
        public var strongDeals: Int
        public var medianDiscountPercent: Double?
        public var lastSeenAt: String?
    }

    public struct MarketplaceRow: Codable, Hashable, Sendable {
        public var marketplace: Marketplace
        public var listings: Int
        public var strongDeals: Int
        public var medianDiscountPercent: Double?
        public var scanRuns: Int
        public var scanSuccessRate: Double?
        public var averageLatencyMs: Double?
    }

    public struct Triage: Codable, Hashable, Sendable {
        public var buy: Int
        public var watch: Int
        public var pass: Int
        public var none: Int
    }

    public struct AIQuality: Codable, Hashable, Sendable {
        public var relevanceJudged: Int
        public var relevancePassRate: Double?
        public var shadowJudged: Int
        public var shadowAgreementRate: Double?
    }

    public var rangeDays: Int
    public var watchId: String?
    public var marketplace: Marketplace?
    public var generatedAt: String
    public var overview: Overview
    public var trend: [TrendPoint]
    public var discountDistribution: [DiscountBucket]
    public var watchLeaderboard: [WatchRow]
    public var marketplaceComparison: [MarketplaceRow]
    public var triage: Triage
    public var aiQuality: AIQuality
}

// MARK: - Settings

/// The part of `GET /api/settings` the app shows.
public struct ServerSettings: Codable, Hashable, Sendable {
    public struct Ntfy: Codable, Hashable, Sendable {
        public var configured: Bool
        public var minimumPriority: String
        /// Missing on servers from before the option existed.
        public var openInApp: Bool?
    }

    public var ntfy: Ntfy
}
