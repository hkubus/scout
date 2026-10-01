import Charts
import SwiftUI
import ScoutKit

/// The Analytics screen's filters and data. MarketView owns it, so switching
/// to Research and back keeps them instead of reloading from 30d/All.
@MainActor
@Observable
final class AnalyticsStore {
    var days = 30
    var watchId: String?
    var marketplace: Marketplace?
    var watches: [Watch] = []
    /// `AppModel.watchesToken` when `watches` was fetched.
    var watchesLoadedFor: Int?
    var data: AnalyticsData?
    var error: String?
    let memory = LoadMemory()
}

/// Deal analytics across watches, like the web Analytics page. Discounts
/// compare asking prices with each watch's learned typical asking price.
struct AnalyticsView: View {
    @Environment(AppModel.self) private var model
    @Bindable var store: AnalyticsStore

    private struct LoadKey: Hashable {
        var days: Int
        var watchId: String?
        var marketplace: Marketplace?
        var watchesToken: Int
    }

    var body: some View {
        let days = store.days
        let watchId = store.watchId
        let marketplace = store.marketplace
        List {
            Section {
                Picker("Range", selection: $store.days) {
                    Text("7d").tag(7)
                    Text("30d").tag(30)
                    Text("90d").tag(90)
                    Text("180d").tag(180)
                }
                .pickerStyle(.segmented)
                if watchId != nil || marketplace != nil {
                    HStack {
                        Text(verbatim: filterSummary)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear") {
                            store.watchId = nil
                            store.marketplace = nil
                        }
                        .font(.footnote)
                    }
                }
            }

            if let data = store.data {
                content(data)
            }
        }
        .overlay { LoadingOverlay(isLoaded: store.data != nil, error: store.error, retry: { await load() }) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Watch", selection: $store.watchId) {
                        Text("All watches").tag(String?.none)
                        ForEach(store.watches) { watch in
                            Text(watch.name).tag(String?.some(watch.id))
                        }
                    }
                    Picker("Marketplace", selection: $store.marketplace) {
                        Text("All marketplaces").tag(Marketplace?.none)
                        ForEach(Marketplace.all, id: \.self) { marketplace in
                            Text(marketplace.rawValue).tag(Marketplace?.some(marketplace))
                        }
                    }
                } label: {
                    Label("Filter", systemImage: watchId == nil && marketplace == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .refreshable { await load() }
        .reloadOnChange(of: LoadKey(days: days, watchId: watchId, marketplace: marketplace, watchesToken: model.watchesToken), memory: store.memory) { await load() }
    }

    private var filterSummary: String {
        let watchName = store.watches.first { $0.id == store.watchId }?.name
        return [watchName, store.marketplace?.rawValue].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder
    private func content(_ data: AnalyticsData) -> some View {
        Section("Overview") {
            StatGrid(items: [
                StatGrid.Item(title: "Tracked listings", value: "\(data.overview.trackedListings)", detail: "\(data.overview.newListings) new in range"),
                StatGrid.Item(title: "Strong deals", value: "\(data.overview.strongDeals)", detail: "≥12% below typical"),
                StatGrid.Item(title: "Median discount", value: Format.percent(data.overview.medianDiscountPercent), detail: "below typical"),
                StatGrid.Item(title: "Median move", value: store.watchId == nil ? "—" : Format.percent(medianMove(data.trend)), detail: store.watchId == nil ? "pick a watch" : "first to last day"),
            ])
        }

        // A median across unrelated products means nothing, so the chart needs one watch.
        Section("Median asking price") {
            if store.watchId != nil {
                PriceBandChart(points: data.trend.compactMap { PriceBandPoint($0) })
                    .frame(height: 170)
                    .padding(.vertical, 6)
            } else {
                Picker("Watch", selection: $store.watchId) {
                    Text("Pick a watch").tag(String?.none)
                    ForEach(store.watches) { watch in
                        Text(watch.name).tag(String?.some(watch.id))
                    }
                }
            }
        }

        Section("Discount distribution") {
            Chart {
                ForEach(data.discountDistribution, id: \.label) { bucket in
                    BarMark(x: .value("Discount", bucket.label), y: .value("Listings", bucket.count))
                        .foregroundStyle(Color.scoutBlue)
                        .annotation(position: .top) {
                            Text("\(bucket.count)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                }
            }
            .frame(height: 140)
            .padding(.vertical, 6)
        }

        if !data.watchLeaderboard.isEmpty {
            Section("Watch performance") {
                ForEach(data.watchLeaderboard, id: \.watchId) { row in
                    LabeledContent {
                        Text(Format.percent(row.medianDiscountPercent))
                            .monospacedDigit()
                    } label: {
                        Text(row.watchName)
                        Text("\(row.listings) listings · \(row.strongDeals) strong")
                    }
                }
            }
        }

        if !data.marketplaceComparison.isEmpty {
            Section("Marketplaces") {
                ForEach(data.marketplaceComparison, id: \.marketplace) { row in
                    LabeledContent {
                        Text("median \(Format.percent(row.medianDiscountPercent))")
                            .monospacedDigit()
                    } label: {
                        MarketplaceTag(marketplace: row.marketplace)
                            .font(.body)
                            .foregroundStyle(.primary)
                        Text("\(row.listings) listings · \(row.strongDeals) strong")
                    }
                }
            }
        }

        Section {
            DisclosureGroup("Diagnostics") {
                LabeledContent("Scan runs", value: "\(data.overview.scanRuns) · \(Format.percent(data.overview.scanSuccessRate, digits: 0)) OK")
                LabeledContent("Triaged", value: "\(data.triage.buy) buy · \(data.triage.watch) maybe · \(data.triage.pass) pass")
                LabeledContent("AI relevance kept", value: "\(Format.percent(data.aiQuality.relevancePassRate, digits: 0)) of \(data.aiQuality.relevanceJudged)")
                LabeledContent("Jev shadow agreement", value: Format.percent(data.aiQuality.shadowAgreementRate, digits: 0))
            }
        }
    }

    private func medianMove(_ trend: [AnalyticsData.TrendPoint]) -> Double? {
        let medians = trend.compactMap(\.medianPrice)
        guard let first = medians.first, let last = medians.last, first > 0, medians.count > 1 else { return nil }
        return (last - first) / first * 100
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
        let (days, watchId, marketplace) = (store.days, store.watchId, store.marketplace)
        let watchesToken = model.watchesToken
        do {
            async let loaded = client.analytics(days: days, watchId: watchId, marketplace: marketplace)
            // Refetch the picker's watches after any watch change; on failure
            // keep the previous list and try again next load.
            if store.watchesLoadedFor != watchesToken, let watches = try? await client.watches() {
                store.watches = watches
                store.watchesLoadedFor = watchesToken
            }
            store.data = try await loaded
            store.error = nil
            return true
        } catch {
            if !error.isCancellation { store.error = error.localizedDescription }
            return false
        }
    }
}
