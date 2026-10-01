import SwiftUI
import ScoutKit

/// What a screen last loaded and when. Screens that SwiftUI rebuilds while
/// their data lives elsewhere (the Market segments) keep one in that store.
final class LoadMemory {
    var key: AnyHashable?
    var loadedAt: Date?
}

/// Loads when the screen first appears and whenever `key` changes, like
/// `.task(id: key)`, but re-appearing (tab switch, back navigation) keeps what
/// is on screen when nothing changed since it loaded; see `ReloadPolicy`.
/// `load` returns true once its data is on screen and false on errors and
/// cancellation, which leave the screen to load again next time.
struct ReloadOnChange<Key: Hashable>: ViewModifier {
    @Environment(AppModel.self) private var model
    var key: Key
    var memory: LoadMemory?
    var load: () async -> Bool
    @State private var ownMemory = LoadMemory()
    @State private var isVisible = false

    private struct Trigger: Hashable {
        var key: Key
        var isVisible: Bool
    }

    func body(content: Content) -> some View {
        let trigger = Trigger(key: key, isVisible: isVisible)
        return content
            .onAppear { isVisible = true }
            .onDisappear { isVisible = false }
            .task(id: trigger) {
                let loaded = memory ?? ownMemory
                guard ReloadPolicy.shouldLoad(
                    key: AnyHashable(trigger.key),
                    isVisible: trigger.isVisible,
                    isLive: model.connection == .live,
                    loadedKey: loaded.key,
                    loadedAt: loaded.loadedAt
                ) else { return }
                if await load() {
                    loaded.key = AnyHashable(trigger.key)
                    loaded.loadedAt = Date()
                }
            }
    }
}

extension View {
    @MainActor
    func reloadOnChange<Key: Hashable>(of key: Key, memory: LoadMemory? = nil, load: @escaping () async -> Bool) -> some View {
        modifier(ReloadOnChange(key: key, memory: memory, load: load))
    }
}
