import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum ScoutAPIError: Error, Equatable, LocalizedError {
    /// The server answered with a non-2xx status and, usually, `{ "error": "..." }`.
    case server(status: Int, message: String)
    case invalidResponse
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case let .server(status, message): status == 429 ? "Scout is rate limiting requests. Try again in a minute." : message
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
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ScoutAPIError.invalidResponse }
        return (data, http)
    }
}

/// Typed client for the Scout REST API. Paths match `src/api.ts`.
public struct ScoutClient: Sendable {
    public let baseURL: URL
    private let transport: HTTPTransport

    public init(baseURL: URL, transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.transport = transport
    }

    public func health() async throws -> Health {
        try await get("/api/health", timeout: 8)
    }

    /// `/api/ready` answers 503 with the same body when not ready, so both are decoded.
    public func readiness() async throws -> Readiness {
        let (data, response) = try await transport.send(request("/api/ready", timeout: 8))
        guard response.statusCode == 200 || response.statusCode == 503 else { throw Self.error(from: data, response) }
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

    public func updateWatch(id: String, patch: WatchPatch) async throws {
        let _: OkResponse = try await send("PATCH", "/api/watches/\(Self.pathSegment(id))", body: patch)
    }

    public func queueScan(watchId: String? = nil) async throws -> ScanQueued {
        try await send("POST", "/api/scans", body: ScanBody(watchId: watchId))
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
        guard (200..<300).contains(response.statusCode) else { throw Self.error(from: data, response) }
        return try Self.decode(data)
    }

    private func send<Body: Encodable, T: Decodable>(_ method: String, _ path: String, body: Body) async throws -> T {
        var request = request(path, timeout: 30)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else { throw Self.error(from: data, response) }
        return try Self.decode(data)
    }

    private func request(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval) -> URLRequest {
        var request = URLRequest(url: url(path, query: query), timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
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

    private static func error(from data: Data, _ response: HTTPURLResponse) -> ScoutAPIError {
        let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
        return .server(status: response.statusCode, message: message ?? "Request failed (\(response.statusCode))")
    }
}

private struct ErrorResponse: Decodable { var error: String }
private struct OkResponse: Decodable { var ok: Bool }
private struct WatchesResponse: Decodable { var watches: [Watch] }
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
