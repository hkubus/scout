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

private struct RoutingTransport: HTTPTransport {
    var respond: @Sendable (URLRequest) -> (Int, String)

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body) = respond(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
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
        var draft = MarketWatchDraft(watch: created)
        draft.maxPrice = 900
        try await client.updateMarketWatch(id: created.id, draft: draft)
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
