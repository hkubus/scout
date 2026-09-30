import SwiftUI

enum MarketSection: String, Hashable {
    case research, analytics
}

/// The Market tab: research watches and deal analytics behind one switch.
struct MarketView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Group {
                switch model.marketSection {
                case .research: ResearchView()
                case .analytics: AnalyticsView()
                }
            }
            .navigationTitle(Text(verbatim: model.marketSection == .research ? "Research" : "Analytics"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Section", selection: $model.marketSection) {
                        Text("Research").tag(MarketSection.research)
                        Text("Analytics").tag(MarketSection.analytics)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 220)
                }
            }
            .scoutDestinations()
        }
    }
}
