import Foundation
#if canImport(Security)
import Security
#endif

/// What the home screen widgets show: headline stats and the strongest
/// current deals. The app saves one after each dashboard load so the widget
/// has something to show even when it can't reach the server itself.
public struct WidgetSnapshot: Codable, Hashable, Sendable {
    public var generatedAt: Date
    public var stats: DashboardStats
    public var lastScan: String
    public var deals: [WidgetDeal]
    public var isDemo: Bool
    /// Where the data came from (`source(serverURL:isDemo:)`), so a snapshot
    /// from another server or the demo is never shown for the current one.
    public var source: String?

    public init(generatedAt: Date, stats: DashboardStats, lastScan: String, deals: [WidgetDeal], isDemo: Bool, source: String? = nil) {
        self.generatedAt = generatedAt
        self.stats = stats
        self.lastScan = lastScan
        self.deals = deals
        self.isDemo = isDemo
        self.source = source
    }

    public static func source(serverURL: URL?, isDemo: Bool) -> String? {
        isDemo ? "demo" : serverURL?.absoluteString
    }

    /// The newest of the given snapshots that came from `source`.
    public static func newest(_ snapshots: [WidgetSnapshot?], from source: String?) -> WidgetSnapshot? {
        snapshots.compactMap { $0 }.filter { $0.source == source }.max { $0.generatedAt < $1.generatedAt }
    }

    /// Strongest visible deals first, then the biggest discount, then the newest.
    public static func make(from dashboard: DashboardData, isDemo: Bool = false, source: String? = nil, limit: Int = 6, now: Date = Date()) -> WidgetSnapshot {
        let deals = ranked(dashboard.listings).prefix(limit).map(WidgetDeal.init)
        return WidgetSnapshot(generatedAt: now, stats: dashboard.stats, lastScan: dashboard.lastScan, deals: Array(deals), isDemo: isDemo, source: source)
    }

    /// The listings a widget may show, in the order it shows them. The server's
    /// `/api/dashboard?top=N` applies the same filter and stable sort.
    public static func ranked(_ listings: [Listing]) -> [Listing] {
        listings
            .filter { $0.hidden != true && $0.aiFiltered != true && $0.decision != .pass }
            .sorted { lhs, rhs in
                if lhs.dealStrength != rhs.dealStrength { return lhs.dealStrength > rhs.dealStrength }
                let left = lhs.belowTypical ?? 0
                let right = rhs.belowTypical ?? 0
                if left != right { return left < right }
                return lhs.observedAt > rhs.observedAt
            }
    }

    /// Same content as the widgets draw it. Ignores when it was generated,
    /// thumbnails (they follow `imageURL`) and fields no widget shows, such as
    /// `lastScan` and each deal's `observedAt`, `typical` and `dealStrength`,
    /// which change on nearly every scan.
    public func hasSameContent(as other: WidgetSnapshot) -> Bool {
        rendered == other.rendered
    }

    /// Whether `snapshot` should replace `current` in the App Group, which
    /// reloads every widget: when what they draw changed, or when the saved
    /// copy is `refreshAfter` older so the "Updated" time and an offline
    /// widget still catch up while the app stays open.
    public static func shouldReplace(_ current: WidgetSnapshot?, with snapshot: WidgetSnapshot, refreshAfter: TimeInterval = 15 * 60) -> Bool {
        guard let current, current.hasSameContent(as: snapshot) else { return true }
        return snapshot.generatedAt.timeIntervalSince(current.generatedAt) >= refreshAfter
    }

    /// Whether this snapshot came from `source` less than `maxAge` ago, so a
    /// widget can show it instead of fetching the same data again.
    public func isFresh(for source: String?, maxAge: TimeInterval, now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(generatedAt)
        return self.source == source && age >= 0 && age < maxAge
    }

    /// Fills in missing thumbnails from `snapshots` (for example the widget's
    /// last cache) wherever a deal has the same photo address.
    public mutating func reuseThumbnails(from snapshots: [WidgetSnapshot?]) {
        var cache: [String: Data] = [:]
        for deal in snapshots.compactMap({ $0 }).flatMap(\.deals) where !deal.imageURL.isEmpty {
            if cache[deal.imageURL] == nil, let thumbnail = deal.thumbnail { cache[deal.imageURL] = thumbnail }
        }
        guard !cache.isEmpty else { return }
        for index in deals.indices where deals[index].thumbnail == nil {
            deals[index].thumbnail = cache[deals[index].imageURL]
        }
    }

    /// Indexes of the first `limit` deals that still need a thumbnail downloaded.
    public func dealsMissingThumbnails(limit: Int) -> [Int] {
        deals.indices.prefix(max(0, limit)).filter { deals[$0].thumbnail == nil && !deals[$0].imageURL.isEmpty }
    }

    private struct Rendered: Equatable {
        var isDemo: Bool
        var source: String?
        var watching: Int
        var newToday: Int
        var strongDeals: Int
        var deals: [RenderedDeal]
    }

    private struct RenderedDeal: Equatable {
        var key: String
        var watchId: String?
        var title: String
        var price: String
        var discount: String?
        var dealLabel: DealLabel
        var marketplace: Marketplace
        var imageURL: String
    }

    private var rendered: Rendered {
        Rendered(
            isDemo: isDemo,
            source: source,
            watching: stats.watching,
            newToday: stats.newToday,
            strongDeals: stats.strongDeals,
            deals: deals.map {
                RenderedDeal(
                    key: $0.key, watchId: $0.watchId, title: $0.title,
                    price: WidgetFormat.pln($0.price), discount: WidgetFormat.discount($0.belowTypical),
                    dealLabel: $0.dealLabel, marketplace: $0.marketplace, imageURL: $0.imageURL
                )
            }
        )
    }
}

/// Which widget layout a timeline is for, so ScoutKit can reason about it
/// without WidgetKit.
public enum WidgetLayout: Sendable {
    case systemSmall, systemMedium, systemLarge, other

    /// How many deal photos the widget draws: the Top deals small widget
    /// shows 1, large 6 and every other size 3; the Summary widget none.
    public func thumbnailCount(drawsThumbnails: Bool) -> Int {
        guard drawsThumbnails else { return 0 }
        switch self {
        case .systemSmall: return 1
        case .systemLarge: return 6
        case .systemMedium, .other: return 3
        }
    }
}

/// How widgets write prices and discounts. The content comparison uses the
/// same text, so a change that doesn't show never reloads the widgets.
public enum WidgetFormat {
    public static func pln(_ value: Double) -> String {
        value.formatted(.currency(code: "PLN").precision(.fractionLength(0)).locale(Locale(identifier: "pl_PL")))
    }

    public static func discount(_ belowTypical: Double?) -> String? {
        guard let belowTypical, belowTypical < 0 else { return nil }
        return "−\(Int(abs(belowTypical).rounded()))%"
    }
}

public struct WidgetDeal: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var watchId: String?
    public var title: String
    public var price: Double
    public var typical: Double?
    public var belowTypical: Double?
    public var dealLabel: DealLabel
    public var dealStrength: Double
    public var marketplace: Marketplace
    public var observedAt: String
    public var imageURL: String
    /// Downscaled JPEG fetched by the widget; widgets cannot load images lazily.
    public var thumbnail: Data?

    public var id: String { "\(watchId ?? ""):\(key)" }

    public init(_ listing: Listing) {
        key = listing.key
        watchId = listing.watchId
        title = listing.title
        price = listing.price
        typical = listing.typical
        belowTypical = listing.belowTypical
        dealLabel = listing.dealLabel
        dealStrength = listing.dealStrength
        marketplace = listing.marketplace
        observedAt = listing.observedAt
        imageURL = listing.image
        thumbnail = nil
    }

    /// Opens the listing in the app: `scout://listing?key=…&watchId=…`.
    public var deepLink: URL {
        var components = URLComponents()
        components.scheme = "scout"
        components.host = "listing"
        components.queryItems = [URLQueryItem(name: "key", value: key)] + (watchId.map { [URLQueryItem(name: "watchId", value: $0)] } ?? [])
        return components.url!
    }
}

/// Settings and data shared between the app and its widget extension through
/// an App Group. SideStore re-signs with a free Apple ID and renames the group,
/// recording the real identifier under `ALTAppGroups` in Info.plist, so every
/// candidate is tried and the first one the process is entitled to wins.
public enum SharedStore {
    public static let defaultAppGroup = "group.io.github.hkubus.scout"
    public static let widgetKinds = ["ScoutDeals", "ScoutSummary"]

    private static let serverURLKey = "serverURL"
    private static let demoKey = "demo"
    private static let snapshotKey = "widgetSnapshot"

    /// Candidate groups: this bundle's `ALTAppGroups`, the containing app's
    /// (when running as an extension), then the identifier from the project.
    public static func candidateGroups(bundle: Bundle = .main) -> [String] {
        var groups: [String] = []
        func add(_ info: [String: Any]?) {
            for group in info?["ALTAppGroups"] as? [String] ?? [] where !groups.contains(group) {
                groups.append(group)
            }
        }
        add(bundle.infoDictionary)
        if bundle.bundleURL.pathExtension == "appex" {
            let appURL = bundle.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
            add(Bundle(url: appURL)?.infoDictionary)
        }
        if !groups.contains(defaultAppGroup) { groups.append(defaultAppGroup) }
        return groups
    }

    /// The first group this process can actually use, if any. Entitlements
    /// don't change while the process runs, so it is looked up once.
    public static let appGroup: String? = {
        // On macOS containerURL returns a URL even without the entitlement, so
        // the check only means something on iOS.
        #if os(iOS)
        candidateGroups().first { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil }
        #else
        nil
        #endif
    }()

    public static var isAvailable: Bool { appGroup != nil }

    private static var defaults: UserDefaults? {
        appGroup.flatMap(UserDefaults.init(suiteName:))
    }

    /// Saves which server (or the demo) widgets should use. Returns whether
    /// that changed, so the app can skip reloading widgets when it didn't;
    /// without an App Group nothing can be compared and it returns true.
    @discardableResult
    public static func saveConnection(serverURL: URL?, isDemo: Bool) -> Bool {
        guard let defaults else { return true }
        return saveConnection(serverURL: serverURL, isDemo: isDemo, in: defaults)
    }

    static func saveConnection(serverURL: URL?, isDemo: Bool, in defaults: UserDefaults) -> Bool {
        // Another server (or leaving the demo) makes the saved snapshot wrong.
        let changed = defaults.string(forKey: serverURLKey) != serverURL?.absoluteString || defaults.bool(forKey: demoKey) != isDemo
        if changed {
            defaults.removeObject(forKey: snapshotKey)
        }
        defaults.set(serverURL?.absoluteString, forKey: serverURLKey)
        defaults.set(isDemo, forKey: demoKey)
        return changed
    }

    /// The API token for `serverURL`. It lives in the Keychain under the App
    /// Group's access group, which the widget extension can read too. Without
    /// an App Group it is kept in the app's default access group, and a token
    /// found there is moved into the group once one is available.
    public static var apiToken: String? {
        #if canImport(Security)
        TokenKeychain.read(accessGroup: appGroup)
        #else
        nil
        #endif
    }

    /// Saves the token, or removes it when `nil` or empty.
    public static func saveAPIToken(_ token: String?) throws {
        #if canImport(Security)
        try TokenKeychain.write(token, accessGroup: appGroup)
        #endif
    }

    public static var serverURL: URL? {
        defaults?.string(forKey: serverURLKey).flatMap(URL.init(string:))
    }

    public static var isDemo: Bool {
        defaults?.bool(forKey: demoKey) ?? false
    }

    /// Saves the snapshot; returns false when it didn't replace the saved one
    /// (see `WidgetSnapshot.shouldReplace`), so widgets needn't reload.
    @discardableResult
    public static func saveSnapshot(_ snapshot: WidgetSnapshot, refreshAfter: TimeInterval = 15 * 60) -> Bool {
        guard let defaults else { return false }
        return saveSnapshot(snapshot, refreshAfter: refreshAfter, in: defaults)
    }

    static func saveSnapshot(_ snapshot: WidgetSnapshot, refreshAfter: TimeInterval, in defaults: UserDefaults) -> Bool {
        guard WidgetSnapshot.shouldReplace(loadSnapshot(from: defaults), with: snapshot, refreshAfter: refreshAfter) else { return false }
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: snapshotKey)
        return true
    }

    public static func loadSnapshot() -> WidgetSnapshot? {
        defaults.flatMap(loadSnapshot(from:))
    }

    static func loadSnapshot(from defaults: UserDefaults) -> WidgetSnapshot? {
        guard let data = defaults.data(forKey: snapshotKey) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

/// Why the API token couldn't be saved to or removed from the Keychain.
public struct TokenStorageError: Error, Equatable, LocalizedError {
    public enum Operation: String, Sendable {
        /// Adding the new token failed; any earlier token is already gone.
        case save
        /// Removing the earlier token failed, so it may still be stored.
        case remove
    }

    public var operation: Operation
    public var status: Int32

    public init(operation: Operation, status: Int32) {
        self.operation = operation
        self.status = status
    }

    /// The Keychain's explanation of `status`.
    public var reason: String {
        #if canImport(Security)
        if let message = SecCopyErrorMessageString(status, nil) as String? { return "\(message) (\(status))" }
        #endif
        return "error \(status)"
    }

    public var errorDescription: String? {
        "Couldn't \(operation.rawValue) the API token in the Keychain: \(reason)."
    }
}

#if canImport(Security)
private enum TokenKeychain {
    private static let service = "io.github.hkubus.scout.api-token"

    /// Without an access group, lookups and deletes cover every group this
    /// process can use, and adds go to its default group.
    private static func query(_ accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "default",
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    /// Tries the App Group first, then any group, which finds a token saved
    /// while no App Group was available; that one is moved into the group.
    static func read(accessGroup: String?) -> String? {
        if let accessGroup, let token = copy(accessGroup) { return token }
        guard let token = copy(nil) else { return nil }
        if accessGroup != nil { try? write(token, accessGroup: accessGroup) }
        return token
    }

    private static func copy(_ accessGroup: String?) -> String? {
        var lookup = query(accessGroup)
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ token: String?, accessGroup: String?) throws {
        let token = token ?? ""
        // Remove every copy, including one in the default group, so a cleared
        // token can't come back through the fallback lookup in `read`.
        let deleted = SecItemDelete(query(nil) as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            throw TokenStorageError(operation: .remove, status: deleted)
        }
        guard !token.isEmpty else { return }
        var item = query(accessGroup)
        item[kSecValueData as String] = Data(token.utf8)
        // Widgets refresh while the phone is locked.
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var added = SecItemAdd(item as CFDictionary, nil)
        if added == errSecMissingEntitlement, accessGroup != nil {
            // Signed without the group as a Keychain access group: keep the
            // token for the app at least, in its default group.
            item.removeValue(forKey: kSecAttrAccessGroup as String)
            added = SecItemAdd(item as CFDictionary, nil)
        }
        guard added == errSecSuccess else { throw TokenStorageError(operation: .save, status: added) }
    }
}
#endif
