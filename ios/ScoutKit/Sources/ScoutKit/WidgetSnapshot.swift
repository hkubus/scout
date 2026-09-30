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
        let deals = dashboard.listings
            .filter { $0.hidden != true && $0.aiFiltered != true && $0.decision != .pass }
            .sorted { lhs, rhs in
                if lhs.dealStrength != rhs.dealStrength { return lhs.dealStrength > rhs.dealStrength }
                let left = lhs.belowTypical ?? 0
                let right = rhs.belowTypical ?? 0
                if left != right { return left < right }
                return lhs.observedAt > rhs.observedAt
            }
            .prefix(limit)
            .map(WidgetDeal.init)
        return WidgetSnapshot(generatedAt: now, stats: dashboard.stats, lastScan: dashboard.lastScan, deals: Array(deals), isDemo: isDemo, source: source)
    }

    /// Same content, ignoring when it was generated and any thumbnails.
    public func hasSameContent(as other: WidgetSnapshot) -> Bool {
        var left = self
        var right = other
        left.generatedAt = .distantPast
        right.generatedAt = .distantPast
        left.deals = left.deals.map { $0.withoutThumbnail }
        right.deals = right.deals.map { $0.withoutThumbnail }
        return left == right
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

    var withoutThumbnail: WidgetDeal {
        var copy = self
        copy.thumbnail = nil
        return copy
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

    public static func saveConnection(serverURL: URL?, isDemo: Bool) {
        guard let defaults else { return }
        // Another server (or leaving the demo) makes the saved snapshot wrong.
        if defaults.string(forKey: serverURLKey) != serverURL?.absoluteString || defaults.bool(forKey: demoKey) != isDemo {
            defaults.removeObject(forKey: snapshotKey)
        }
        defaults.set(serverURL?.absoluteString, forKey: serverURLKey)
        defaults.set(isDemo, forKey: demoKey)
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

    /// Saves the snapshot; returns false when the content was unchanged.
    @discardableResult
    public static func saveSnapshot(_ snapshot: WidgetSnapshot) -> Bool {
        guard let defaults else { return false }
        if let current = loadSnapshot(), current.hasSameContent(as: snapshot) { return false }
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        defaults.set(data, forKey: snapshotKey)
        return true
    }

    public static func loadSnapshot() -> WidgetSnapshot? {
        guard let data = defaults?.data(forKey: snapshotKey) else { return nil }
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
