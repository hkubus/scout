import SwiftUI

enum MarketSection: String, Hashable {
    case research, analytics, flips

    var title: String {
        switch self {
        case .research: "Research"
        case .analytics: "Analytics"
        case .flips: "Flips"
        }
    }
}

/// The Market tab: research watches, deal analytics, and the flip ledger
/// behind one switch.
struct MarketView: View {
    @Environment(AppModel.self) private var model
    // Held here because the switch below rebuilds each segment's view.
    @State private var research = ResearchStore()
    @State private var analytics = AnalyticsStore()

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Group {
                switch model.marketSection {
                case .research: ResearchView(store: research)
                case .analytics: AnalyticsView(store: analytics)
                case .flips: FlipsView()
                }
            }
            .navigationTitle(Text(verbatim: model.marketSection.title))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Section", selection: $model.marketSection) {
                        Text("Research").tag(MarketSection.research)
                        Text("Analytics").tag(MarketSection.analytics)
                        Text("Flips").tag(MarketSection.flips)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 280)
                }
            }
            .scoutDestinations()
        }
    }
}
