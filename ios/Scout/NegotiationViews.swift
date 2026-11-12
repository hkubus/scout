import SwiftUI
import ScoutKit

/// Your recorded negotiations (all time), as on the web: what you pay as a
/// share of asking, by marketplace, and on Analytics by watch. A group's
/// share shows only once it has `minAgreed` agreed negotiations.
struct NegotiationOutcomesSection: View {
    var figures: NegotiationFigures
    /// On Analytics with no watch picked: a row per watch.
    var showsWatches = false

    var body: some View {
        Section {
            if figures.roles.isEmpty {
                Text("No recorded negotiations match these filters.")
                    .foregroundStyle(.secondary)
            }
            ForEach(figures.roles) { entry in
                LabeledContent {
                    Text(share(entry.outcomes.total)).monospacedDigit()
                } label: {
                    Text(entry.role == .buy ? "You pay" : "Buyers pay you")
                    Text("\(entry.role == .buy ? "of asking" : "of your asking") · \(counts(entry.outcomes.total))")
                }
                ForEach(entry.outcomes.marketplaceShares) { item in
                    LabeledContent {
                        Text(share(item.outcome)).monospacedDigit()
                    } label: {
                        MarketplaceTag(marketplace: item.marketplace)
                        Text(counts(item.outcome))
                    }
                }
                if showsWatches {
                    ForEach(entry.outcomes.watches) { watch in
                        LabeledContent {
                            Text(share(watch.total)).monospacedDigit()
                        } label: {
                            Text(watch.name)
                            Text(watchDetail(watch))
                        }
                    }
                }
            }
        } header: {
            Text("Your negotiations")
        } footer: {
            Text("All time. Final prices from negotiations Hatbot recorded, as a share of the asking price; a share shows once a group has \(figures.minAgreed) agreed. They never feed typical prices.")
        }
    }

    /// "84%", or "—" below the minimum.
    private func share(_ outcome: OutcomeShare) -> String {
        outcome.shownShare(minAgreed: figures.minAgreed).map { Format.percent($0 * 100, digits: 0) } ?? "—"
    }

    /// "5 agreed of 7", plus what is missing below the minimum.
    private func counts(_ outcome: OutcomeShare) -> String {
        let counts = "\(outcome.agreed) agreed of \(outcome.negotiations)"
        return outcome.agreed >= figures.minAgreed ? counts : "\(counts) · needs \(figures.minAgreed)"
    }

    /// The watch's counts, then its marketplaces when it has more than one.
    private func watchDetail(_ watch: WatchOutcomes) -> String {
        let marketplaces = watch.marketplaceShares
        guard marketplaces.count > 1 else { return counts(watch.total) }
        return ([counts(watch.total)] + marketplaces.map { "\($0.marketplace.rawValue) \(share($0.outcome))" }).joined(separator: " · ")
    }
}
