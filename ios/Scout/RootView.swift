import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.client == nil {
                ConnectView()
            } else if #available(iOS 18, *) {
                // The search role puts Search apart from the other tabs, at
                // the trailing end of the tab bar.
                TabView(selection: $model.selectedTab) {
                    Tab("Deals", systemImage: "flame", value: AppTab.deals) {
                        DealsView().undoToastHost()
                    }
                    .badge(model.untriagedDeals)
                    Tab("Flips", systemImage: "shippingbox", value: AppTab.flips) {
                        FlipsTab().undoToastHost()
                    }
                    Tab("Market", systemImage: "chart.xyaxis.line", value: AppTab.market) {
                        MarketView().undoToastHost()
                    }
                    Tab(value: AppTab.search, role: .search) {
                        SearchView().undoToastHost()
                    }
                }
            } else {
                TabView(selection: $model.selectedTab) {
                    DealsView().undoToastHost()
                        .tabItem { Label("Deals", systemImage: "flame") }
                        .badge(model.untriagedDeals)
                        .tag(AppTab.deals)
                    FlipsTab().undoToastHost()
                        .tabItem { Label("Flips", systemImage: "shippingbox") }
                        .tag(AppTab.flips)
                    MarketView().undoToastHost()
                        .tabItem { Label("Market", systemImage: "chart.xyaxis.line") }
                        .tag(AppTab.market)
                    SearchView().undoToastHost()
                        .tabItem { Label("Search", systemImage: "magnifyingglass") }
                        .tag(AppTab.search)
                }
            }
        }
        .tint(.scoutBlue)
        .onChange(of: QuickActions.shared.pending, initial: true) { _, url in
            guard let url else { return }
            QuickActions.shared.pending = nil
            model.open(url)
        }
        .sensoryFeedback(trigger: model.haptic) { _, event in
            switch event?.kind {
            case .success: .success
            case .selection: .selection
            case .impact: .impact(weight: .medium)
            case .error: .error
            case nil: nil
            }
        }
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
