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
                .task { model.startLiveUpdates() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        model.startLiveUpdates()
                        model.refresh()
                    case .background:
                        model.stopLiveUpdates()
                    default:
                        break
                    }
                }
        }
    }
}
