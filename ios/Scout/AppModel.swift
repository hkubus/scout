import Foundation
import Observation
import ScoutKit
import WidgetKit

enum AppTab: String, Hashable {
    case deals, search, watches, market, settings
}

enum ConnectionState: Equatable {
    case demo
    case connecting
    case live
    case offline(String)
}

/// A listing to open, from a row tap or a `scout://listing?key=…&watchId=…` link.
struct ListingLink: Hashable, Identifiable {
    var key: String
    var watchId: String?
    /// Row data shown if the server has no stored detail for the listing.
    var preview: Listing?

    var id: String { "\(watchId ?? ""):\(key)" }

    init(key: String, watchId: String?, preview: Listing? = nil) {
        self.key = key
        self.watchId = watchId
        self.preview = preview
    }

    init(_ listing: Listing) {
        self.init(key: listing.key, watchId: listing.watchId, preview: listing)
    }

    // Identity only: the preview is display data and must not make two links
    // to the same listing differ.
    static func == (lhs: ListingLink, rhs: ListingLink) -> Bool {
        lhs.key == rhs.key && lhs.watchId == rhs.watchId
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(key)
        hasher.combine(watchId)
    }
}

/// The full, filterable listing history (reached from Deals).
struct AllListingsRoute: Hashable {}

struct WatchListingsRoute: Hashable {
    var watchId: String
    var name: String
}

@MainActor
@Observable
final class AppModel {
    private(set) var client: ScoutClient?
    private(set) var connection: ConnectionState = .connecting
    // Counters bumped when the server reports a change; each screen keys its
    // load on the ones for what it shows (`LiveInvalidation` maps events to
    // them). The server has no replay, so a reconnect bumps them all to
    // reconcile anything missed.
    /// Deals and listing lists: scans and watch changes. Triage patches their
    /// rows through `listingAction` instead.
    private(set) var refreshToken = 0
    /// The watch list and analytics: scans, watch changes and triage.
    private(set) var watchesToken = 0
    /// Triage, which changes every watch's deal counts.
    private(set) var triageToken = 0
    /// Settings: scans and notifications (connector runs).
    private(set) var serverToken = 0
    /// Research watches and saved listings.
    private(set) var researchToken = 0
    /// Per watch, from scans and watch changes; `allWatchesToken` covers
    /// changes that name no watch.
    private(set) var watchChanges: [String: Int] = [:]
    private(set) var allWatchesToken = 0
    private(set) var marketWatchChanges: [String: Int] = [:]
    private(set) var allMarketWatchesToken = 0
    /// The latest triage from any client, for lists to patch their rows.
    private(set) var listingAction: ListingActionEvent?
    var selectedTab: AppTab = .deals
    var marketSection: MarketSection = .research
    var openedListing: ListingLink?
    /// Watch to push once the Watches tab has loaded (screenshots).
    var pendingWatchID: String?
    /// Opens the new-watch form when the Watches tab appears (screenshots).
    var pendingNewWatch = false
    /// Query the Search tab runs when it appears (screenshots).
    var pendingSearchQuery: String?
    /// Bumped for every per-marketplace result streamed while a manual search
    /// runs; Search drains them with `takeSearchProgress()` so two quick
    /// events can't coalesce into one change.
    private(set) var searchProgressCount = 0
    /// What the widgets show, for the in-app widget preview.
    private(set) var widgetSnapshot: WidgetSnapshot?
    var showWidgetGallery = false
    var alertMessage: String?

    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var pendingInvalidation = LiveInvalidation()
    @ObservationIgnored private var fallbackRefresh: Task<Void, Never>?
    @ObservationIgnored private var listingActionCount = 0
    @ObservationIgnored private var pendingSearchProgress: [SearchProgressEvent] = []
    @ObservationIgnored private let defaults = UserDefaults.standard

    private static let serverURLKey = "serverURL"

    init() {
        // `-ScoutDemo YES -ScoutScreen <screen>` launch arguments drive the CI screenshots.
        if defaults.bool(forKey: "ScoutDemo") {
            useDemo()
        } else if let saved = defaults.string(forKey: Self.serverURLKey), let url = URL(string: saved) {
            client = ScoutClient(baseURL: url, apiToken: SharedStore.apiToken)
        }
        switch defaults.string(forKey: "ScoutScreen") {
        case "search":
            selectedTab = .search
            pendingSearchQuery = "steam deck"
        case "research":
            selectedTab = .market
            marketSection = .research
        case "analytics":
            selectedTab = .market
            marketSection = .analytics
        case "watches": selectedTab = .watches
        case "settings": selectedTab = .settings
        case "watch":
            selectedTab = .watches
            pendingWatchID = "watch-deck"
        case "listing": openedListing = ListingLink(key: "OLX:890231", watchId: "watch-deck")
        case "new-watch":
            selectedTab = .watches
            pendingNewWatch = true
        case "widgets":
            selectedTab = .settings
            showWidgetGallery = true
        default: break
        }
        syncWidgetConnection()
    }

    var isDemo: Bool { connection == .demo }
    var serverURL: URL? { isDemo ? nil : client?.baseURL }
    var lastServerAddress: String { defaults.string(forKey: Self.serverURLKey) ?? "" }

    func connect(to address: String, apiToken: String = "") async throws {
        let url = try ServerAddress.normalize(address)
        let candidate = ScoutClient(baseURL: url, apiToken: apiToken)
        try await candidate.verifyAccess()
        let warning = try storeAPIToken(candidate.apiToken)
        defaults.set(url.absoluteString, forKey: Self.serverURLKey)
        client = candidate
        connection = .connecting
        // Force it: reconnecting to the same server may bring a new token.
        syncWidgetConnection(force: true)
        startLiveUpdates()
        if let warning { alertMessage = warning }
    }

    /// Replaces or clears the connected server's API token once the server
    /// accepts the new one, as `connect` does.
    func updateAPIToken(_ apiToken: String) async throws {
        guard let current = client, !isDemo else { return }
        let candidate = ScoutClient(baseURL: current.baseURL, apiToken: apiToken)
        try await candidate.verifyAccess()
        let warning = try storeAPIToken(candidate.apiToken)
        client = candidate
        // Same server, but widgets may now be able to sign in.
        syncWidgetConnection(force: true)
        startLiveUpdates()
        refresh()
        if let warning { alertMessage = warning }
    }

    /// Keeps the token for later launches and the widgets. Throws when an
    /// earlier token couldn't be removed, since the next launch would send it
    /// to this server; returns a warning when only the new token wasn't kept,
    /// which leaves this session working.
    private func storeAPIToken(_ token: String?) throws -> String? {
        do {
            try SharedStore.saveAPIToken(token)
            return nil
        } catch let error as TokenStorageError where error.operation == .save {
            return "Scout is connected, but the API token couldn't be saved in the Keychain (\(error.reason)). Enter it again in Settings after Scout restarts; widgets can't use it until then."
        }
    }

    func useDemo() {
        stopLiveUpdates()
        client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())
        connection = .demo
        syncWidgetConnection()
    }

    func disconnect() {
        stopLiveUpdates()
        client = nil
        connection = .connecting
        openedListing = nil
        selectedTab = .deals
        widgetSnapshot = nil
        do {
            try SharedStore.saveAPIToken(nil)
        } catch {
            report(error)
        }
        syncWidgetConnection()
    }

    /// Marks every screen stale: those on screen reload now, the others
    /// when they next appear.
    func refresh() {
        invalidate(.everything)
    }

    /// After this device changed something: while live, the server's event
    /// for the change refreshes the screens that show it.
    func refreshUnlessLive() {
        if connection != .live { refresh() }
    }

    private func invalidate(_ scope: LiveInvalidation) {
        if scope.feed { refreshToken += 1 }
        if scope.watches { watchesToken += 1 }
        if scope.triage { triageToken += 1 }
        if scope.server { serverToken += 1 }
        if scope.research { researchToken += 1 }
        if scope.allWatches { allWatchesToken += 1 }
        if scope.allMarketWatches { allMarketWatchesToken += 1 }
        for id in scope.watchIDs { watchChanges[id, default: 0] += 1 }
        for id in scope.marketWatchIDs { marketWatchChanges[id, default: 0] += 1 }
    }

    func open(_ url: URL) {
        guard url.scheme == "scout" else { return }
        if url.host == "deals" {
            openedListing = nil
            selectedTab = .deals
            return
        }
        guard url.host == "listing",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let key = items.first(where: { $0.name == "key" })?.value, !key.isEmpty
        else { return }
        openedListing = ListingLink(key: key, watchId: items.first(where: { $0.name == "watchId" })?.value)
    }

    /// Switches to the Watches tab and opens the watch (after creating one).
    func showWatch(_ watch: Watch) {
        openedListing = nil
        pendingWatchID = watch.id
        selectedTab = .watches
    }

    // MARK: - Widgets

    /// Called after each dashboard load; reloads widgets only when what they
    /// show has changed.
    func publishWidgets(from dashboard: DashboardData) {
        let snapshot = WidgetSnapshot.make(from: dashboard, isDemo: isDemo, source: WidgetSnapshot.source(serverURL: serverURL, isDemo: isDemo))
        widgetSnapshot = snapshot
        if SharedStore.saveSnapshot(snapshot) {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// Reloads widgets only when they should switch server or demo mode, or
    /// when `force` is set; dashboard loads reload them when data changes.
    private func syncWidgetConnection(force: Bool = false) {
        if SharedStore.saveConnection(serverURL: serverURL, isDemo: isDemo) || force {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    func report(_ error: Error) {
        guard !error.isCancellation else { return }
        alertMessage = error.localizedDescription
    }

    // MARK: - Live updates

    func startLiveUpdates() {
        eventsTask?.cancel()
        guard let client, !isDemo else { return }
        eventsTask = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                do {
                    for try await event in client.events() {
                        delay = 1
                        self?.handle(event)
                    }
                    if Task.isCancelled { return }
                    self?.connection = .offline("The live update stream closed.")
                } catch {
                    if Task.isCancelled { return }
                    self?.connection = .offline(error.localizedDescription)
                }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 30)
            }
        }
    }

    /// On becoming active. A running stream, even one waiting to reconnect,
    /// is kept, so brief inactive spells (Control Center, alerts) cost
    /// nothing. A new stream's first event does the one catch-up refresh; if
    /// it can't go live within 3 s, screens refresh over HTTP anyway.
    func resumeLiveUpdates() {
        if isDemo {
            refresh()
            return
        }
        guard eventsTask == nil, client != nil else { return }
        startLiveUpdates()
        fallbackRefresh?.cancel()
        fallbackRefresh = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled, let self, self.connection != .live else { return }
            self.fallbackRefresh = nil
            self.refresh()
        }
    }

    func stopLiveUpdates() {
        eventsTask?.cancel()
        eventsTask = nil
        fallbackRefresh?.cancel()
        fallbackRefresh = nil
        if !isDemo { connection = .connecting }
    }

    private func handle(_ event: ServerSentEvent) {
        if event.event == "ready" || event.event == "ping" {
            if connection != .live {
                connection = .live
                // Subscribed now, so one refresh catches up on anything missed
                // while offline; it covers any pending one.
                fallbackRefresh?.cancel()
                fallbackRefresh = nil
                refreshTask?.cancel()
                refreshTask = nil
                pendingInvalidation = LiveInvalidation()
                refresh()
            }
        } else if event.event == "search" {
            if let progress = try? JSONDecoder().decode(SearchProgressEvent.self, from: Data(event.data.utf8)) {
                // Bounded in case Search isn't on screen to drain them.
                pendingSearchProgress = Array((pendingSearchProgress + [progress]).suffix(50))
                searchProgressCount += 1
            }
        } else {
            if var action = ListingActionEvent(event: event) {
                listingActionCount += 1
                action.sequence = listingActionCount
                listingAction = action
            }
            let scope = LiveInvalidation(event: event)
            if !scope.isEmpty { scheduleRefresh(scope) }
        }
    }

    /// Streamed search results since the last call, oldest first.
    func takeSearchProgress() -> [SearchProgressEvent] {
        defer { pendingSearchProgress = [] }
        return pendingSearchProgress
    }

    /// Coalesces bursts of events into one reload per screen: everything
    /// they invalidate within a second is applied together.
    private func scheduleRefresh(_ scope: LiveInvalidation) {
        pendingInvalidation.formUnion(scope)
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            self.refreshTask = nil
            let pending = self.pendingInvalidation
            self.pendingInvalidation = LiveInvalidation()
            self.invalidate(pending)
        }
    }
}

extension Error {
    /// True for task cancellation, including URLSession's `cancelled` error when
    /// a `.task(id:)` restarts mid-request.
    var isCancellation: Bool {
        if self is CancellationError { return true }
        if let urlError = self as? URLError, urlError.code == .cancelled { return true }
        return false
    }
}
