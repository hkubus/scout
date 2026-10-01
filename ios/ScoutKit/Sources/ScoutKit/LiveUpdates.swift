import Foundation

/// What a live update event makes stale, so each screen reloads only for the
/// events that change what it shows. The app keeps one counter per scope and
/// screens key their loads on the counters they read.
public struct LiveInvalidation: Equatable, Sendable {
    /// Deals and listing lists.
    public var feed = false
    /// The watch list and analytics: deal counts, scan times, triage totals.
    public var watches = false
    /// Triage, which changes deal counts (hidden rows) on every watch.
    public var triage = false
    /// Settings: connector runs.
    public var server = false
    /// Research watches and their saved listings.
    public var research = false
    /// Every watch detail, for events that don't say which watch changed.
    public var allWatches = false
    public var watchIDs: Set<String> = []
    /// Every research watch detail, for events without an id.
    public var allMarketWatches = false
    public var marketWatchIDs: Set<String> = []

    public init() {}

    /// A reconnect or manual refresh: the server has no replay, so anything
    /// may have been missed.
    public static let everything: LiveInvalidation = {
        var all = LiveInvalidation()
        all.feed = true
        all.watches = true
        all.triage = true
        all.server = true
        all.research = true
        all.allWatches = true
        all.allMarketWatches = true
        return all
    }()

    public var isEmpty: Bool { self == LiveInvalidation() }

    public mutating func formUnion(_ other: LiveInvalidation) {
        feed = feed || other.feed
        watches = watches || other.watches
        triage = triage || other.triage
        server = server || other.server
        research = research || other.research
        allWatches = allWatches || other.allWatches
        watchIDs.formUnion(other.watchIDs)
        allMarketWatches = allMarketWatches || other.allMarketWatches
        marketWatchIDs.formUnion(other.marketWatchIDs)
    }

    private struct Payload: Decodable {
        var id: String?
        var watchId: String?
    }

    /// The scopes a server event invalidates.
    /// - `scan` ({watchId}): the feed, watches, that watch, and connector runs.
    /// - `watch` ({id}, or no id after a delete): the feed, watches, that watch.
    /// - `listing-action`: watch deal counts and analytics. Lists patch their
    ///   rows from the payload (`ListingActionEvent`) or reload themselves.
    /// - `notification`: connector runs only.
    /// - `market-watch` ({id} or none): research.
    /// - `ai-description-verification` always precedes a `scan` for the same
    ///   run and no list shows it, so it invalidates nothing; neither do
    ///   unknown events.
    public init(event: ServerSentEvent) {
        self.init()
        let payload = try? JSONDecoder().decode(Payload.self, from: Data(event.data.utf8))
        switch event.event {
        case "scan":
            feed = true
            watches = true
            server = true
            if let id = payload?.watchId { watchIDs = [id] } else { allWatches = true }
        case "watch":
            feed = true
            watches = true
            if let id = payload?.id { watchIDs = [id] } else { allWatches = true }
        case "listing-action":
            watches = true
            triage = true
            // Without a readable payload the lists can't patch themselves.
            if ListingActionEvent(event: event) == nil { feed = true }
        case "notification":
            server = true
        case "market-watch":
            research = true
            if let id = payload?.id { marketWatchIDs = [id] } else { allMarketWatches = true }
        default:
            break
        }
    }
}

/// A `listing-action` event: the listing's triage after any client changed it.
public struct ListingActionEvent: Decodable, Hashable, Sendable {
    public var key: String
    public var decision: ListingDecision?
    public var hidden: Bool
    /// Set by the app so that two identical actions in a row still differ.
    public var sequence = 0

    private enum CodingKeys: String, CodingKey {
        case key, decision, hidden
    }

    public init(key: String, decision: ListingDecision?, hidden: Bool, sequence: Int = 0) {
        self.key = key
        self.decision = decision
        self.hidden = hidden
        self.sequence = sequence
    }

    public init?(event: ServerSentEvent) {
        guard event.event == "listing-action",
              let decoded = try? JSONDecoder().decode(Self.self, from: Data(event.data.utf8))
        else { return nil }
        self = decoded
    }

    /// `rows` with the new decision applied in place, or nil when the screen
    /// has to reload instead: no loaded row has this key (it may now enter
    /// the list), or a row's hidden state changed, which also changes the
    /// dashboard stats and watch deal counts.
    public func patched(_ rows: [Listing]) -> [Listing]? {
        var rows = rows
        var matched = false
        for index in rows.indices where rows[index].key == key {
            if (rows[index].hidden ?? false) != hidden { return nil }
            rows[index].decision = decision
            matched = true
        }
        return matched ? rows : nil
    }

    /// What a list without stats (Listings) does with this action: patch
    /// decision and hidden into its rows and drop those that leave `filter`,
    /// reload when the listing isn't loaded but may now belong in the list,
    /// and otherwise nothing.
    public func triage(_ rows: [Listing], filter: ListingFilter) -> ListingTriage {
        guard rows.contains(where: { $0.key == key }) else {
            return filter.admits(decision: decision, hidden: hidden) ? .reload : .unchanged
        }
        var removed = 0
        let patched = rows.compactMap { row -> Listing? in
            guard row.key == key else { return row }
            var row = row
            row.decision = decision
            row.hidden = hidden
            guard filter.admits(row) else {
                removed += 1
                return nil
            }
            return row
        }
        return .patched(patched, removed: removed)
    }
}

/// The triage filters of a listing list.
public struct ListingFilter: Hashable, Sendable {
    public var decision: ListingDecision?
    public var visibility: ListingVisibility

    public init(decision: ListingDecision? = nil, visibility: ListingVisibility = .visible) {
        self.decision = decision
        self.visibility = visibility
    }

    public func admits(decision: ListingDecision?, hidden: Bool) -> Bool {
        switch visibility {
        case .visible where hidden, .hidden where !hidden: return false
        default: return self.decision == nil || decision == self.decision
        }
    }

    public func admits(_ listing: Listing) -> Bool {
        admits(decision: listing.decision, hidden: listing.hidden ?? false)
    }
}

/// See `ListingActionEvent.triage(_:filter:)`.
public enum ListingTriage: Equatable, Sendable {
    /// The loaded rows after the action; `removed` of them left the filters.
    case patched([Listing], removed: Int)
    /// The listing isn't loaded and may now enter the list.
    case reload
    /// The listing isn't loaded and still can't be in the list.
    case unchanged
}

/// Whether a screen that keys its load on `key` should load when it appears
/// or its key changes. It keeps what it shows when it already loaded this key
/// while live updates were connected, and for at most `maxAge`, so returning
/// to a screen (tab switch, back navigation) doesn't refetch unchanged data.
/// Without live updates nothing tells it about changes, so it always loads.
public enum ReloadPolicy {
    public static let maxAge: TimeInterval = 120

    public static func shouldLoad<Key: Equatable>(
        key: Key,
        isVisible: Bool,
        isLive: Bool,
        loadedKey: Key?,
        loadedAt: Date?,
        now: Date = Date(),
        maxAge: TimeInterval = maxAge
    ) -> Bool {
        guard isVisible else { return false }
        guard isLive, let loadedKey, loadedKey == key, let loadedAt else { return true }
        return now.timeIntervalSince(loadedAt) >= maxAge || now < loadedAt
    }

    /// How many 50-row pages a refresh of a paged list fetches in one request
    /// to keep the rows already on screen, within the route's page size limit.
    public static func pagesToKeep(loadedRows: Int, pageSize: Int = 50, maxRows: Int) -> Int {
        min(max(1, maxRows / pageSize), max(1, (loadedRows + pageSize - 1) / pageSize))
    }
}
