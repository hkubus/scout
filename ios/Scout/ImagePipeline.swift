import ImageIO
import ScoutKit
import SwiftUI
import UIKit

/// Listing photos decoded at the size they are drawn, off the main thread,
/// and kept in memory so scrolling back or revisiting doesn't download and
/// decode them again. Marketplace originals are up to 800 px (Vinted) or
/// full resolution (Allegro), several megabytes each once decoded, for a
/// 68 pt thumbnail. Concurrent requests for the same photo at the same size
/// share one download and decode.
final class ImagePipeline: @unchecked Sendable { // NSCache is thread-safe; `lock` guards the rest
    static let shared = ImagePipeline()

    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 20 << 20
        return cache
    }()

    /// A shared download and decode, cancelled once every caller waiting
    /// for it was cancelled.
    private struct Load {
        var task: Task<UIImage?, Never>
        var waiters: Int
        var cancelled = 0
    }

    private let lock = NSLock()
    private var loads: [String: Load] = [:]
    /// Bumped by `removeAll()` so loads started before it don't cache.
    private var generation = 0

    /// Point sizes for photos drawn across the screen: a detail header is at
    /// most the screen width, an enlarged photo at most its long side.
    @MainActor static var headerPoints: CGFloat { UIDevice.current.userInterfaceIdiom == .pad ? 1024 : 430 }
    @MainActor static var fullScreenPoints: CGFloat { UIDevice.current.userInterfaceIdiom == .pad ? 1366 : 932 }

    /// `pixels` is the side of the square a `fill` image covers, or the
    /// longest side a `fit` image is drawn at.
    func cached(_ url: URL, pixels: Int, fill: Bool) -> UIImage? {
        cache.object(forKey: Self.key(url, pixels: pixels, fill: fill) as NSString)
    }

    func image(
        _ url: URL,
        pixels: Int,
        fill: Bool,
        fetch: @escaping @Sendable (URL) async throws -> Data = { try await URLSession.shared.data(from: $0).0 }
    ) async -> UIImage? {
        let key = Self.key(url, pixels: pixels, fill: fill)
        if let hit = cache.object(forKey: key as NSString) { return hit }
        let task = join(key) { generation in
            Task { [self] in
                guard let data = try? await fetch(url) else { return nil }
                let decoded = await Task.detached(priority: .userInitiated) {
                    ImagePipeline.downsample(data, pixels: pixels, fill: fill)
                }.value
                guard let image = decoded else { return nil }
                store(image, key: key, generation: generation)
                return image
            }
        }
        let image = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            self.cancel(key, task: task)
        }
        finish(key, task: task)
        return image
    }

    /// Drops every decoded photo and cancels loads in flight, so nothing
    /// fetched for the previous server is shown or cached afterwards.
    func removeAll() {
        let running = lock.withLock {
            generation += 1
            defer { loads.removeAll() }
            return loads.values.map(\.task)
        }
        running.forEach { $0.cancel() }
        cache.removeAllObjects()
    }

    /// The load in flight for `key`, or a new one from `start`.
    private func join(_ key: String, start: (Int) -> Task<UIImage?, Never>) -> Task<UIImage?, Never> {
        lock.withLock {
            if var load = loads[key] {
                load.waiters += 1
                loads[key] = load
                return load.task
            }
            let task = start(generation)
            loads[key] = Load(task: task, waiters: 1)
            return task
        }
    }

    private func cancel(_ key: String, task: Task<UIImage?, Never>) {
        let cancelAll: Bool = lock.withLock {
            guard var load = loads[key], load.task == task else { return false }
            load.cancelled += 1
            if load.cancelled < load.waiters {
                loads[key] = load
                return false
            }
            loads[key] = nil
            return true
        }
        if cancelAll { task.cancel() }
    }

    /// Once a load finished its result is in the cache (or too large for
    /// it), so later requests start afresh.
    private func finish(_ key: String, task: Task<UIImage?, Never>) {
        lock.withLock {
            if loads[key]?.task == task { loads[key] = nil }
        }
    }

    private func store(_ image: UIImage, key: String, generation: Int) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        // A full-screen photo would evict every thumbnail; it stays in
        // URLCache instead.
        guard cost <= cache.totalCostLimit / 4 else { return }
        lock.withLock {
            // Checked under the lock so `removeAll()` can't run in between.
            if generation == self.generation {
                cache.setObject(image, forKey: key as NSString, cost: cost)
            }
        }
    }

    private static func key(_ url: URL, pixels: Int, fill: Bool) -> String {
        "\(pixels)|\(fill ? "fill" : "fit")|\(url.absoluteString)"
    }

    static func downsample(_ data: Data, pixels: Int, fill: Bool) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let maxPixelSize = ImageSizing.maxPixelSize(
            width: properties?[kCGImagePropertyPixelWidth] as? Int,
            height: properties?[kCGImagePropertyPixelHeight] as? Int,
            pixels: pixels,
            fill: fill
        )
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options).map { UIImage(cgImage: $0) }
    }
}

/// A photo loaded through `ImagePipeline` at `pointSize` (the side of the
/// square it fills, or the longest side it fits in), with `placeholder` until
/// it loads or when it can't.
struct PipelineImage<Placeholder: View>: View {
    var url: URL?
    var contentMode: ContentMode
    var pointSize: CGFloat
    var fetch: (@Sendable (URL) async throws -> Data)?
    var placeholder: () -> Placeholder
    @Environment(\.displayScale) private var displayScale
    @State private var loaded: (url: URL, image: UIImage)?

    init(url: URL?, contentMode: ContentMode, pointSize: CGFloat, fetch: (@Sendable (URL) async throws -> Data)? = nil, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.url = url
        self.contentMode = contentMode
        self.pointSize = pointSize
        self.fetch = fetch
        self.placeholder = placeholder
    }

    private var pixels: Int { Int((pointSize * displayScale).rounded(.up)) }
    private var fill: Bool { contentMode == .fill }

    /// The loaded photo for the current address, or a cached decode so rows
    /// scrolled back into view draw it in their first frame.
    private var image: UIImage? {
        guard let url else { return nil }
        if let loaded, loaded.url == url { return loaded.image }
        return ImagePipeline.shared.cached(url, pixels: pixels, fill: fill)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            guard let url, image == nil else { return }
            let decoded: UIImage?
            if let fetch {
                decoded = await ImagePipeline.shared.image(url, pixels: pixels, fill: fill, fetch: fetch)
            } else {
                decoded = await ImagePipeline.shared.image(url, pixels: pixels, fill: fill)
            }
            if let decoded { loaded = (url, decoded) }
        }
    }
}
