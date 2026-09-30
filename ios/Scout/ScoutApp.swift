import SwiftUI

@main
struct ScoutApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

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
