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
    private let encoder = JSONEncoder()

    public init() {
        dashboard = Self.fixture("dashboard")
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
        // `/api/watches/<id>/...` routes are matched with the id replaced by `:id`.
        let watchID = segments.count >= 3 && segments[0] == "api" && segments[1] == "watches" ? segments[2] : nil
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
            return try respond(["watches": dashboard.watches.map(applyEnabled)])
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
            let patch = try JSONDecoder().decode(WatchPatch.self, from: request.httpBody ?? Data())
            if let watchID, let value = patch.enabled { enabled[watchID] = value }
            return try respond(["ok": true])
        case "POST /api/scans":
            return try respond(ScanQueued(queued: false, message: "Demo mode — no scan was queued."))
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

    private func applyAction(_ listing: Listing) -> Listing {
        guard let action = actions[listing.key] else { return listing }
        var listing = listing
        listing.decision = action.decision
        listing.note = action.note
        listing.hidden = action.hidden
        return listing
    }

    private func applyEnabled(_ watch: Watch) -> Watch {
        guard let value = enabled[watch.id] else { return watch }
        var watch = watch
        watch.enabled = value
        watch.status = value ? (watch.readiness >= 100 ? "Ready" : "Learning") : "Paused"
        return watch
    }

    private func respond(_ value: some Encodable, status: Int = 200) throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(url: Self.baseURL, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        return (try encoder.encode(value), response)
    }

    private struct ActionBody: Decodable {
        var key: String
        var decision: ListingDecision?
        var note: String
        var hidden: Bool?
    }
}
