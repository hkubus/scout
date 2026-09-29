import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.client == nil {
                ConnectView()
            } else {
                TabView(selection: $model.selectedTab) {
                    DealsView()
                        .tabItem { Label("Deals", systemImage: "flame") }
                        .tag(AppTab.deals)
                    NavigationStack {
                        ListingsView()
                            .scoutDestinations()
                    }
                    .tabItem { Label("Listings", systemImage: "list.bullet.rectangle") }
                    .tag(AppTab.listings)
                    WatchesView()
                        .tabItem { Label("Watches", systemImage: "binoculars") }
                        .tag(AppTab.watches)
                    SettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                        .tag(AppTab.settings)
                }
            }
        }
        .tint(.scoutBlue)
        .sheet(item: $model.openedListing) { link in
            NavigationStack {
                ListingDetailView(link: link)
                    .scoutDestinations()
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { model.openedListing = nil }
                        }
                    }
            }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } }),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(model.alertMessage ?? "") }
        )
    }
}
