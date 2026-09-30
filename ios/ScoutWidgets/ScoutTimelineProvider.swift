import Foundation
import ImageIO
import UIKit
import WidgetKit
import ScoutKit

struct ScoutTimelineProvider: AppIntentTimelineProvider {
    /// WidgetKit rations reloads; the app also reloads widgets when its data changes.
    private static let refreshInterval: TimeInterval = 15 * 60

    func placeholder(in context: Context) -> ScoutWidgetEntry {
        ScoutWidgetEntry(date: Date(), snapshot: .demo, state: .ready)
    }

    func snapshot(for configuration: ScoutWidgetIntent, in context: Context) async -> ScoutWidgetEntry {
        if context.isPreview, SharedStore.loadSnapshot() == nil, LocalCache.load() == nil {
            return placeholder(in: context)
        }
        return await load(configuration)
    }

    func timeline(for configuration: ScoutWidgetIntent, in context: Context) async -> Timeline<ScoutWidgetEntry> {
        let entry = await load(configuration)
        return Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(Self.refreshInterval)))
    }

    /// Fetches fresh data from the configured server; falls back to the
    /// newest snapshot this widget or the app saved for the same server.
    private func load(_ configuration: ScoutWidgetIntent) async -> ScoutWidgetEntry {
        let saved = [LocalCache.load(), SharedStore.loadSnapshot()]
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
            var snapshot = WidgetSnapshot.make(from: try await client.dashboard(), isDemo: isDemo, source: source)
            snapshot.deals = await Thumbnails.attach(to: snapshot.deals)
            LocalCache.save(snapshot)
            return ScoutWidgetEntry(date: Date(), snapshot: snapshot, state: .ready)
        } catch {
            var fallback = WidgetSnapshot.newest(saved, from: source)
            // The app's copy has no thumbnails; reuse the widget's where the deal matches.
            if let local = saved[0], local.source == source, var snapshot = fallback {
                snapshot.deals = snapshot.deals.map { deal in
                    var deal = deal
                    deal.thumbnail = deal.thumbnail ?? local.deals.first { $0.id == deal.id }?.thumbnail
                    return deal
                }
                fallback = snapshot
            }
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

/// The widget's own copy of its last good snapshot, thumbnails included.
private enum LocalCache {
    private static let key = "lastSnapshot"

    static func save(_ snapshot: WidgetSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
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
    static func attach(to deals: [WidgetDeal]) async -> [WidgetDeal] {
        await withTaskGroup(of: (Int, Data?).self) { group in
            for (index, deal) in deals.enumerated() {
                let address = deal.imageURL
                group.addTask { (index, await Thumbnails.fetch(address)) }
            }
            var result = deals
            for await (index, data) in group {
                result[index].thumbnail = data
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
