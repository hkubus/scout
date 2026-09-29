import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ServerSentEvent: Equatable, Sendable {
    public var event: String
    public var data: String
    public var id: String?

    public init(event: String, data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Incremental `text/event-stream` parser fed one byte at a time. It does its
/// own line splitting because `AsyncBytes.lines` drops the blank lines that
/// terminate each event.
public struct ServerSentEventParser: Sendable {
    private var line: [UInt8] = []
    private var lastByteWasCR = false
    private var eventName = ""
    private var dataLines: [String] = []
    private var lastEventID: String?

    public init() {}

    public mutating func push(_ byte: UInt8) -> ServerSentEvent? {
        switch byte {
        case UInt8(ascii: "\n"):
            if lastByteWasCR {
                lastByteWasCR = false
                return nil
            }
            return finishLine()
        case UInt8(ascii: "\r"):
            lastByteWasCR = true
            return finishLine()
        default:
            lastByteWasCR = false
            line.append(byte)
            return nil
        }
    }

    public mutating func push(_ bytes: some Sequence<UInt8>) -> [ServerSentEvent] {
        bytes.compactMap { push($0) }
    }

    private mutating func finishLine() -> ServerSentEvent? {
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        if text.isEmpty { return dispatch() }
        if text.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        case "id": lastEventID = String(value)
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> ServerSentEvent? {
        defer {
            eventName = ""
            dataLines = []
        }
        guard !dataLines.isEmpty else { return nil }
        return ServerSentEvent(event: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"), id: lastEventID)
    }
}

#if canImport(Darwin)
extension ScoutClient {
    /// Streams `/events` until the connection drops or the task is cancelled.
    /// Callers own reconnection; the server does not replay missed events.
    public func events(session: URLSession = .shared) -> AsyncThrowingStream<ServerSentEvent, Error> {
        var request = URLRequest(url: eventsURL, timeoutInterval: 90) // server pings every 25s
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return AsyncThrowingStream { continuation in
            let task = Task { [request] in
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                        throw ScoutAPIError.invalidResponse
                    }
                    var parser = ServerSentEventParser()
                    for try await byte in bytes {
                        if let event = parser.push(byte) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
#endif
