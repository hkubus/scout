import SwiftUI

@main
struct ScoutApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Before any request. The default cache (512 KB in memory, 10 MB on
        // disk, nothing over ~500 KB stored) lets listing photos evict each
        // other and never keeps larger saved photos, which the server marks
        // immutable. API responses are no-store, so they don't fill it.
        URLCache.shared = URLCache(memoryCapacity: 8 << 20, diskCapacity: 100 << 20, directory: nil)
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.open($0) }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    switch phase {
                    case .active:
                        model.resumeLiveUpdates()
                    case .background:
                        model.stopLiveUpdates()
                    default:
                        break
                    }
                }
        }
    }
}
