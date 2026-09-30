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

    func testParsesMillisecondsOffsetsAndRejectsGarbage() throws {
        // Fractional seconds can come back a few ulps off, so compare within a millisecond.
        let millis = try XCTUnwrap(ScoutDate.parse("2026-09-30T08:30:00.123Z"))
        XCTAssertEqual(millis.timeIntervalSince1970, 1_790_757_000.123, accuracy: 0.001)
        let offset = try XCTUnwrap(ScoutDate.parse("2026-09-30T10:30:00.500+02:00"))
        XCTAssertEqual(offset.timeIntervalSince1970, 1_790_757_000.5, accuracy: 0.001)
        XCTAssertEqual(ScoutDate.parse("2026-09-30T10:30:00+02:00"), Date(timeIntervalSince1970: 1_790_757_000))
        XCTAssertEqual(ScoutDate.parse(" 2026-09-30T08:30:00Z "), Date(timeIntervalSince1970: 1_790_757_000))
        XCTAssertNil(ScoutDate.parse("garbage"))
        XCTAssertNil(ScoutDate.parse(""))
        XCTAssertNil(ScoutDate.parse("2026-09-30 08:30"))
    }

    func testParsesConcurrently() async {
        let dates = await withTaskGroup(of: Date?.self) { group in
            for _ in 0..<50 { group.addTask { ScoutDate.parse("2026-09-30T08:30:00.000Z") } }
            return await group.reduce(into: [Date?]()) { $0.append($1) }
        }
        XCTAssertEqual(Set(dates), [Date(timeIntervalSince1970: 1_790_757_000)])
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

    func testDashboardAsksForTheTopListingsOnlyWhenTold() async throws {
        let requests = RequestLog()
        let client = ScoutClient(baseURL: URL(string: "https://host/scout")!, transport: RoutingTransport { request in
            requests.append(request)
            return (200, #"{"listings":[],"watches":[],"connectors":[],"stats":{"watching":1,"newToday":2,"strongDeals":3},"lastScan":"just now","lastScanTime":"10:00"}"#)
        })
        _ = try await client.dashboard()
        _ = try await client.dashboard(top: 12, timeout: 10)
        XCTAssertEqual(requests.all.map { $0.url?.absoluteString }, ["https://host/scout/api/dashboard", "https://host/scout/api/dashboard?top=12"])
        XCTAssertEqual(requests.all.map(\.timeoutInterval), [20, 10])
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
        let newest = try XCTUnwrap(dashboard.listings.compactMap(\.observedDate).max())
        XCTAssertEqual(newest.timeIntervalSinceNow, -60, accuracy: 5)
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
        // A hide-only patch keeps the decision and note.
        let hiddenOnly = try await client.patchListingAction(key: listing.key, hidden: true)
        XCTAssertEqual(hiddenOnly.decision, .buy)
        XCTAssertEqual(hiddenOnly.note, "offer 1700")

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

final class SearchTests: XCTestCase {
    func testValidatesLikeTheServer() {
        XCTAssertFalse(SearchFilters(query: "  ").canSearch)
        XCTAssertFalse(SearchFilters(query: "xm5", sources: []).canSearch)
        XCTAssertFalse(SearchFilters(query: "xm5", minPrice: 500, maxPrice: 400).canSearch)
        XCTAssertFalse(SearchFilters(query: "xm5", maxPrice: 0).canSearch)
        XCTAssertTrue(SearchFilters(query: "xm5", minPrice: 0, maxPrice: 400).canSearch)
    }

    func testEncodesTheServerBody() throws {
        let filters = SearchFilters(query: " sony xm5 ", sources: [.olx], maxPrice: 900, condition: .used, ownerType: .private, searchId: "s1").normalized()
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(filters)) as? [String: Any]
        XCTAssertEqual(body?["query"] as? String, "sony xm5")
        XCTAssertEqual(body?["location"] as? String, "Polska")
        XCTAssertEqual(body?["condition"] as? String, "Used")
        XCTAssertEqual(body?["ownerType"] as? String, "private")
        XCTAssertEqual(body?["sources"] as? [String], ["OLX"])
        XCTAssertEqual(body?["maxPrice"] as? Double, 900)
        XCTAssertNil(body?["minPrice"])
    }

    func testMergesResultsByIDCheapestFirst() throws {
        let dashboard: DashboardData = DemoTransport.fixture("dashboard")
        let first = Array(dashboard.listings.prefix(3))
        var updated = first[0]
        updated.price = 1
        let merged = first.mergingSearchResults([updated] + dashboard.listings.suffix(2))
        XCTAssertEqual(merged.count, 5)
        XCTAssertEqual(merged.first?.price, 1)
        XCTAssertEqual(merged.map(\.price), merged.map(\.price).sorted())
    }

    func testDemoSearch() async throws {
        let client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())
        let result = try await client.search(SearchFilters(query: "steam deck", sources: [.olx, .vinted]))
        XCTAssertEqual(result.listings.map(\.title), ["Steam Deck 64GB (LCD)", "Steam Deck OLED 512GB"])
        XCTAssertEqual(result.sources.map(\.count), [2, 0])
        XCTAssertNil(result.listings.first?.typical)
    }

    func testDecodesAProgressEvent() throws {
        let json = #"{"searchId":"s1","page":1,"source":"Vinted","status":{"source":"Vinted","status":"ok","count":0,"pendingShipping":0,"durationMs":812,"message":"No matching listings"},"listings":[]}"#
        let event = try JSONDecoder().decode(SearchProgressEvent.self, from: Data(json.utf8))
        XCTAssertEqual(event.status.source, .vinted)
    }
}

final class AuthTests: XCTestCase {
    func testSendsTheAPITokenAsABearerHeader() async throws {
        let transport = RoutingTransport { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
            return (200, #"{"authEnabled":true,"authenticated":true,"passwordLogin":false}"#)
        }
        try await ScoutClient(baseURL: URL(string: "https://host")!, apiToken: "  secret-token\n", transport: transport).verifyAccess()
    }

    func testOmitsTheHeaderWithoutAToken() async throws {
        let transport = RoutingTransport { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (200, #"{"authEnabled":false,"authenticated":true,"passwordLogin":false}"#)
        }
        try await ScoutClient(baseURL: URL(string: "https://host")!, apiToken: " ", transport: transport).verifyAccess()
    }

    func testRejectsAServerThatNeedsSignIn() async {
        let transport = RoutingTransport { _ in (200, #"{"authEnabled":true,"authenticated":false,"passwordLogin":true}"#) }
        do {
            try await ScoutClient(baseURL: URL(string: "https://host")!, transport: transport).verifyAccess()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? ScoutAPIError, .unauthorized(tokenProvided: false))
        }
    }

    func testFallsBackToHealthOnServersWithoutSignIn() async throws {
        let transport = RoutingTransport { request in
            request.url?.path == "/api/auth/session" ? (404, #"{"error":"Not found"}"#) : (200, #"{"status":"ok"}"#)
        }
        try await ScoutClient(baseURL: URL(string: "https://host")!, transport: transport).verifyAccess()
    }

    func testMaps401ToARejectedToken() async {
        let transport = RoutingTransport { _ in (401, #"{"error":"Authentication required"}"#) }
        do {
            _ = try await ScoutClient(baseURL: URL(string: "https://host")!, apiToken: "wrong", transport: transport).dashboard()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? ScoutAPIError, .unauthorized(tokenProvided: true))
        }
    }

    func testServerDataOnlySendsTheTokenToItsOwnServer() async throws {
        let transport = RoutingTransport { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret-token")
            return (200, "jpeg")
        }
        let client = ScoutClient(baseURL: URL(string: "https://host/scout")!, apiToken: "secret-token", transport: transport)
        let data = try await client.serverData(client.marketSnapshotImageURL(imageId: 7))
        XCTAssertEqual(data, Data("jpeg".utf8))
        do {
            _ = try await client.serverData(URL(string: "https://host/scoutx/api/market-snapshot-images/7")!)
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? ScoutAPIError, .invalidResponse)
        }
    }
}

final class RedirectGuardTests: XCTestCase {
    private func redirect(_ from: String, _ to: String) -> String? {
        var request = URLRequest(url: URL(string: to)!)
        request.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
        return RedirectGuard.redirect(request, from: URL(string: from)).value(forHTTPHeaderField: "Authorization")
    }

    func testKeepsTheTokenOnTheSameOrigin() {
        XCTAssertEqual(redirect("https://scout.lan/api/dashboard", "https://SCOUT.lan:443/scout/api/dashboard"), "Bearer secret")
        XCTAssertEqual(redirect("http://scout.lan:3001/api", "http://scout.lan:3001/other"), "Bearer secret")
        // An upgrade to TLS on the same host.
        XCTAssertEqual(redirect("http://scout.lan/api", "https://scout.lan/api"), "Bearer secret")
        XCTAssertEqual(redirect("http://scout.lan:3001/api", "https://scout.lan/api"), "Bearer secret")
    }

    func testDropsTheTokenWhenTheOriginChanges() {
        XCTAssertNil(redirect("https://scout.lan/api", "https://evil.example/api"))
        XCTAssertNil(redirect("https://scout.lan/api", "https://scout.lan:8443/api"))
        XCTAssertNil(redirect("https://scout.lan/api", "http://scout.lan/api"))
        XCTAssertNil(redirect("http://scout.lan/api", "https://scout.lan:8443/api"))
        XCTAssertNil(redirect("https://scout.lan/api", "https://sub.scout.lan/api"))
        XCTAssertNil(RedirectGuard.redirect(URLRequest(url: URL(string: "https://scout.lan")!), from: nil).value(forHTTPHeaderField: "Authorization"))
    }

    func testLeavesOtherHeadersAlone() {
        var request = URLRequest(url: URL(string: "https://cdn.example/image.jpg")!)
        request.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let redirected = RedirectGuard.redirect(request, from: URL(string: "https://scout.lan/api/market-snapshot-images/1"))
        XCTAssertNil(redirected.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(redirected.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testTokenStorageErrorIsDescriptive() {
        let message = TokenStorageError(operation: .save, status: -34018).localizedDescription
        XCTAssertTrue(message.hasPrefix("Couldn't save the API token in the Keychain"), message)
        XCTAssertTrue(message.contains("-34018"), message)
    }
}

private struct RoutingTransport: HTTPTransport {
    var respond: @Sendable (URLRequest) -> (Int, String)

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body) = respond(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    func append(_ request: URLRequest) { lock.withLock { requests.append(request) } }
    var all: [URLRequest] { lock.withLock { requests } }
}

private struct StubTransport: HTTPTransport {
    var status: Int
    var body: String

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class WidgetSnapshotTests: XCTestCase {
    func testNewestIgnoresSnapshotsFromOtherSources() {
        let dashboard = DemoTransport.dashboard()
        let older = WidgetSnapshot.make(from: dashboard, source: "https://a", now: Date(timeIntervalSince1970: 10))
        let newer = WidgetSnapshot.make(from: dashboard, source: "https://a", now: Date(timeIntervalSince1970: 20))
        let demo = WidgetSnapshot.make(from: dashboard, isDemo: true, source: WidgetSnapshot.source(serverURL: nil, isDemo: true), now: Date(timeIntervalSince1970: 30))
        XCTAssertEqual(WidgetSnapshot.newest([older, nil, newer, demo], from: "https://a")?.generatedAt, Date(timeIntervalSince1970: 20))
        XCTAssertEqual(WidgetSnapshot.newest([older, demo], from: "demo")?.isDemo, true)
        XCTAssertNil(WidgetSnapshot.newest([older, newer], from: "https://b"))
    }

    func testPicksStrongestVisibleDealsFirst() {
        var dashboard = DemoTransport.dashboard()
        dashboard.listings[0].hidden = true
        dashboard.listings[2].decision = .pass
        let snapshot = WidgetSnapshot.make(from: dashboard, limit: 3)
        XCTAssertEqual(snapshot.deals.map(\.title), ["Sony WH-1000XM5", "Steam Deck 64GB (LCD)", "Carhartt WIP Detroit Jacket"])
        XCTAssertEqual(snapshot.stats, dashboard.stats)
    }

    func testDeepLinkRoundTrips() throws {
        let deal = try XCTUnwrap(WidgetSnapshot.make(from: DemoTransport.dashboard()).deals.first { $0.marketplace == .allegroLokalnie })
        XCTAssertEqual(deal.deepLink.absoluteString, "scout://listing?key=Allegro%20Lokalnie:344821&watchId=watch-sony")
        let items = try XCTUnwrap(URLComponents(url: deal.deepLink, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(items.first { $0.name == "key" }?.value, "Allegro Lokalnie:344821")
    }

    func testContentComparisonIgnoresTimeAndThumbnails() {
        let first = WidgetSnapshot.make(from: DemoTransport.dashboard(), now: Date(timeIntervalSince1970: 0))
        var second = first
        second.generatedAt = Date()
        second.deals[0].thumbnail = Data([1, 2, 3])
        XCTAssertTrue(first.hasSameContent(as: second))
        second.deals[0].price += 1
        XCTAssertFalse(first.hasSameContent(as: second))
    }

    func testContentComparisonIgnoresFieldsWidgetsDontDraw() {
        let first = WidgetSnapshot.make(from: DemoTransport.dashboard(), now: Date(timeIntervalSince1970: 0))
        var second = first
        // A scan re-seeing the listings bumps these on every deal.
        second.lastScan = "just now"
        for index in second.deals.indices {
            second.deals[index].observedAt = "2030-01-01T00:00:00.000Z"
            second.deals[index].typical = (second.deals[index].typical ?? 100) + 7
            second.deals[index].dealStrength += 0.3
        }
        XCTAssertTrue(first.hasSameContent(as: second))

        // Only the rounded text is drawn: "−20%" and "2000 zł" (half-even, like the widgets).
        var shown = first
        shown.deals[0].belowTypical = -20.2
        shown.deals[0].price = 1999.6
        var same = shown
        same.deals[0].belowTypical = -20.4
        same.deals[0].price = 2000.4
        XCTAssertTrue(shown.hasSameContent(as: same))
        same.deals[0].belowTypical = -20.6
        XCTAssertFalse(shown.hasSameContent(as: same))
        same = shown
        same.deals[0].price = 10.5
        var other = shown
        other.deals[0].price = 11.4
        XCTAssertEqual(WidgetFormat.pln(10.5), WidgetFormat.pln(10.4))
        XCTAssertFalse(same.hasSameContent(as: other))
        same = shown
        same.deals[0].belowTypical = 3
        other = shown
        other.deals[0].belowTypical = nil
        XCTAssertTrue(same.hasSameContent(as: other))
    }

    func testContentComparisonCatchesEveryDrawnChange() {
        let first = WidgetSnapshot.make(from: DemoTransport.dashboard(), source: "https://a", now: Date(timeIntervalSince1970: 0))
        let changes: [(String, (inout WidgetSnapshot) -> Void)] = [
            ("order", { $0.deals.swapAt(0, 1) }),
            ("dropped deal", { $0.deals.removeLast() }),
            ("title", { $0.deals[1].title += "!" }),
            ("price", { $0.deals[1].price += 1 }),
            ("discount appears", { $0.deals[1].belowTypical = -50 }),
            ("label", { $0.deals[1].dealLabel = $0.deals[1].dealLabel == .exceptional ? .strong : .exceptional }),
            ("marketplace", { $0.deals[1].marketplace = $0.deals[1].marketplace == .olx ? .vinted : .olx }),
            ("photo", { $0.deals[1].imageURL += "?v=2" }),
            ("link", { $0.deals[1].watchId = "watch-other" }),
            ("key", { $0.deals[1].key += "-2" }),
            ("watching", { $0.stats.watching += 1 }),
            ("new today", { $0.stats.newToday += 1 }),
            ("strong deals", { $0.stats.strongDeals += 1 }),
            ("demo", { $0.isDemo.toggle() }),
            ("source", { $0.source = "https://b" }),
        ]
        for (name, change) in changes {
            var second = first
            change(&second)
            XCTAssertFalse(first.hasSameContent(as: second), name)
        }
    }

    func testReplacesTheSavedSnapshotOnDrawnChangesOrAfterTheRefreshFloor() {
        let saved = WidgetSnapshot.make(from: DemoTransport.dashboard(), now: Date(timeIntervalSince1970: 1_000))
        func rescan(after seconds: TimeInterval) -> WidgetSnapshot {
            var next = saved
            next.generatedAt = saved.generatedAt.addingTimeInterval(seconds)
            next.lastScan = "just now"
            next.deals[0].observedAt = "2030-01-01T00:00:00.000Z"
            return next
        }
        XCTAssertTrue(WidgetSnapshot.shouldReplace(nil, with: saved))
        XCTAssertFalse(WidgetSnapshot.shouldReplace(saved, with: rescan(after: 60)))
        XCTAssertFalse(WidgetSnapshot.shouldReplace(saved, with: rescan(after: 15 * 60 - 1)))
        XCTAssertTrue(WidgetSnapshot.shouldReplace(saved, with: rescan(after: 15 * 60)))
        XCTAssertTrue(WidgetSnapshot.shouldReplace(saved, with: rescan(after: 60), refreshAfter: 30))
        var changed = rescan(after: 1)
        changed.deals[0].price += 5
        XCTAssertTrue(WidgetSnapshot.shouldReplace(saved, with: changed))
    }

    func testSavesSnapshotsAndConnectionsOnlyWhenTheyChange() throws {
        let suite = "scout-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let snapshot = WidgetSnapshot.make(from: DemoTransport.dashboard(), source: "https://a", now: Date(timeIntervalSince1970: 1_000))
        XCTAssertTrue(SharedStore.saveSnapshot(snapshot, refreshAfter: 900, in: defaults))
        var rescanned = snapshot
        rescanned.generatedAt.addTimeInterval(60)
        rescanned.lastScan = "just now"
        XCTAssertFalse(SharedStore.saveSnapshot(rescanned, refreshAfter: 900, in: defaults))
        XCTAssertEqual(SharedStore.loadSnapshot(from: defaults)?.generatedAt, snapshot.generatedAt)
        rescanned.generatedAt.addTimeInterval(900)
        XCTAssertTrue(SharedStore.saveSnapshot(rescanned, refreshAfter: 900, in: defaults))
        XCTAssertEqual(SharedStore.loadSnapshot(from: defaults)?.generatedAt, rescanned.generatedAt)

        let server = URL(string: "https://a")!
        XCTAssertFalse(SharedStore.saveConnection(serverURL: nil, isDemo: false, in: defaults))
        XCTAssertTrue(SharedStore.saveConnection(serverURL: server, isDemo: false, in: defaults))
        // Switching servers drops the old server's snapshot.
        XCTAssertNil(SharedStore.loadSnapshot(from: defaults))
        XCTAssertTrue(SharedStore.saveSnapshot(snapshot, refreshAfter: 900, in: defaults))
        XCTAssertFalse(SharedStore.saveConnection(serverURL: server, isDemo: false, in: defaults))
        XCTAssertNotNil(SharedStore.loadSnapshot(from: defaults))
        XCTAssertTrue(SharedStore.saveConnection(serverURL: server, isDemo: true, in: defaults))
        XCTAssertTrue(SharedStore.saveConnection(serverURL: URL(string: "https://b")!, isDemo: true, in: defaults))
    }

    func testFreshnessNeedsTheSameSourceAndARecentFetch() {
        let now = Date(timeIntervalSince1970: 10_000)
        let snapshot = WidgetSnapshot.make(from: DemoTransport.dashboard(), source: "https://a", now: now.addingTimeInterval(-30))
        XCTAssertTrue(snapshot.isFresh(for: "https://a", maxAge: 60, now: now))
        XCTAssertFalse(snapshot.isFresh(for: "https://a", maxAge: 30, now: now))
        XCTAssertFalse(snapshot.isFresh(for: "https://b", maxAge: 60, now: now))
        XCTAssertFalse(snapshot.isFresh(for: nil, maxAge: 60, now: now))
        // A clock that moved backwards doesn't make an old snapshot look new.
        XCTAssertFalse(snapshot.isFresh(for: "https://a", maxAge: 60, now: now.addingTimeInterval(-60)))
    }

    func testReusesThumbnailsByPhotoAddress() {
        var fresh = WidgetSnapshot.make(from: DemoTransport.dashboard(), source: "https://a")
        for index in fresh.deals.indices { fresh.deals[index].imageURL = "https://img/\(index).jpg" }
        var cached = fresh
        cached.deals = Array(cached.deals.reversed())
        cached.deals[0].thumbnail = Data([1])
        let lastPhoto = cached.deals[0].imageURL
        cached.deals[1].thumbnail = Data([2])
        cached.deals[1].imageURL = "https://img/other.jpg"
        var older = fresh
        older.deals[0].thumbnail = Data([3])

        var snapshot = fresh
        XCTAssertEqual(snapshot.dealsMissingThumbnails(limit: 3), [0, 1, 2])
        snapshot.reuseThumbnails(from: [nil, cached, older])
        XCTAssertEqual(snapshot.deals.last?.imageURL, lastPhoto)
        XCTAssertEqual(snapshot.deals.last?.thumbnail, Data([1]))
        XCTAssertEqual(snapshot.deals[0].thumbnail, Data([3]))
        XCTAssertEqual(snapshot.deals.dropFirst().dropLast().compactMap(\.thumbnail), [])
        XCTAssertEqual(snapshot.dealsMissingThumbnails(limit: 3), [1, 2])
        XCTAssertEqual(snapshot.dealsMissingThumbnails(limit: 1), [])
        XCTAssertEqual(snapshot.dealsMissingThumbnails(limit: 0), [])
        XCTAssertEqual(snapshot.dealsMissingThumbnails(limit: 6), Array(1..<snapshot.deals.count - 1))
        // A thumbnail already attached is kept.
        snapshot.deals[1].thumbnail = Data([9])
        snapshot.reuseThumbnails(from: [cached])
        XCTAssertEqual(snapshot.deals[1].thumbnail, Data([9]))
        // Deals without a photo never need one downloaded.
        XCTAssertEqual(WidgetSnapshot.make(from: DemoTransport.dashboard()).dealsMissingThumbnails(limit: 6), [])
    }

    func testThumbnailCountFollowsWhatEachWidgetDraws() {
        XCTAssertEqual(WidgetLayout.systemSmall.thumbnailCount(drawsThumbnails: true), 1)
        XCTAssertEqual(WidgetLayout.systemMedium.thumbnailCount(drawsThumbnails: true), 3)
        XCTAssertEqual(WidgetLayout.systemLarge.thumbnailCount(drawsThumbnails: true), 6)
        XCTAssertEqual(WidgetLayout.other.thumbnailCount(drawsThumbnails: true), 3)
        for layout in [WidgetLayout.systemSmall, .systemMedium, .systemLarge, .other] {
            XCTAssertEqual(layout.thumbnailCount(drawsThumbnails: false), 0)
        }
    }

    func testDemoTopDashboardMatchesTheWidgetsPick() async throws {
        let transport = DemoTransport()
        let client = ScoutClient(baseURL: DemoTransport.baseURL, transport: transport)
        let full = try await client.dashboard()
        let top = try await client.dashboard(top: 3)
        XCTAssertEqual(top.listings, Array(WidgetSnapshot.ranked(full.listings).prefix(3)))
        XCTAssertEqual(top.watches, [])
        XCTAssertEqual(top.connectors, [])
        XCTAssertEqual(top.stats, full.stats)
        XCTAssertEqual(top.lastScan, full.lastScan)
        XCTAssertEqual(top.lastScanTime, full.lastScanTime)
        let now = Date()
        let widgetTop = try await client.dashboard(top: 12, timeout: 10)
        XCTAssertEqual(WidgetSnapshot.make(from: widgetTop, now: now), WidgetSnapshot.make(from: full, now: now))
        // Anything but an integer from 1 to 50 gets the full dashboard.
        for value in ["0", "51", "-1", "x", "", "2.5"] {
            let url = client.url("/api/dashboard", query: [URLQueryItem(name: "top", value: value)])
            let (data, _) = try await transport.send(URLRequest(url: url))
            XCTAssertEqual(try JSONDecoder().decode(DashboardData.self, from: data), full, value)
        }
    }

    func testDefaultGroupIsAlwaysACandidate() {
        XCTAssertEqual(SharedStore.candidateGroups().last, SharedStore.defaultAppGroup)
        XCTAssertNil(SharedStore.appGroup)
    }
}

final class WatchDraftTests: XCTestCase {
    func testTitleQueryDropsPricesSaleWordsAndCities() {
        XCTAssertEqual(WatchDraft.titleQuery(from: "Sprzedam Steam Deck OLED 512GB · 1 899 zł Warszawa"), "Steam Deck OLED 512GB")
        XCTAssertEqual(WatchDraft.titleQuery(from: "LEGO 10316 Rivendell, okazja! Kraków."), "LEGO 10316 Rivendell okazja!")
    }

    func testPrefillFromListingUsesAPriceBand() throws {
        let listing = try XCTUnwrap(DemoTransport.dashboard().listings.first { $0.key == "OLX:890231" })
        let draft = WatchDraft(listing: listing)
        XCTAssertEqual(draft.query, "Steam Deck OLED 512GB")
        XCTAssertEqual(draft.name, "Steam Deck OLED 512GB watch")
        XCTAssertEqual(draft.sources, [.olx])
        XCTAssertEqual(draft.location, "Warszawa")
        XCTAssertEqual(draft.minPrice, 1425)
        XCTAssertEqual(draft.maxPrice, 2375)
        XCTAssertTrue(draft.shippingOnly)
        XCTAssertNil(draft.validationError)
    }

    func testPrefillFromSearch() {
        let draft = WatchDraft(search: SearchFilters(query: " xm5 ", sources: [.vinted], maxPrice: 900, condition: .used, aiRelevance: false))
        XCTAssertEqual(draft.name, "xm5 watch")
        XCTAssertEqual(draft.condition, "Used")
        XCTAssertEqual(draft.location, "Polska")
        XCTAssertFalse(draft.aiRelevance)
    }

    func testValidation() {
        XCTAssertEqual(WatchDraft(query: "x").validationError, "Give the watch a name.")
        XCTAssertEqual(WatchDraft(name: "x", query: "x", sources: []).validationError, "Pick at least one marketplace.")
        XCTAssertEqual(WatchDraft(name: "x", query: "x", interval: 2).validationError, "The scan interval must be between 5 and 1440 minutes.")
        XCTAssertEqual(WatchDraft(name: "x", query: "x", minPrice: 10, maxPrice: 5).validationError, "The minimum price can't exceed the maximum.")
    }

    func testEncodesNullPricesSoEditsCanClearThem() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(WatchDraft(name: "a", query: "b"))) as? [String: Any]
        XCTAssertTrue(body?["minPrice"] is NSNull)
        XCTAssertEqual(body?["interval"] as? Int, 5)
    }

    func testDemoCreateEditArchive() async throws {
        let client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())
        let created = try await client.createWatch(WatchDraft(name: " Switch OLED ", query: "switch oled", maxPrice: 900))
        XCTAssertEqual(created.name, "Switch OLED")
        XCTAssertEqual(created.status, "Learning")

        var draft = WatchDraft(watch: created)
        draft.maxPrice = nil
        draft.interval = 30
        try await client.updateWatch(id: created.id, draft: draft)
        var watches = try await client.watches()
        let edited = try XCTUnwrap(watches.first { $0.id == created.id })
        XCTAssertNil(edited.maxPrice)
        XCTAssertEqual(edited.interval, 30)

        try await client.updateWatch(id: created.id, patch: WatchPatch(archived: true))
        watches = try await client.watches()
        XCTAssertFalse(watches.contains { $0.id == created.id })
        let all = try await client.watches(includeArchived: true)
        XCTAssertEqual(all.first { $0.id == created.id }?.status, "Archived")
    }
}

final class MarketTests: XCTestCase {
    private let client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())

    func testDecodesARealResearchWatch() throws {
        let json = #"{"watches":[{"id":"m1","name":"Deck","query":"deck","terms":"","excluded":"","location":"Polska","condition":"Any","sources":["OLX"],"intervalHours":24,"minPrice":null,"maxPrice":null,"shippingOnly":false,"typoVariants":false,"enabled":true,"nextScan":"in 3h","lastScan":"Never","totalListings":0,"activeListings":0,"endedListings":0,"estimatedMedianPrice":null,"saleBand":null,"activeVersionId":"v1"}],"listings":[],"aggregates":{"overallMedianPrice":null,"endedCount":0,"activeCount":0,"saleBand":null},"pagination":{"page":1,"pageSize":50,"total":0,"hasNext":false}}"#
        let data = try JSONDecoder().decode(MarketResearchData.self, from: Data(json.utf8))
        XCTAssertEqual(data.watches.first?.intervalHours, 24)
    }

    func testResearchFlowInDemo() async throws {
        let research = try await client.marketResearch()
        XCTAssertEqual(research.watches.count, 3)
        XCTAssertFalse(research.listings.isEmpty)
        let ended = try await client.marketResearch(status: .ended)
        XCTAssertTrue(ended.listings.allSatisfy { $0.status == "ended" && $0.statusTitle == "No longer available" })

        let trend = try await client.marketWatchTrend(id: "market-xm5", days: 30)
        XCTAssertEqual(trend.points.count, 30)
        XCTAssertEqual(trend.probableSaleMedian, 990)

        let listing = try XCTUnwrap(research.listings.first { $0.snapshotStatus == nil })
        let before = try await client.marketListingSnapshot(id: listing.id)
        XCTAssertNil(before)
        let captured = try await client.captureMarketListingSnapshot(id: listing.id)
        XCTAssertEqual(captured?.title, listing.title)
        let history = try await client.marketListingHistory(id: listing.id)
        XCTAssertEqual(history.count, listing.observations)
        XCTAssertEqual(history.last?.price, listing.lastPrice)
    }

    func testResearchWatchCrudInDemo() async throws {
        let created = try await client.createMarketWatch(MarketWatchDraft(name: "Switch market", query: "switch oled", intervalHours: 12))
        XCTAssertEqual(created.intervalHours, 12)
        let original = MarketWatchDraft(watch: created)
        var draft = original
        draft.maxPrice = 900
        try await client.updateMarketWatch(id: created.id, draft: draft, original: original)
        try await client.setMarketWatchEnabled(id: created.id, enabled: false)
        var research = try await client.marketResearch()
        let updated = try XCTUnwrap(research.watches.first { $0.id == created.id })
        XCTAssertEqual(updated.maxPrice, 900)
        XCTAssertFalse(updated.enabled)
        _ = try await client.scanMarketWatch(id: created.id)
        try await client.deleteMarketWatch(id: created.id)
        research = try await client.marketResearch()
        XCTAssertFalse(research.watches.contains { $0.id == created.id })
    }

    func testRenameSendsOnlyTheName() async throws {
        let original = MarketWatchDraft(name: "Deck", query: "steam deck", terms: "oled", minPrice: 1000)
        var draft = original
        draft.name = "  Deck OLED "
        let patch = draft.patch(from: original)
        XCTAssertFalse(patch.changesCriteria)
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
        XCTAssertEqual(body?.keys.sorted(), ["name"])
        XCTAssertEqual(body?["name"] as? String, "Deck OLED")

        let transport = RoutingTransport { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(String(decoding: request.httpBody ?? Data(), as: UTF8.self), #"{"name":"Deck OLED"}"#)
            return (200, #"{"ok":true}"#)
        }
        try await ScoutClient(baseURL: URL(string: "https://host")!, transport: transport).updateMarketWatch(id: "m1", draft: draft, original: original)
    }

    func testPatchIgnoresWhitespaceAndSendsClearedPricesAsNull() throws {
        let original = MarketWatchDraft(name: "Deck", query: "steam deck", location: "", minPrice: 1000)
        var draft = original
        draft.query = " steam deck "
        draft.location = "Polska"
        XCTAssertTrue(draft.patch(from: original).isEmpty)

        draft.minPrice = nil
        draft.intervalHours = 48
        let patch = draft.patch(from: original)
        XCTAssertTrue(patch.changesCriteria)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["intervalHours", "minPrice"])
        XCTAssertTrue(body["minPrice"] is NSNull)
        XCTAssertEqual(try JSONDecoder().decode(MarketWatchPatch.self, from: JSONEncoder().encode(patch)), patch)
    }

    func testUnchangedEditStillSendsAValidBody() async throws {
        let original = MarketWatchDraft(name: "Deck", query: "steam deck")
        let transport = RoutingTransport { request in
            XCTAssertEqual(String(decoding: request.httpBody ?? Data(), as: UTF8.self), #"{"name":"Deck"}"#)
            return (200, #"{"ok":true}"#)
        }
        try await ScoutClient(baseURL: URL(string: "https://host")!, transport: transport).updateMarketWatch(id: "m1", draft: original, original: original)
    }

    func testDemoRenameKeepsTheCriteria() async throws {
        let created = try await client.createMarketWatch(MarketWatchDraft(name: "Switch market", query: "switch oled", minPrice: 500))
        var draft = MarketWatchDraft(watch: created)
        draft.name = "Switch OLED market"
        try await client.updateMarketWatch(id: created.id, draft: draft, original: MarketWatchDraft(watch: created))
        let research = try await client.marketResearch()
        let updated = try XCTUnwrap(research.watches.first { $0.id == created.id })
        XCTAssertEqual(updated.name, "Switch OLED market")
        XCTAssertEqual(updated.query, "switch oled")
        XCTAssertEqual(updated.minPrice, 500)
    }

    func testMarketDraftValidation() {
        XCTAssertEqual(MarketWatchDraft(name: "a", query: "b", intervalHours: 3).validationError, "The snapshot interval must be between 6 and 168 hours.")
        XCTAssertNil(MarketWatchDraft(name: "a", query: "b").validationError)
    }

    func testAnalyticsAndSettingsInDemo() async throws {
        let analytics = try await client.analytics(days: 7, marketplace: .vinted)
        XCTAssertEqual(analytics.trend.count, 7)
        XCTAssertEqual(analytics.marketplaceComparison.map(\.marketplace), [.vinted])
        let settings = try await client.settings()
        XCTAssertEqual(settings.ntfy.openInApp, false)
        let updated = try await client.setNtfyOpenInApp(true)
        XCTAssertEqual(updated.ntfy.openInApp, true)
    }

    func testSnapshotImageURLUsesTheServer() {
        let client = ScoutClient(baseURL: URL(string: "https://host/scout")!)
        XCTAssertEqual(client.marketSnapshotImageURL(imageId: 7).absoluteString, "https://host/scout/api/market-snapshot-images/7")
    }
}

final class LiveUpdatesTests: XCTestCase {
    private func event(_ name: String, _ data: String = "{}") -> ServerSentEvent {
        ServerSentEvent(event: name, data: data)
    }

    func testEachEventInvalidatesOnlyWhatItChanges() {
        let scan = LiveInvalidation(event: event("scan", #"{"refresh":true,"watchId":"w1"}"#))
        XCTAssertEqual([scan.feed, scan.watches, scan.triage, scan.server, scan.research, scan.allWatches], [true, true, false, true, false, false])
        XCTAssertEqual(scan.watchIDs, ["w1"])

        let watch = LiveInvalidation(event: event("watch", #"{"id":"w2","archived":true}"#))
        XCTAssertEqual([watch.feed, watch.watches, watch.triage, watch.server, watch.research, watch.allWatches], [true, true, false, false, false, false])
        XCTAssertEqual(watch.watchIDs, ["w2"])

        // A delete names no watch, so every watch detail is stale.
        let deleted = LiveInvalidation(event: event("watch", #"{"refresh":true}"#))
        XCTAssertTrue(deleted.allWatches)
        XCTAssertTrue(deleted.watchIDs.isEmpty)

        // Rows patch themselves; deal counts (hidden) and analytics reload.
        let action = LiveInvalidation(event: event("listing-action", #"{"key":"OLX:1","decision":"buy","hidden":false}"#))
        XCTAssertEqual([action.feed, action.watches, action.triage, action.server, action.research], [false, true, true, false, false])
        XCTAssertTrue(LiveInvalidation(event: event("listing-action", "not json")).feed)

        let notification = LiveInvalidation(event: event("notification", #"{"refresh":true}"#))
        var serverOnly = LiveInvalidation()
        serverOnly.server = true
        XCTAssertEqual(notification, serverOnly)

        let market = LiveInvalidation(event: event("market-watch", #"{"refresh":true,"id":"m1"}"#))
        XCTAssertEqual([market.feed, market.watches, market.research, market.allMarketWatches], [false, false, true, false])
        XCTAssertEqual(market.marketWatchIDs, ["m1"])
        XCTAssertTrue(LiveInvalidation(event: event("market-watch", #"{"refresh":true}"#)).allMarketWatches)

        XCTAssertTrue(LiveInvalidation(event: event("ai-description-verification", #"{"key":"OLX:1","status":"match"}"#)).isEmpty)
        XCTAssertTrue(LiveInvalidation(event: event("search", "{}")).isEmpty)
        XCTAssertTrue(LiveInvalidation(event: event("ready")).isEmpty)
    }

    func testMergesBurstsAndCoversEverythingOnReconnect() {
        var pending = LiveInvalidation(event: event("scan", #"{"watchId":"w1"}"#))
        pending.formUnion(LiveInvalidation(event: event("scan", #"{"watchId":"w2"}"#)))
        pending.formUnion(LiveInvalidation(event: event("notification")))
        XCTAssertEqual(pending.watchIDs, ["w1", "w2"])
        XCTAssertTrue(pending.server && pending.feed && !pending.research)
        var everything = pending
        everything.formUnion(.everything)
        XCTAssertEqual(everything.watchIDs, ["w1", "w2"])
        XCTAssertTrue(everything.feed && everything.watches && everything.triage && everything.server && everything.research && everything.allWatches && everything.allMarketWatches)
    }

    func testDecodesListingActions() throws {
        let action = try XCTUnwrap(ListingActionEvent(event: event("listing-action", #"{"key":"Allegro Lokalnie:344821","decision":null,"hidden":true}"#)))
        XCTAssertEqual(action, ListingActionEvent(key: "Allegro Lokalnie:344821", decision: nil, hidden: true))
        XCTAssertEqual(ListingActionEvent(event: event("listing-action", #"{"key":"OLX:1","decision":"pass","hidden":false}"#))?.decision, .pass)
        XCTAssertNil(ListingActionEvent(event: event("scan", #"{"key":"OLX:1","decision":"pass","hidden":false}"#)))
        XCTAssertNil(ListingActionEvent(event: event("listing-action", #"{"key":"OLX:1"}"#)))
        XCTAssertNotEqual(action, ListingActionEvent(key: action.key, decision: action.decision, hidden: action.hidden, sequence: 1))
    }

    func testPatchesDecisionsInPlaceAndReloadsOnHiddenChanges() throws {
        var rows = DemoTransport.dashboard().listings
        // The same listing under a second watch.
        var twin = rows[1]
        twin.associationId = "twin"
        rows.append(twin)
        let key = rows[1].key

        let buy = ListingActionEvent(key: key, decision: .buy, hidden: false)
        let patched = try XCTUnwrap(buy.patched(rows))
        XCTAssertEqual(patched.filter { $0.key == key }.map(\.decision), [.buy, .buy])
        XCTAssertEqual(patched.map(\.rowID), rows.map(\.rowID))
        for (before, after) in zip(rows, patched) where before.key != key {
            XCTAssertEqual(before, after)
        }
        // Clearing the decision.
        XCTAssertEqual(try XCTUnwrap(ListingActionEvent(key: key, decision: nil, hidden: false).patched(patched)).filter { $0.key == key }.map(\.decision), [nil, nil])

        // Hiding or unhiding changes stats and deal counts, so reload.
        XCTAssertNil(ListingActionEvent(key: key, decision: .buy, hidden: true).patched(rows))
        var hiddenRows = rows
        hiddenRows[1].hidden = true
        XCTAssertNil(ListingActionEvent(key: key, decision: nil, hidden: false).patched(hiddenRows))
        XCTAssertNotNil(ListingActionEvent(key: key, decision: .pass, hidden: true).patched(hiddenRows.filter { $0.rowID != "twin" }))
        // A listing that isn't loaded may now belong in the list.
        XCTAssertNil(ListingActionEvent(key: "OLX:unknown", decision: .buy, hidden: false).patched(rows))
        XCTAssertNil(buy.patched([]))
    }

    func testReloadsOnlyWhenTheKeyChangedOrLiveDataMayBeStale() {
        let loadedAt = Date(timeIntervalSince1970: 1_000)
        func should(_ key: Int, visible: Bool = true, live: Bool = true, loaded: Int? = 1, at: Date? = loadedAt, now: TimeInterval = 1_060) -> Bool {
            ReloadPolicy.shouldLoad(key: key, isVisible: visible, isLive: live, loadedKey: loaded, loadedAt: at, now: Date(timeIntervalSince1970: now))
        }
        XCTAssertFalse(should(1), "re-appearing with nothing new keeps the data")
        XCTAssertTrue(should(2), "an event changed the key")
        XCTAssertFalse(should(2, visible: false), "hidden screens never load")
        XCTAssertTrue(should(1, loaded: nil, at: nil), "first appearance")
        XCTAssertTrue(should(1, live: false), "without live updates changes are unknown")
        XCTAssertFalse(should(1, now: 1_119))
        XCTAssertTrue(should(1, now: 1_120), "at most two minutes old")
        XCTAssertTrue(should(1, now: 900), "the clock moved back")
    }

    func testPagedRefreshKeepsTheLoadedWindow() {
        XCTAssertEqual(ReloadPolicy.pagesToKeep(loadedRows: 0, maxRows: 500), 1)
        XCTAssertEqual(ReloadPolicy.pagesToKeep(loadedRows: 50, maxRows: 500), 1)
        XCTAssertEqual(ReloadPolicy.pagesToKeep(loadedRows: 51, maxRows: 500), 2)
        XCTAssertEqual(ReloadPolicy.pagesToKeep(loadedRows: 150, maxRows: 500), 3)
        XCTAssertEqual(ReloadPolicy.pagesToKeep(loadedRows: 900, maxRows: 500), 10)
        XCTAssertEqual(ReloadPolicy.pagesToKeep(loadedRows: 900, maxRows: 400), 8)
    }
}
