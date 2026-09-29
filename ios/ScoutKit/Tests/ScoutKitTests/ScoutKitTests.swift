import Foundation
import XCTest
@testable import ScoutKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class ServerAddressTests: XCTestCase {
    func testAddsHTTPSAndDropsTrailingSlash() throws {
        XCTAssertEqual(try ServerAddress.normalize("  Scout.LAN:3001/ ").absoluteString, "https://scout.lan:3001")
    }

    func testKeepsExplicitHTTPAndPathPrefix() throws {
        XCTAssertEqual(try ServerAddress.normalize("http://100.64.0.2:3001/scout//").absoluteString, "http://100.64.0.2:3001/scout")
    }

    func testRejectsUnsupportedInput() {
        XCTAssertThrowsError(try ServerAddress.normalize("")) { XCTAssertEqual($0 as? ServerAddressError, .empty) }
        XCTAssertThrowsError(try ServerAddress.normalize("ftp://scout.lan")) { XCTAssertEqual($0 as? ServerAddressError, .unsupportedScheme) }
        XCTAssertThrowsError(try ServerAddress.normalize("https://me:pw@scout.lan")) { XCTAssertEqual($0 as? ServerAddressError, .credentialsNotAllowed) }
        XCTAssertThrowsError(try ServerAddress.normalize("https://scout.lan/?x=1")) { XCTAssertEqual($0 as? ServerAddressError, .queryNotAllowed) }
    }
}

final class ScoutDateTests: XCTestCase {
    func testParsesServerTimestampShapes() throws {
        let expected = Date(timeIntervalSince1970: 1_790_757_000)
        XCTAssertEqual(ScoutDate.parse("2026-09-30T08:30:00.000Z"), expected)
        XCTAssertEqual(ScoutDate.parse("2026-09-30T08:30:00Z"), expected)
        XCTAssertEqual(ScoutDate.parse("2026-09-30 08:30:00"), expected)
        let day = try XCTUnwrap(ScoutDate.parse("2026-09-30"))
        XCTAssertEqual(Calendar.current.dateComponents([.year, .month, .day, .hour], from: day), DateComponents(year: 2026, month: 9, day: 30, hour: 0))
        XCTAssertNil(ScoutDate.parse("10:24:18"))
        XCTAssertNil(ScoutDate.parse(nil))
    }
}

final class ServerSentEventParserTests: XCTestCase {
    func testParsesNamedEventsAcrossLineEndings() {
        var parser = ServerSentEventParser()
        let stream = "event: ready\ndata: {\"now\":\"x\"}\n\n: comment\r\nevent: scan\r\ndata: a\r\ndata:b\r\n\r\ndata: plain\n\n"
        let events = parser.push(Array(stream.utf8))
        XCTAssertEqual(events, [
            ServerSentEvent(event: "ready", data: "{\"now\":\"x\"}"),
            ServerSentEvent(event: "scan", data: "a\nb"),
            ServerSentEvent(event: "message", data: "plain"),
        ])
    }

    func testIgnoresEventsWithoutData() {
        var parser = ServerSentEventParser()
        XCTAssertEqual(parser.push(Array("event: ping\n\n".utf8)), [])
    }
}

final class ClientTests: XCTestCase {
    func testBuildsPathsUnderAProxyPrefixAndEscapesQueries() {
        let client = ScoutClient(baseURL: URL(string: "https://host/scout")!)
        let url = client.url("/api/listing-detail", query: [URLQueryItem(name: "key", value: "Allegro Lokalnie:a+b")])
        XCTAssertEqual(url.absoluteString, "https://host/scout/api/listing-detail?key=Allegro%20Lokalnie:a%2Bb")
    }

    func testListingsQueryItems() {
        let query = ListingsQuery(page: 2, marketplace: .vinted, search: "  xm5 ", watchId: "w1", sort: .strongest, decision: .buy)
        let items = Dictionary(uniqueKeysWithValues: query.queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items, ["page": "2", "pageSize": "50", "sort": "strongest", "visibility": "visible", "marketplace": "Vinted", "q": "xm5", "watchId": "w1", "decision": "buy"])
    }

    func testMapsServerErrors() async {
        let client = ScoutClient(baseURL: URL(string: "https://host")!, transport: StubTransport(status: 404, body: #"{"error":"Listing detail is not available yet"}"#))
        do {
            _ = try await client.listingDetail(key: "OLX:1")
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? ScoutAPIError, .server(status: 404, message: "Listing detail is not available yet"))
        }
    }

    func testReadinessAccepts503Body() async throws {
        let client = ScoutClient(baseURL: URL(string: "https://host")!, transport: StubTransport(status: 503, body: #"{"status":"degraded","connectors":{"degraded":["OLX"],"degradedCount":1}}"#))
        let readiness = try await client.readiness()
        XCTAssertFalse(readiness.isReady)
        XCTAssertEqual(readiness.connectors?.degraded, ["OLX"])
    }

    func testDecodesWatchesFromARealServerResponse() async throws {
        // Captured from `GET /api/watches` on a fresh database.
        let json = #"{"watches":[{"id":"watch-deck","name":"Steam Deck OLED 512GB","query":"steam deck oled 512gb","terms":"oled, 512gb","excluded":"broken, parts","sources":["OLX","Allegro Lokalnie"],"location":"Polska","condition":"Any","samples":0,"targetSamples":30,"observationHours":0,"readiness":0,"status":"Learning","interval":5,"sourceIntervals":{},"nextScan":"in 30m","enabled":true,"exactUrls":[],"sensitivity":1,"shippingOnly":false,"typoVariants":false,"aiRelevance":true,"referenceMarketWatchId":null,"variantGroups":[],"variants":[],"dealCounts":{"exceptional":0,"veryStrong":0,"strong":0},"minPrice":null,"maxPrice":null,"archivedAt":null}]}"#
        let client = ScoutClient(baseURL: URL(string: "https://host")!, transport: StubTransport(status: 200, body: json))
        let watches = try await client.watches()
        XCTAssertEqual(watches.first?.sources, [.olx, .allegroLokalnie])
        XCTAssertEqual(watches.first?.isArchived, false)
    }

    func testReportsTheMissingFieldWhenDecodingFails() async {
        let client = ScoutClient(baseURL: URL(string: "https://host")!, transport: StubTransport(status: 200, body: #"{"watches":[{"id":"w"}]}"#))
        do {
            _ = try await client.watches()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? ScoutAPIError, .decoding("missing watches.0.name"))
        }
    }
}

final class DemoTransportTests: XCTestCase {
    private let client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())

    func testServesEveryScreen() async throws {
        let dashboard = try await client.dashboard()
        XCTAssertEqual(dashboard.listings.count, 6)
        XCTAssertNotNil(dashboard.listings.first?.observedDate)
        let watches = try await client.watches()
        XCTAssertEqual(watches.count, 5)
        let analytics = try await client.watchAnalytics(id: watches[2].id)
        XCTAssertEqual(analytics.watchName, watches[2].name)
        XCTAssertEqual(analytics.points.count, 30)
        let detail = try await client.listingDetail(key: dashboard.listings[0].key)
        XCTAssertEqual(detail.history.last?.price, dashboard.listings[0].price)
        _ = try await client.health()
        let readiness = try await client.readiness()
        XCTAssertTrue(readiness.isReady)
        let connectors = try await client.connectors()
        XCTAssertEqual(connectors.count, 4)
    }

    func testRemembersTriageAndPauseForTheSession() async throws {
        let listing = try await client.dashboard().listings[0]
        _ = try await client.updateListingAction(key: listing.key, action: ListingAction(decision: .buy, note: "offer 1700", hidden: false))
        let bought = try await client.listings(ListingsQuery(decision: .buy))
        XCTAssertEqual(bought.listings.map(\.key), [listing.key])

        _ = try await client.updateListingAction(key: listing.key, action: ListingAction(decision: nil, note: "", hidden: true))
        let dashboard = try await client.dashboard()
        XCTAssertFalse(dashboard.listings.contains { $0.key == listing.key })
        let hidden = try await client.listings(ListingsQuery(visibility: .hidden))
        XCTAssertEqual(hidden.listings.count, 1)

        try await client.updateWatch(id: "watch-lego", patch: WatchPatch(enabled: false))
        let watches = try await client.watches()
        XCTAssertEqual(watches.first { $0.id == "watch-lego" }?.status, "Paused")
    }
}

private struct StubTransport: HTTPTransport {
    var status: Int
    var body: String

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
