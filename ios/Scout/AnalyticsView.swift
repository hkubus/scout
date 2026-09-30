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
                StatGrid.Item(title: "Tracked listings", value: "\(data.overview.trackedListings)", detail: "observed in range"),
                StatGrid.Item(title: "New listings", value: "\(data.overview.newListings)", detail: "first seen in range"),
                StatGrid.Item(title: "Strong deals", value: "\(data.overview.strongDeals)", detail: "≥18% below typical"),
                StatGrid.Item(title: "Median discount", value: Format.percent(data.overview.medianDiscountPercent), detail: "vs typical asking price"),
                StatGrid.Item(title: "Scan runs", value: "\(data.overview.scanRuns)", detail: "\(Format.percent(data.overview.scanSuccessRate, digits: 0)) completed"),
                StatGrid.Item(title: "Median move", value: Format.percent(medianMove(data.trend)), detail: "first to last day"),
            ])
        }

        Section {
            PriceBandChart(points: data.trend.compactMap { PriceBandPoint($0) })
                .frame(height: 190)
                .padding(.vertical, 6)
        } header: {
            Text("Median asking price")
        } footer: {
            Text("Middle 50% of asking prices shaded.")
        }

        if data.trend.contains(where: { $0.strongDealCount > 0 }) {
            Section("Strong deals per day") {
                Chart {
                    ForEach(data.trend, id: \.date) { point in
                        if let day = point.day {
                            BarMark(x: .value("Day", day, unit: .day), y: .value("Strong deals", point.strongDealCount))
                                .foregroundStyle(Color.dealOrange)
                        }
                    }
                }
                .frame(height: 120)
                .padding(.vertical, 6)
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
            .frame(height: 150)
            .padding(.vertical, 6)
        }

        Section("Triage") {
            LabeledContent("Buy", value: "\(data.triage.buy)")
            LabeledContent("Watch", value: "\(data.triage.watch)")
            LabeledContent("Pass", value: "\(data.triage.pass)")
            LabeledContent("Undecided", value: "\(data.triage.none)")
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
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            MarketplaceTag(marketplace: row.marketplace)
                                .font(.body)
                                .foregroundStyle(.primary)
                            Spacer()
                            Text("median \(Format.percent(row.medianDiscountPercent))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Text(verbatim: "\(row.listings) listings · \(row.strongDeals) strong · \(Format.percent(row.scanSuccessRate, digits: 0)) scans OK" + (row.averageLatencyMs.map { " · \(Int($0)) ms" } ?? ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }

        Section {
            LabeledContent("Relevance judged", value: "\(data.aiQuality.relevanceJudged)")
            LabeledContent("Pass rate", value: Format.percent(data.aiQuality.relevancePassRate, digits: 0))
            LabeledContent("Shadow judged", value: "\(data.aiQuality.shadowJudged)")
            LabeledContent("Shadow agreement", value: Format.percent(data.aiQuality.shadowAgreementRate, digits: 0))
        } header: {
            Text("AI quality")
        } footer: {
            Text("Discounts compare public asking prices with each watch's learned typical asking price. They are not completed sales.")
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
        do {
            async let loaded = client.analytics(days: days, watchId: watchId, marketplace: marketplace)
            if store.watches.isEmpty {
                store.watches = (try? await client.watches()) ?? []
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
