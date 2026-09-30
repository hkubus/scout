import Foundation
import Observation
import ScoutKit

enum AppTab: String, Hashable {
    case deals, listings, watches, settings
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

    var id: String { "\(watchId ?? ""):\(key)" }

    init(key: String, watchId: String?) {
        self.key = key
        self.watchId = watchId
    }

    init(_ listing: Listing) {
        self.init(key: listing.key, watchId: listing.watchId)
    }
}

struct WatchListingsRoute: Hashable {
    var watchId: String
    var name: String
}

@MainActor
@Observable
final class AppModel {
    private(set) var client: ScoutClient?
    private(set) var connection: ConnectionState = .connecting
    /// Bumped when the server reports scans, triage, or watch changes; screens
    /// reload with `.task(id:)` on it. The server has no replay, so a reconnect
    /// also bumps it to reconcile anything missed.
    private(set) var refreshToken = 0
    var selectedTab: AppTab = .deals
    var openedListing: ListingLink?
    /// Watch to push once the Watches tab has loaded (screenshots).
    var pendingWatchID: String?
    var alertMessage: String?

    @ObservationIgnored private var eventsTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private let defaults = UserDefaults.standard

    private static let serverURLKey = "serverURL"
    private static let refreshEvents: Set<String> = ["scan", "watch", "notification", "listing-action", "ai-description-verification"]

    init() {
        // `-ScoutDemo YES -ScoutScreen <screen>` launch arguments drive the CI screenshots.
        if defaults.bool(forKey: "ScoutDemo") {
            useDemo()
        } else if let saved = defaults.string(forKey: Self.serverURLKey), let url = URL(string: saved) {
            client = ScoutClient(baseURL: url)
        }
        switch defaults.string(forKey: "ScoutScreen") {
        case "listings": selectedTab = .listings
        case "watches": selectedTab = .watches
        case "settings": selectedTab = .settings
        case "watch":
            selectedTab = .watches
            pendingWatchID = "watch-deck"
        case "listing": openedListing = ListingLink(key: "OLX:890231", watchId: "watch-deck")
        default: break
        }
    }

    var isDemo: Bool { connection == .demo }
    var serverURL: URL? { isDemo ? nil : client?.baseURL }
    var lastServerAddress: String { defaults.string(forKey: Self.serverURLKey) ?? "" }

    func connect(to address: String) async throws {
        let url = try ServerAddress.normalize(address)
        let candidate = ScoutClient(baseURL: url)
        _ = try await candidate.health()
        defaults.set(url.absoluteString, forKey: Self.serverURLKey)
        client = candidate
        connection = .connecting
        startLiveUpdates()
    }

    func useDemo() {
        stopLiveUpdates()
        client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())
        connection = .demo
    }

    func disconnect() {
        stopLiveUpdates()
        client = nil
        connection = .connecting
        openedListing = nil
        selectedTab = .deals
    }

    func refresh() {
        refreshToken += 1
    }

    func open(_ url: URL) {
        guard url.scheme == "scout", url.host == "listing",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let key = items.first(where: { $0.name == "key" })?.value, !key.isEmpty
        else { return }
        openedListing = ListingLink(key: key, watchId: items.first(where: { $0.name == "watchId" })?.value)
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

    func stopLiveUpdates() {
        eventsTask?.cancel()
        eventsTask = nil
        if !isDemo { connection = .connecting }
    }

    private func handle(_ event: ServerSentEvent) {
        if event.event == "ready" || event.event == "ping" {
            if connection != .live {
                connection = .live
                scheduleRefresh()
            }
        } else if Self.refreshEvents.contains(event.event) {
            scheduleRefresh()
        }
    }

    /// Coalesces bursts of scan events into one reload.
    private func scheduleRefresh() {
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            self?.refreshTask = nil
            self?.refresh()
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
