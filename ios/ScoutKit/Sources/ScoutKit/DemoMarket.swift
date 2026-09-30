import Foundation

/// Synthetic market research and analytics for demo mode, derived from the
/// demo dashboard so names and prices line up across screens.
enum DemoMarket {
    static func watches(now: Date = Date()) -> [MarketWatch] {
        let computedAt = ISO8601DateFormatter().string(from: now)
        func band(_ median: Double, eligible: Int) -> SaleBand {
            SaleBand(p25: (median * 0.9).rounded(), median: median, p75: (median * 1.08).rounded(), sampleCount: eligible + 3, eligibleCount: eligible, excludedStale: 1, windowDays: 90, computedAt: computedAt)
        }
        return [
            MarketWatch(
                id: "market-deck", name: "Steam Deck OLED market", query: "steam deck oled", terms: "oled", excluded: "broken, parts",
                location: "Polska", condition: "Any", sources: [.olx, .allegroLokalnie], intervalHours: 24, minPrice: 1200, maxPrice: 4000,
                shippingOnly: false, typoVariants: false, enabled: true, nextScan: "in 9h", lastScan: "15h ago",
                totalListings: 146, activeListings: 38, endedListings: 97, estimatedMedianPrice: 2740, saleBand: band(2590, eligible: 61), activeVersionId: "v3"
            ),
            MarketWatch(
                id: "market-xm5", name: "Sony WH-1000XM5 market", query: "sony wh-1000xm5", terms: "xm5", excluded: "fake, replica",
                location: "Polska", condition: "Any", sources: Marketplace.all, intervalHours: 24, minPrice: nil, maxPrice: nil,
                shippingOnly: true, typoVariants: true, enabled: true, nextScan: "in 3h", lastScan: "21h ago",
                totalListings: 211, activeListings: 54, endedListings: 140, estimatedMedianPrice: 1090, saleBand: band(990, eligible: 88), activeVersionId: "v1"
            ),
            MarketWatch(
                id: "market-lego", name: "LEGO Rivendell market", query: "lego 10316", terms: "10316", excluded: "instrukcja",
                location: "Polska", condition: "New", sources: [.olx, .allegroLokalnie], intervalHours: 48, minPrice: nil, maxPrice: nil,
                shippingOnly: false, typoVariants: false, enabled: false, nextScan: "paused", lastScan: "3d ago",
                totalListings: 42, activeListings: 11, endedListings: 24, estimatedMedianPrice: 1690, saleBand: band(1590, eligible: 9), activeVersionId: "v1"
            ),
        ]
    }

    static func listings(dashboard: DashboardData, now: Date = Date()) -> [MarketTrackedListing] {
        let formatter = ISO8601DateFormatter()
        let watchFor: [String: (id: String, name: String)] = [
            "watch-deck": ("market-deck", "Steam Deck OLED market"),
            "watch-sony": ("market-xm5", "Sony WH-1000XM5 market"),
            "watch-lego": ("market-lego", "LEGO Rivendell market"),
        ]
        var result: [MarketTrackedListing] = []
        for (index, listing) in dashboard.listings.enumerated() {
            guard let watchID = listing.watchId, let watch = watchFor[watchID] else { continue }
            let firstPrice = ((listing.typical ?? listing.price) * 0.97).rounded()
            let ended = index % 2 == 1
            let firstSeen = now.addingTimeInterval(-Double(12 + index * 5) * 86_400)
            let lastSeen = now.addingTimeInterval(-Double(index) * 86_400)
            result.append(MarketTrackedListing(
                id: 1000 + index, marketWatchId: watch.id, watchName: watch.name, marketplace: listing.marketplace,
                listingId: listing.listingId ?? String(index), title: listing.title, url: listing.url, image: listing.image,
                firstPrice: firstPrice, lastPrice: listing.price, lowestPrice: listing.price,
                priceChangePercent: ((listing.price - firstPrice) / firstPrice * 1000).rounded() / 10,
                firstSeenAt: formatter.string(from: firstSeen), lastSeenAt: formatter.string(from: lastSeen),
                endedAt: ended ? formatter.string(from: lastSeen) : nil, status: ended ? "ended" : "active",
                availabilityStatus: ended ? "terminal" : "live", endedReason: ended ? "Listing removed" : nil,
                missingScans: index == 3 ? 1 : 0, observations: 6 + index * 3, snapshotStatus: index == 0 ? "saved" : nil
            ))
        }
        return result
    }

    static func trend(for watch: MarketWatch, days: Int) -> MarketWatchTrend {
        let base: WatchAnalytics = DemoTransport.fixture("watch-analytics")
        let scale = (watch.estimatedMedianPrice ?? 2740) / 2740
        let points = base.points.suffix(days).map { point -> WatchAnalyticsPoint in
            var scaled = point
            scaled.medianPrice = point.medianPrice.map { ($0 * scale).rounded() }
            scaled.lowerPrice = point.lowerPrice.map { ($0 * scale).rounded() }
            scaled.upperPrice = point.upperPrice.map { ($0 * scale).rounded() }
            return scaled
        }
        return MarketWatchTrend(
            marketWatchId: watch.id, watchName: watch.name, rangeDays: days,
            firstObservedAt: base.firstObservedAt, lastObservedAt: base.lastObservedAt,
            totalObservations: watch.totalListings * 6, probableSaleMedian: watch.saleBand?.median, points: Array(points)
        )
    }

    static func analytics(dashboard: DashboardData, days: Int, watchId: String?, marketplace: Marketplace?) -> AnalyticsData {
        let base: WatchAnalytics = DemoTransport.fixture("watch-analytics")
        let trend = base.points.suffix(days).enumerated().map { index, point in
            AnalyticsData.TrendPoint(date: point.date, medianPrice: point.medianPrice, lowerPrice: point.lowerPrice, upperPrice: point.upperPrice, listingCount: point.listingCount * 5, strongDealCount: index % 4 == 0 ? 2 : index % 3 == 0 ? 1 : 0)
        }
        let watches = dashboard.watches.filter { watchId == nil || $0.id == watchId }
        let leaderboard = watches.enumerated().map { index, watch in
            AnalyticsData.WatchRow(watchId: watch.id, watchName: watch.name, listings: 180 - index * 27, strongDeals: watch.dealCounts.total + 4 - index / 2, medianDiscountPercent: 6.5 + Double(index) * 1.7, lastSeenAt: dashboard.listings.first?.observedAt)
        }
        let sources = (marketplace.map { [$0] } ?? Marketplace.all).enumerated().map { index, source in
            AnalyticsData.MarketplaceRow(marketplace: source, listings: 310 - index * 90, strongDeals: 14 - index * 4, medianDiscountPercent: 7.2 + Double(index), scanRuns: 420 - index * 60, scanSuccessRate: 98.4 - Double(index) * 3.1, averageLatencyMs: 650 + Double(index) * 280)
        }
        return AnalyticsData(
            rangeDays: days, watchId: watchId, marketplace: marketplace, generatedAt: ISO8601DateFormatter().string(from: Date()),
            overview: AnalyticsData.Overview(trackedListings: 612, newListings: 187, strongDeals: 31, medianDiscountPercent: 8.4, scanRuns: 1024, scanSuccessRate: 96.8),
            trend: Array(trend),
            discountDistribution: [
                AnalyticsData.DiscountBucket(label: "<10%", count: 402),
                AnalyticsData.DiscountBucket(label: "10–20%", count: 143),
                AnalyticsData.DiscountBucket(label: "20–30%", count: 44),
                AnalyticsData.DiscountBucket(label: "30–50%", count: 19),
                AnalyticsData.DiscountBucket(label: "≥50%", count: 4),
            ],
            watchLeaderboard: leaderboard,
            marketplaceComparison: sources,
            triage: AnalyticsData.Triage(buy: 3, watch: 12, pass: 27, none: 570),
            aiQuality: AnalyticsData.AIQuality(relevanceJudged: 842, relevancePassRate: 71.3, shadowJudged: 120, shadowAgreementRate: 91.7)
        )
    }

    static func snapshot(for listing: MarketTrackedListing) -> MarketListingSnapshot {
        MarketListingSnapshot(
            id: listing.id, marketplace: listing.marketplace, listingId: listing.listingId, title: listing.title,
            price: listing.lastPrice, condition: "Used", location: "Warszawa", url: listing.url,
            description: "Sprzedam, stan bardzo dobry, komplet z pudełkiem. Odbiór osobisty lub wysyłka.",
            capturedAt: listing.lastSeenAt, images: []
        )
    }
}
