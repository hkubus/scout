import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Serves bundled fixtures instead of a real server. Used for the "Try demo
/// data" option, CI simulator screenshots, and tests. Triage and pause/resume
/// changes are kept in memory for the session.
public actor DemoTransport: HTTPTransport {
    public static let baseURL = URL(string: "https://demo.scout.invalid")!

    private var dashboard: DashboardData
    private var actions: [String: ListingAction] = [:]
    private var enabled: [String: Bool] = [:]
    private var marketWatches: [MarketWatch]
    private var marketListings: [MarketTrackedListing]
    private var ntfyOpenInApp = false
    private let encoder = JSONEncoder()

    public init(now: Date = Date()) {
        let dashboard = Self.dashboard(now: now)
        self.dashboard = dashboard
        marketWatches = DemoMarket.watches(now: now)
        marketListings = DemoMarket.listings(dashboard: dashboard, now: now)
    }

    /// Demo dashboard with timestamps moved so the newest listing is a minute
    /// old; the fixtures were captured at a fixed time.
    public static func dashboard(now: Date = Date()) -> DashboardData {
        var dashboard: DashboardData = fixture("dashboard")
        let newest = dashboard.listings.compactMap(\.observedDate).max() ?? now
        let offset = now.addingTimeInterval(-60).timeIntervalSince(newest)
        let formatter = ISO8601DateFormatter()
        func shifted(_ value: String?) -> String? {
            ScoutDate.parse(value).map { formatter.string(from: $0.addingTimeInterval(offset)) } ?? value
        }
        for index in dashboard.listings.indices {
            dashboard.listings[index].observedAt = shifted(dashboard.listings[index].observedAt) ?? ""
            dashboard.listings[index].aiDescriptionVerificationAt = shifted(dashboard.listings[index].aiDescriptionVerificationAt)
        }
        return dashboard
    }

    public static func fixture<T: Decodable>(_ name: String) -> T {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Demo"),
              let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode(T.self, from: data)
        else { fatalError("Demo fixture \(name).json is missing or invalid") }
        return value
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw ScoutAPIError.invalidResponse
        }
        let query = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, last in last })
        let segments = components.path.split(separator: "/").map(String.init)
        let method = request.httpMethod ?? "GET"
        // `/api/<collection>/<id>/...` routes are matched with the id replaced by `:id`.
        let collections: Set<String> = ["watches", "market-watches", "market-listings"]
        let watchID = segments.count >= 3 && segments[0] == "api" && collections.contains(segments[1]) ? segments[2] : nil
        let route = method + " /" + segments.enumerated().map { $0.offset == 2 && watchID != nil ? ":id" : $0.element }.joined(separator: "/")
        try await Task.sleep(nanoseconds: 150_000_000)

        switch route {
        case "GET /api/health":
            return try respond(Self.fixture("health") as Health)
        case "GET /api/ready":
            return try respond(Self.fixture("ready") as Readiness)
        case "GET /api/dashboard":
            var data = dashboard
            data.listings = data.listings.map(applyAction).filter { $0.hidden != true }
            data.watches = data.watches.map(applyEnabled)
            return try respond(data)
        case "GET /api/listings":
            return try respond(listingsPage(query))
        case "GET /api/watches":
            let includeArchived = query["includeArchived"] == "true"
            return try respond(["watches": dashboard.watches.map(applyEnabled).filter { includeArchived || !$0.isArchived }])
        case "POST /api/watches":
            let draft = try JSONDecoder().decode(WatchDraft.self, from: request.httpBody ?? Data())
            let watch = Self.watch(from: draft, id: "watch-\(UUID().uuidString.prefix(8).lowercased())")
            dashboard.watches.insert(watch, at: 0)
            return try respond(["watch": watch], status: 201)
        case "GET /api/watches/:id/analytics":
            var analytics: WatchAnalytics = Self.fixture("watch-analytics")
            if let watch = dashboard.watches.first(where: { $0.id == watchID }) {
                analytics.watchId = watch.id
                analytics.watchName = watch.name
            }
            return try respond(analytics)
        case "GET /api/listing-detail":
            guard let detail = listingDetail(key: query["key"] ?? "") else {
                return try respond(["error": "Listing detail is not available yet"], status: 404)
            }
            return try respond(detail)
        case "PATCH /api/listing-actions":
            let body = try JSONDecoder().decode(ActionBody.self, from: request.httpBody ?? Data())
            let action = ListingAction(decision: body.decision, note: body.note, hidden: body.hidden ?? false, updatedAt: ISO8601DateFormatter().string(from: Date()))
            actions[body.key] = action
            return try respond(["action": action])
        case "PATCH /api/watches/:id":
            guard let watchID, let index = dashboard.watches.firstIndex(where: { $0.id == watchID }) else {
                return try respond(["error": "Watch not found"], status: 404)
            }
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            apply(body, to: &dashboard.watches[index])
            return try respond(["ok": true])
        case "POST /api/search":
            let filters = try JSONDecoder().decode(SearchFilters.self, from: request.httpBody ?? Data())
            return try respond(search(filters))
        case "POST /api/scans":
            return try respond(ScanQueued(queued: false, message: "Demo mode — no scan was queued."))
        case "GET /api/analytics":
            let days = Int(query["days"] ?? "") ?? 30
            return try respond(DemoMarket.analytics(dashboard: dashboard, days: days, watchId: query["watchId"], marketplace: query["marketplace"].map(Marketplace.init(rawValue:))))
        case "GET /api/market-watches":
            let status = query["status"]
            let listings = marketListings.filter { listing in
                (query["watchId"].map { $0 == listing.marketWatchId } ?? true) && (status.map { $0 == listing.status } ?? true)
            }
            let active = marketListings.filter { $0.status == "active" }.count
            let aggregates = MarketResearchData.Aggregates(overallMedianPrice: 1890, endedCount: marketListings.count - active, activeCount: active, saleBand: marketWatches.first?.saleBand)
            return try respond(MarketResearchData(watches: marketWatches, listings: listings, aggregates: aggregates, pagination: Pagination(page: 1, pageSize: 50, total: listings.count, hasNext: false)))
        case "POST /api/market-watches":
            let draft = try JSONDecoder().decode(MarketWatchDraft.self, from: request.httpBody ?? Data()).normalized()
            let watch = MarketWatch(
                id: "market-\(UUID().uuidString.prefix(8).lowercased())", name: draft.name, query: draft.query, terms: draft.terms, excluded: draft.excluded,
                location: draft.location, condition: draft.condition, sources: draft.sources, intervalHours: draft.intervalHours,
                minPrice: draft.minPrice, maxPrice: draft.maxPrice, shippingOnly: draft.shippingOnly, typoVariants: draft.typoVariants,
                enabled: true, nextScan: "due now", lastScan: "Never", totalListings: 0, activeListings: 0, endedListings: 0,
                estimatedMedianPrice: nil, saleBand: nil, activeVersionId: nil
            )
            marketWatches.insert(watch, at: 0)
            return try respond(["watch": watch], status: 201)
        case "PATCH /api/market-watches/:id":
            guard let index = marketWatches.firstIndex(where: { $0.id == watchID }) else {
                return try respond(["error": "Market watch not found"], status: 404)
            }
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            if let value = body["enabled"] as? Bool { marketWatches[index].enabled = value }
            if body["query"] != nil {
                let draft = try JSONDecoder().decode(MarketWatchDraft.self, from: request.httpBody ?? Data())
                let current = marketWatches[index]
                marketWatches[index].name = draft.name
                marketWatches[index].query = draft.query
                marketWatches[index].terms = draft.terms
                marketWatches[index].excluded = draft.excluded
                marketWatches[index].location = draft.location
                marketWatches[index].condition = draft.condition
                marketWatches[index].sources = draft.sources
                marketWatches[index].intervalHours = draft.intervalHours
                marketWatches[index].minPrice = draft.minPrice
                marketWatches[index].maxPrice = draft.maxPrice
                marketWatches[index].shippingOnly = draft.shippingOnly
                marketWatches[index].typoVariants = draft.typoVariants
                marketWatches[index].enabled = current.enabled
            }
            return try respond(["ok": true])
        case "DELETE /api/market-watches/:id":
            marketWatches.removeAll { $0.id == watchID }
            marketListings.removeAll { $0.marketWatchId == watchID }
            return try respond(["ok": true])
        case "POST /api/market-watches/:id/scan":
            return try respond(ScanQueued(queued: false, message: "Demo mode — no scan was queued."), status: 202)
        case "GET /api/market-watches/:id/trend":
            guard let watch = marketWatches.first(where: { $0.id == watchID }) else {
                return try respond(["error": "Market watch not found"], status: 404)
            }
            return try respond(DemoMarket.trend(for: watch, days: Int(query["days"] ?? "") ?? 90))
        case "GET /api/market-listings/:id/history":
            guard let listing = marketListings.first(where: { String($0.id) == watchID }) else {
                return try respond(["error": "Listing not found"], status: 404)
            }
            let formatter = ISO8601DateFormatter()
            let start = ScoutDate.parse(listing.firstSeenAt) ?? Date()
            let points = (0..<listing.observations).map { step in
                let fraction = Double(step) / Double(max(1, listing.observations - 1))
                return PriceHistoryPoint(price: (listing.firstPrice + (listing.lastPrice - listing.firstPrice) * fraction).rounded(), observedAt: formatter.string(from: start.addingTimeInterval(Double(step) * 86_400)))
            }
            return try respond(["points": points])
        case "GET /api/market-listings/:id/snapshot", "POST /api/market-listings/:id/snapshot":
            guard let index = marketListings.firstIndex(where: { String($0.id) == watchID }) else {
                return try respond(["error": "Listing not found"], status: 404)
            }
            if method == "POST" { marketListings[index].snapshotStatus = "saved" }
            let saved = marketListings[index].snapshotStatus == "saved"
            return try respond(SnapshotBody(snapshot: saved ? DemoMarket.snapshot(for: marketListings[index]) : nil), status: method == "POST" ? 201 : 200)
        case "GET /api/settings":
            return try respond(ServerSettings(ntfy: ServerSettings.Ntfy(configured: true, minimumPriority: "exceptional", openInApp: ntfyOpenInApp)))
        case "PATCH /api/settings":
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            if let value = (body["ntfy"] as? [String: Any])?["openInApp"] as? Bool { ntfyOpenInApp = value }
            return try respond(ServerSettings(ntfy: ServerSettings.Ntfy(configured: true, minimumPriority: "exceptional", openInApp: ntfyOpenInApp)))
        case "GET /api/connectors":
            return try respond(["connectors": dashboard.connectors])
        default:
            return try respond(["error": "Not available in demo mode"], status: 404)
        }
    }

    private func listingsPage(_ query: [String: String]) -> ListingsPage {
        let search = (query["q"] ?? "").lowercased()
        var listings = dashboard.listings.map(applyAction).filter { listing in
            (query["watchId"].map { $0 == listing.watchId } ?? true)
                && (query["marketplace"].map { $0 == listing.marketplace.rawValue } ?? true)
                && (query["decision"].map { $0 == listing.decision?.rawValue } ?? true)
                && (search.isEmpty || listing.title.lowercased().contains(search))
        }
        switch query["visibility"] ?? "visible" {
        case "hidden": listings = listings.filter { $0.hidden == true }
        case "all": break
        default: listings = listings.filter { $0.hidden != true }
        }
        switch query["sort"] {
        case "strongest": listings.sort { $0.dealStrength > $1.dealStrength }
        case "price": listings.sort { $0.price < $1.price }
        default: listings.sort { $0.observedAt > $1.observedAt }
        }
        return ListingsPage(listings: listings, pagination: Pagination(page: 1, pageSize: 50, total: listings.count, hasNext: false))
    }

    private func search(_ filters: SearchFilters) -> ManualSearchResponse {
        let words = filters.query.lowercased().split(separator: " ")
        let matches = filters.page > 1 ? [] : dashboard.listings.filter { listing in
            filters.sources.contains(listing.marketplace)
                && words.contains { listing.title.lowercased().contains($0) }
                && (filters.minPrice.map { listing.price >= $0 } ?? true)
                && (filters.maxPrice.map { listing.price <= $0 } ?? true)
        }
        let results = matches.map { listing -> Listing in
            var result = listing
            result.typical = nil
            result.belowTypical = nil
            result.dealStrength = 1
            result.dealLabel = .watch
            result.watch = "Manual search"
            result.watchId = nil
            result.associationId = nil
            result.decision = nil
            return result
        }
        let sources = filters.sources.map { source -> SearchSourceStatus in
            let count = results.filter { $0.marketplace == source }.count
            return SearchSourceStatus(source: source, status: "ok", count: count, pendingShipping: 0, durationMs: 1200, message: count == 0 ? "No matching listings" : "\(count) matches")
        }
        return ManualSearchResponse(listings: results.sorted { $0.price < $1.price }, sources: sources)
    }

    private func listingDetail(key: String) -> ListingDetail? {
        guard let listing = dashboard.listings.first(where: { $0.key == key }).map(applyAction) else { return nil }
        let now = Date()
        let typical = listing.typical ?? listing.price
        let history = (0..<12).map { index -> PriceHistoryPoint in
            let date = now.addingTimeInterval(Double(index - 11) * 6 * 3600)
            let price = index < 11 ? (typical * 0.82).rounded() - Double(index * 10) : listing.price
            return PriceHistoryPoint(price: price, observedAt: ISO8601DateFormatter().string(from: date))
        }
        let snapshot = ListingDetailSnapshot(
            title: listing.title,
            price: listing.price,
            condition: listing.condition,
            location: listing.location,
            url: listing.url,
            description: "\(listing.subtitle). Sprzedaję, bo przesiadłem się na nowszy model. Działa bez zarzutu, bez rys. Odbiór osobisty lub wysyłka OLX.",
            capturedAt: listing.observedAt,
            verificationStatus: listing.aiDescriptionVerificationStatus
        )
        let action = actions[key] ?? ListingAction(decision: listing.decision, note: listing.note ?? "", hidden: listing.hidden ?? false)
        return ListingDetail(
            listing: listing,
            history: history,
            action: action,
            descriptionSnapshot: snapshot,
            firstSeenAt: history.first?.observedAt ?? listing.observedAt,
            lastSeenAt: listing.observedAt,
            verificationModel: listing.aiDescriptionVerification == nil ? nil : "deepseek-v4-flash",
            variantGroups: nil
        )
    }

    static func watch(from draft: WatchDraft, id: String) -> Watch {
        let draft = draft.normalized()
        return Watch(
            id: id, name: draft.name, query: draft.query, terms: draft.terms, excluded: draft.excluded,
            sources: draft.sources, location: draft.location, condition: draft.condition,
            samples: 0, targetSamples: 30, observationHours: 0, readiness: 0, status: "Learning",
            interval: Double(draft.interval), sourceIntervals: [:], nextScan: "due now", enabled: true,
            exactUrls: [], sensitivity: draft.sensitivity, shippingOnly: draft.shippingOnly,
            typoVariants: draft.typoVariants, aiRelevance: draft.aiRelevance, variantGroups: [], variants: [],
            dealCounts: WatchDealCounts(exceptional: 0, veryStrong: 0, strong: 0), referenceMarketWatchId: nil,
            minPrice: draft.minPrice, maxPrice: draft.maxPrice, archivedAt: nil
        )
    }

    /// Applies a PATCH body the way the server does: only keys that are present.
    private func apply(_ body: [String: Any], to watch: inout Watch) {
        if let value = body["name"] as? String { watch.name = value }
        if let value = body["query"] as? String { watch.query = value }
        if let value = body["terms"] as? String { watch.terms = value }
        if let value = body["excluded"] as? String { watch.excluded = value }
        if let value = body["sources"] as? [String] { watch.sources = value.map(Marketplace.init(rawValue:)) }
        if let value = body["location"] as? String { watch.location = value }
        if let value = body["condition"] as? String { watch.condition = value }
        if let value = body["interval"] as? Double { watch.interval = value }
        if body.keys.contains("minPrice") { watch.minPrice = body["minPrice"] as? Double }
        if body.keys.contains("maxPrice") { watch.maxPrice = body["maxPrice"] as? Double }
        if let value = body["shippingOnly"] as? Bool { watch.shippingOnly = value }
        if let value = body["typoVariants"] as? Bool { watch.typoVariants = value }
        if let value = body["aiRelevance"] as? Bool { watch.aiRelevance = value }
        if let value = body["sensitivity"] as? Double { watch.sensitivity = value }
        if let value = body["enabled"] as? Bool { enabled[watch.id] = value }
        if let value = body["archived"] as? Bool {
            watch.archivedAt = value ? ISO8601DateFormatter().string(from: Date()) : nil
            watch.status = value ? "Archived" : (watch.readiness >= 100 ? "Ready" : "Learning")
        }
    }

    private func applyAction(_ listing: Listing) -> Listing {
        guard let action = actions[listing.key] else { return listing }
        var listing = listing
        listing.decision = action.decision
        listing.note = action.note
        listing.hidden = action.hidden
        return listing
    }

    private func applyEnabled(_ watch: Watch) -> Watch {
        guard let value = enabled[watch.id], !watch.isArchived else { return watch }
        var watch = watch
        watch.enabled = value
        watch.status = value ? (watch.readiness >= 100 ? "Ready" : "Learning") : "Paused"
        return watch
    }

    private func respond(_ value: some Encodable, status: Int = 200) throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(url: Self.baseURL, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        return (try encoder.encode(value), response)
    }

    private struct SnapshotBody: Encodable {
        var snapshot: MarketListingSnapshot?

        // The server sends `"snapshot": null` rather than omitting the key.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(snapshot, forKey: .snapshot)
        }

        private enum CodingKeys: String, CodingKey { case snapshot }
    }

    private struct ActionBody: Decodable {
        var key: String
        var decision: ListingDecision?
        var note: String
        var hidden: Bool?
    }
}
