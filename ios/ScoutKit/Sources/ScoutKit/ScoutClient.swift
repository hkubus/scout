import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum ScoutAPIError: Error, Equatable, LocalizedError {
    /// The server answered with a non-2xx status and, usually, `{ "error": "..." }`.
    case server(status: Int, message: String)
    /// 401: the server has sign-in enabled and the API token is missing or wrong.
    case unauthorized(tokenProvided: Bool)
    case invalidResponse
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case let .server(status, message): status == 429 ? "Scout is rate limiting requests. Try again in a minute." : message
        case let .unauthorized(tokenProvided): tokenProvided
            ? "The server rejected this API token. Check it against SCOUT_API_TOKENS on the server."
            : "This Scout server requires sign-in. Add one of its SCOUT_API_TOKENS as the API token."
        case .invalidResponse: "The server returned an unexpected response."
        case let .decoding(detail): "Couldn't read the server's response (\(detail))."
        }
    }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request, delegate: RedirectGuard.shared)
        guard let http = response as? HTTPURLResponse else { throw ScoutAPIError.invalidResponse }
        return (data, http)
    }
}

/// Keeps the API token on the server it was meant for: URLSession copies the
/// `Authorization` header onto redirects, so it is dropped when a redirect
/// leaves the original request's origin.
public final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    public static let shared = RedirectGuard()

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(Self.redirect(request, from: task.originalRequest?.url))
    }

    /// The redirected request, without `Authorization` unless it may be forwarded.
    public static func redirect(_ request: URLRequest, from original: URL?) -> URLRequest {
        guard request.value(forHTTPHeaderField: "Authorization") != nil,
              !mayForwardCredentials(from: original, to: request.url)
        else { return request }
        var stripped = request
        stripped.setValue(nil, forHTTPHeaderField: "Authorization")
        return stripped
    }

    /// Same scheme, host, and port, or an http → https upgrade on the same host.
    public static func mayForwardCredentials(from original: URL?, to target: URL?) -> Bool {
        guard let from = original.flatMap(Origin.init), let to = target.flatMap(Origin.init) else { return false }
        if from == to { return true }
        return from.host == to.host && from.scheme == "http" && to.scheme == "https" && to.port == 443
    }

    private struct Origin: Equatable {
        var scheme: String
        var host: String
        var port: Int

        init?(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
            guard let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : nil) else { return nil }
            self.scheme = scheme
            self.host = host
            self.port = port
        }
    }
}

/// Typed client for the Scout REST API. Paths match `src/api.ts`.
public struct ScoutClient: Sendable {
    public let baseURL: URL
    /// Bearer token from the server's `SCOUT_API_TOKENS`, sent on every request.
    public let apiToken: String?
    private let transport: HTTPTransport

    public init(baseURL: URL, apiToken: String? = nil, transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        let trimmed = apiToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.apiToken = trimmed.isEmpty ? nil : trimmed
        self.transport = transport
    }

    /// Checks that the server is reachable and accepts this client's
    /// credentials. Servers without sign-in support answer 404 for the session
    /// endpoint, so those fall back to the health check.
    public func verifyAccess() async throws {
        let session: AuthSession
        do {
            session = try await get("/api/auth/session", timeout: 8)
        } catch let ScoutAPIError.server(status, _) where status == 404 {
            _ = try await health()
            return
        }
        if session.authEnabled && !session.authenticated {
            throw ScoutAPIError.unauthorized(tokenProvided: apiToken != nil)
        }
    }

    public func health() async throws -> Health {
        try await get("/api/health", timeout: 8)
    }

    /// `/api/ready` answers 503 with the same body when not ready, so both are decoded.
    public func readiness() async throws -> Readiness {
        let (data, response) = try await transport.send(request("/api/ready", timeout: 8))
        guard response.statusCode == 200 || response.statusCode == 503 else { throw error(from: data, response) }
        return try Self.decode(data)
    }

    public func dashboard() async throws -> DashboardData {
        try await get("/api/dashboard")
    }

    public func listings(_ query: ListingsQuery) async throws -> ListingsPage {
        try await get("/api/listings", query: query.queryItems)
    }

    public func watches(includeArchived: Bool = false) async throws -> [Watch] {
        let response: WatchesResponse = try await get("/api/watches", query: [URLQueryItem(name: "includeArchived", value: includeArchived ? "true" : "false")])
        return response.watches
    }

    public func watchAnalytics(id: String, days: Int = 30) async throws -> WatchAnalytics {
        try await get("/api/watches/\(Self.pathSegment(id))/analytics", query: [URLQueryItem(name: "days", value: String(days))])
    }

    public func listingDetail(key: String, watchId: String? = nil) async throws -> ListingDetail {
        var query = [URLQueryItem(name: "key", value: key)]
        if let watchId { query.append(URLQueryItem(name: "watchId", value: watchId)) }
        return try await get("/api/listing-detail", query: query)
    }

    public func updateListingAction(key: String, action: ListingAction) async throws -> ListingAction {
        let body = ListingActionBody(key: key, decision: action.decision, note: action.note, hidden: action.hidden)
        let response: ListingActionResponse = try await send("PATCH", "/api/listing-actions", body: body)
        return response.action
    }

    /// Sends only the given fields; the server keeps the rest (for example the note).
    /// Pass `decision: .some(nil)` to clear the decision; leave it out to keep it.
    public func patchListingAction(key: String, decision: ListingDecision?? = .none, hidden: Bool? = nil) async throws -> ListingAction {
        let body = ListingActionPatchBody(key: key, decision: decision, hidden: hidden)
        let response: ListingActionResponse = try await send("PATCH", "/api/listing-actions", body: body)
        return response.action
    }

    public func createWatch(_ draft: WatchDraft) async throws -> Watch {
        let response: WatchResponse = try await send("POST", "/api/watches", body: draft.normalized())
        return response.watch
    }

    /// Saves the draft's fields; settings the draft doesn't cover are untouched.
    public func updateWatch(id: String, draft: WatchDraft) async throws {
        let _: OkResponse = try await send("PATCH", "/api/watches/\(Self.pathSegment(id))", body: draft.normalized())
    }

    public func updateWatch(id: String, patch: WatchPatch) async throws {
        let _: OkResponse = try await send("PATCH", "/api/watches/\(Self.pathSegment(id))", body: patch)
    }

    public func queueScan(watchId: String? = nil) async throws -> ScanQueued {
        try await send("POST", "/api/scans", body: ScanBody(watchId: watchId))
    }

    /// Live marketplace search; slow sources can take most of a minute.
    public func search(_ filters: SearchFilters) async throws -> ManualSearchResponse {
        try await send("POST", "/api/search", body: filters.normalized(), timeout: 90)
    }

    // MARK: Analytics and market research

    public func analytics(days: Int = 30, watchId: String? = nil, marketplace: Marketplace? = nil) async throws -> AnalyticsData {
        var query = [URLQueryItem(name: "days", value: String(days))]
        if let watchId { query.append(URLQueryItem(name: "watchId", value: watchId)) }
        if let marketplace { query.append(URLQueryItem(name: "marketplace", value: marketplace.rawValue)) }
        return try await get("/api/analytics", query: query)
    }

    public func marketResearch(page: Int = 1, pageSize: Int = 50, watchId: String? = nil, status: MarketListingStatus? = nil) async throws -> MarketResearchData {
        var query = [URLQueryItem(name: "page", value: String(page)), URLQueryItem(name: "pageSize", value: String(pageSize))]
        if let watchId { query.append(URLQueryItem(name: "watchId", value: watchId)) }
        if let status { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        return try await get("/api/market-watches", query: query)
    }

    public func createMarketWatch(_ draft: MarketWatchDraft) async throws -> MarketWatch {
        let response: MarketWatchResponse = try await send("POST", "/api/market-watches", body: draft.normalized())
        return response.watch
    }

    /// Sends only the fields that differ from `original`: any criteria field
    /// in the body starts a new comparable series on the server.
    public func updateMarketWatch(id: String, draft: MarketWatchDraft, original: MarketWatchDraft) async throws {
        var patch = draft.patch(from: original)
        // The server rejects an empty body; resending the name changes nothing.
        if patch.isEmpty { patch.name = draft.normalized().name }
        try await updateMarketWatch(id: id, patch: patch)
    }

    public func updateMarketWatch(id: String, patch: MarketWatchPatch) async throws {
        let _: OkResponse = try await send("PATCH", "/api/market-watches/\(Self.pathSegment(id))", body: patch)
    }

    public func setMarketWatchEnabled(id: String, enabled: Bool) async throws {
        let _: OkResponse = try await send("PATCH", "/api/market-watches/\(Self.pathSegment(id))", body: ["enabled": enabled])
    }

    public func deleteMarketWatch(id: String) async throws {
        let _: OkResponse = try await send("DELETE", "/api/market-watches/\(Self.pathSegment(id))", body: EmptyBody())
    }

    public func scanMarketWatch(id: String) async throws -> ScanQueued {
        try await send("POST", "/api/market-watches/\(Self.pathSegment(id))/scan", body: EmptyBody())
    }

    public func marketWatchTrend(id: String, days: Int = 90) async throws -> MarketWatchTrend {
        try await get("/api/market-watches/\(Self.pathSegment(id))/trend", query: [URLQueryItem(name: "days", value: String(days))])
    }

    public func marketListingHistory(id: Int) async throws -> [PriceHistoryPoint] {
        let response: PointsResponse = try await get("/api/market-listings/\(id)/history")
        return response.points
    }

    public func marketListingSnapshot(id: Int) async throws -> MarketListingSnapshot? {
        let response: SnapshotResponse = try await get("/api/market-listings/\(id)/snapshot")
        return response.snapshot
    }

    /// Fetches and stores a copy of the listing page now; can take a while.
    public func captureMarketListingSnapshot(id: Int) async throws -> MarketListingSnapshot? {
        let response: SnapshotResponse = try await send("POST", "/api/market-listings/\(id)/snapshot", body: EmptyBody(), timeout: 60)
        return response.snapshot
    }

    public func marketSnapshotImageURL(imageId: Int) -> URL {
        url("/api/market-snapshot-images/\(imageId)", query: [])
    }

    /// Downloads a file Scout serves itself, such as a saved listing photo,
    /// with the API token. Refuses other hosts so the token never leaks.
    public func serverData(_ url: URL, timeout: TimeInterval = 30) async throws -> Data {
        guard url.absoluteString.hasPrefix(baseURL.absoluteString + "/") else { throw ScoutAPIError.invalidResponse }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        authorize(&request)
        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else { throw error(from: data, response) }
        return data
    }

    // MARK: Settings

    public func settings() async throws -> ServerSettings {
        try await get("/api/settings")
    }

    /// Makes ntfy alerts open this app (`scout://`) instead of the marketplace page.
    public func setNtfyOpenInApp(_ enabled: Bool) async throws -> ServerSettings {
        try await send("PATCH", "/api/settings", body: ["ntfy": ["openInApp": enabled]])
    }

    public func connectors() async throws -> [Connector] {
        let response: ConnectorsResponse = try await get("/api/connectors")
        return response.connectors
    }

    /// URL of the live update stream; consumed with `ServerSentEventParser`.
    public var eventsURL: URL { url("/events", query: []) }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 20) async throws -> T {
        let (data, response) = try await transport.send(request(path, query: query, timeout: timeout))
        guard (200..<300).contains(response.statusCode) else { throw error(from: data, response) }
        return try Self.decode(data)
    }

    private func send<Body: Encodable, T: Decodable>(_ method: String, _ path: String, body: Body, timeout: TimeInterval = 30) async throws -> T {
        var request = request(path, timeout: timeout)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else { throw error(from: data, response) }
        return try Self.decode(data)
    }

    private func request(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(url: url(path, query: query), timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        authorize(&request)
        return request
    }

    func authorize(_ request: inout URLRequest) {
        if let apiToken { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
    }

    func url(_ path: String, query: [URLQueryItem]) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = components.percentEncodedPath + path
        components.queryItems = query.isEmpty ? nil : query
        // URLComponents leaves `+` unescaped, which servers read as a space.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url!
    }

    private static func pathSegment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    static func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch let DecodingError.keyNotFound(key, context) {
            throw ScoutAPIError.decoding("missing \(Self.describe(context.codingPath + [key]))")
        } catch let DecodingError.typeMismatch(_, context), let DecodingError.valueNotFound(_, context) {
            throw ScoutAPIError.decoding("unexpected value at \(Self.describe(context.codingPath))")
        } catch {
            throw ScoutAPIError.decoding("invalid JSON")
        }
    }

    private static func describe(_ path: [CodingKey]) -> String {
        path.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
    }

    private func error(from data: Data, _ response: HTTPURLResponse) -> ScoutAPIError {
        if response.statusCode == 401 { return .unauthorized(tokenProvided: apiToken != nil) }
        let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
        return .server(status: response.statusCode, message: message ?? "Request failed (\(response.statusCode))")
    }
}

private struct ErrorResponse: Decodable { var error: String }
private struct OkResponse: Decodable { var ok: Bool }
private struct AuthSession: Decodable { var authEnabled: Bool; var authenticated: Bool }
private struct WatchesResponse: Decodable { var watches: [Watch] }
private struct WatchResponse: Decodable { var watch: Watch }
private struct MarketWatchResponse: Decodable { var watch: MarketWatch }
private struct PointsResponse: Decodable { var points: [PriceHistoryPoint] }
private struct SnapshotResponse: Decodable { var snapshot: MarketListingSnapshot? }
private struct EmptyBody: Encodable {}
private struct ConnectorsResponse: Decodable { var connectors: [Connector] }
private struct ListingActionResponse: Decodable { var action: ListingAction }
private struct ScanBody: Encodable { var watchId: String? }

private struct ListingActionBody: Encodable {
    var key: String
    var decision: ListingDecision?
    var note: String
    var hidden: Bool

    // The server requires `decision` to be present, so `nil` is sent as JSON null.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(key, forKey: .key)
        try container.encode(decision, forKey: .decision)
        try container.encode(note, forKey: .note)
        try container.encode(hidden, forKey: .hidden)
    }

    private enum CodingKeys: String, CodingKey { case key, decision, note, hidden }
}

private struct ListingActionPatchBody: Encodable {
    var key: String
    var decision: ListingDecision??
    var hidden: Bool?

    // Omitted keys keep their stored value; `.some(nil)` sends JSON null to clear the decision.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(key, forKey: .key)
        if case .some(let value) = decision { try container.encode(value, forKey: .decision) }
        try container.encodeIfPresent(hidden, forKey: .hidden)
    }

    private enum CodingKeys: String, CodingKey { case key, decision, hidden }
}
