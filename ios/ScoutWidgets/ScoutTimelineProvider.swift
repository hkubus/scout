import Foundation
import ImageIO
import UIKit
import WidgetKit
import ScoutKit

struct ScoutTimelineProvider: AppIntentTimelineProvider {
    /// WidgetKit rations reloads; the app also reloads widgets when its data changes.
    private static let refreshInterval: TimeInterval = 15 * 60
    /// The widget shows 6 deals at most; asking the server for a few more
    /// keeps its ties in the same order as `WidgetSnapshot.make`'s re-sort.
    private static let dashboardTop = 12
    /// Shorter than the app's 20 s: an unreachable LAN or VPN server
    /// otherwise keeps the extension and radio busy for each timeline.
    private static let dashboardTimeout: TimeInterval = 10

    /// Whether this widget kind draws deal photos (Top deals does, Summary
    /// doesn't), so only the ones it shows are downloaded.
    var drawsThumbnails: Bool

    func placeholder(in context: Context) -> ScoutWidgetEntry {
        ScoutWidgetEntry(date: Date(), snapshot: .demo, state: .ready)
    }

    func snapshot(for configuration: ScoutWidgetIntent, in context: Context) async -> ScoutWidgetEntry {
        if context.isPreview, SharedStore.loadSnapshot() == nil, LocalCache.load() == nil {
            return placeholder(in: context)
        }
        return await load(configuration, thumbnails: thumbnailCount(in: context))
    }

    func timeline(for configuration: ScoutWidgetIntent, in context: Context) async -> Timeline<ScoutWidgetEntry> {
        let entry = await load(configuration, thumbnails: thumbnailCount(in: context))
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refreshInterval)))
    }

    private func thumbnailCount(in context: Context) -> Int {
        WidgetLayout(context.family).thumbnailCount(drawsThumbnails: drawsThumbnails)
    }

    /// Fetches fresh data from the configured server, unless the app saved
    /// some for the same server within the last minute; falls back to the
    /// newest snapshot this widget or the app saved for the same server.
    private func load(_ configuration: ScoutWidgetIntent, thumbnails: Int) async -> ScoutWidgetEntry {
        let local = LocalCache.load()
        let shared = SharedStore.loadSnapshot()
        let saved = [local, shared]
        let anyCached = saved.compactMap { $0 }.max { $0.generatedAt < $1.generatedAt }
        let address = configuration.serverAddress?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let client: ScoutClient
        var isDemo = false
        var usesAppServer = true
        if !address.isEmpty {
            guard let url = try? ServerAddress.normalize(address) else {
                return ScoutWidgetEntry(date: Date(), snapshot: anyCached, state: .offline("The server address in this widget's settings isn't valid."))
            }
            // Only send the app's token to the server the app connected to.
            usesAppServer = url == SharedStore.serverURL
            client = ScoutClient(baseURL: url, apiToken: usesAppServer ? SharedStore.apiToken : nil)
        } else if SharedStore.isDemo {
            client = ScoutClient(baseURL: DemoTransport.baseURL, transport: DemoTransport())
            isDemo = true
        } else if let url = SharedStore.serverURL {
            client = ScoutClient(baseURL: url, apiToken: SharedStore.apiToken)
        } else if SharedStore.isAvailable {
            return ScoutWidgetEntry(date: Date(), snapshot: nil, state: .notConfigured)
        } else {
            let hint = "Edit the widget and enter your server address."
            return ScoutWidgetEntry(date: Date(), snapshot: anyCached, state: anyCached == nil ? .offline(hint) : .offline("Showing saved data. \(hint)"))
        }

        let source = WidgetSnapshot.source(serverURL: client.baseURL, isDemo: isDemo)
        do {
            var snapshot: WidgetSnapshot
            if let shared, shared.isFresh(for: source, maxAge: WidgetFeed.maxAge) {
                // The app just loaded the same dashboard and reloaded widgets.
                snapshot = shared
            } else {
                snapshot = try await WidgetFeed.shared.snapshot(for: source) { [isDemo] in
                    WidgetSnapshot.make(from: try await client.dashboard(top: Self.dashboardTop, timeout: Self.dashboardTimeout), isDemo: isDemo, source: source)
                }
            }
            // Only download photos the widget hasn't saved already.
            snapshot.reuseThumbnails(from: [local])
            snapshot = await Thumbnails.attach(to: snapshot, limit: thumbnails)
            await WidgetFeed.shared.save(snapshot)
            return ScoutWidgetEntry(date: Date(), snapshot: snapshot, state: .ready)
        } catch {
            var fallback = WidgetSnapshot.newest(saved, from: source)
            // The app's copy has no thumbnails; reuse the widget's for the same photos.
            fallback?.reuseThumbnails(from: [local])
            return ScoutWidgetEntry(date: Date(), snapshot: fallback, state: .offline(Self.message(for: error, usesAppServer: usesAppServer)))
        }
    }

    /// The client's sign-in errors tell the user to enter a token, which the
    /// widget has no field for; it can only borrow the app's.
    private static func message(for error: Error, usesAppServer: Bool) -> String {
        guard case let ScoutAPIError.unauthorized(tokenProvided) = error else { return error.localizedDescription }
        if !usesAppServer {
            return "This server requires sign-in. Widgets can only use the app's API token, so edit the widget and enter the server the app is connected to, or leave the address blank."
        }
        return tokenProvided
            ? "The server rejected the app's API token. Update it in the Scout app's Settings."
            : "This server requires sign-in. Add an API token in the Scout app's Settings."
    }
}

/// Shares one dashboard load per server among the timelines WidgetKit
/// requests together (each widget kind, size and configuration has its own),
/// and reuses it for a minute. Failures aren't kept, so the next timeline
/// tries again.
private actor WidgetFeed {
    static let shared = WidgetFeed()
    static let maxAge: TimeInterval = 60

    private var loads: [String: (startedAt: Date, task: Task<WidgetSnapshot, Error>)] = [:]

    func snapshot(for source: String?, fetch: @escaping @Sendable () async throws -> WidgetSnapshot) async throws -> WidgetSnapshot {
        let key = source ?? ""
        if let load = loads[key], Date().timeIntervalSince(load.startedAt) < Self.maxAge {
            return try await load.task.value
        }
        let task = Task { try await fetch() }
        loads[key] = (Date(), task)
        do {
            return try await task.value
        } catch {
            if loads[key]?.task == task { loads[key] = nil }
            throw error
        }
    }

    /// Saves through the actor so concurrent timelines merge their
    /// thumbnails one at a time instead of overwriting each other's.
    func save(_ snapshot: WidgetSnapshot) {
        LocalCache.save(snapshot)
    }
}

private extension WidgetLayout {
    init(_ family: WidgetFamily) {
        switch family {
        case .systemSmall: self = .systemSmall
        case .systemMedium: self = .systemMedium
        case .systemLarge: self = .systemLarge
        default: self = .other
        }
    }
}

/// The widget's own copy of its last good snapshot, thumbnails included.
private enum LocalCache {
    private static let key = "lastSnapshot"

    /// Keeps the saved thumbnails of photos `snapshot` still shows but didn't
    /// download (the Summary widget downloads none, a small Top deals widget
    /// one), and skips the write when nothing drawn changed, as the app does
    /// for the App Group copy.
    static func save(_ snapshot: WidgetSnapshot) {
        let current = load()
        var merged = snapshot
        merged.reuseThumbnails(from: [current])
        guard WidgetSnapshot.shouldReplace(current, with: merged)
            || current?.deals.map(\.thumbnail) != merged.deals.map(\.thumbnail)
        else { return }
        guard let data = try? JSONEncoder().encode(merged) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func load() -> WidgetSnapshot? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

/// Widgets render synchronously, so listing photos are downloaded and shrunk
/// while building the timeline.
private enum Thumbnails {
    /// Downloads the photos of the first `limit` deals that don't have one yet.
    static func attach(to snapshot: WidgetSnapshot, limit: Int) async -> WidgetSnapshot {
        let missing = snapshot.dealsMissingThumbnails(limit: limit)
        guard !missing.isEmpty else { return snapshot }
        return await withTaskGroup(of: (Int, Data?).self) { group in
            for index in missing {
                let address = snapshot.deals[index].imageURL
                group.addTask { (index, await Thumbnails.fetch(address)) }
            }
            var result = snapshot
            for await (index, data) in group {
                result.deals[index].thumbnail = data
            }
            return result
        }
    }

    private static func fetch(_ address: String) async -> Data? {
        guard let url = URL(string: address), url.scheme == "https" || url.scheme == "http" else { return nil }
        let request = URLRequest(url: url, timeoutInterval: 8)
        guard let result = try? await URLSession.shared.data(for: request),
              (result.1 as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return downsample(result.0, maxPixelSize: 160)
    }

    private static func downsample(_ data: Data, maxPixelSize: Int) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: image).jpegData(compressionQuality: 0.8)
    }
}
