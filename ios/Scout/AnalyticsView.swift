import Charts
import SwiftUI
import ScoutKit

/// Deal analytics across watches, like the web Analytics page. Discounts
/// compare asking prices with each watch's learned typical asking price.
struct AnalyticsView: View {
    @Environment(AppModel.self) private var model
    @State private var days = 30
    @State private var watchId: String?
    @State private var marketplace: Marketplace?
    @State private var watches: [Watch] = []
    @State private var data: AnalyticsData?
    @State private var error: String?

    private struct LoadKey: Hashable {
        var days: Int
        var watchId: String?
        var marketplace: Marketplace?
        var refreshToken: Int
    }

    var body: some View {
        List {
            Section {
                Picker("Range", selection: $days) {
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
                            watchId = nil
                            marketplace = nil
                        }
                        .font(.footnote)
                    }
                }
            }

            if let data {
                content(data)
            }
        }
        .overlay { LoadingOverlay(isLoaded: data != nil, error: error, retry: load) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Watch", selection: $watchId) {
                        Text("All watches").tag(String?.none)
                        ForEach(watches) { watch in
                            Text(watch.name).tag(String?.some(watch.id))
                        }
                    }
                    Picker("Marketplace", selection: $marketplace) {
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
        .task(id: LoadKey(days: days, watchId: watchId, marketplace: marketplace, refreshToken: model.refreshToken)) { await load() }
    }

    private var filterSummary: String {
        let watchName = watches.first { $0.id == watchId }?.name
        return [watchName, marketplace?.rawValue].compactMap { $0 }.joined(separator: " · ")
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

    private func load() async {
        guard let client = model.client else { return }
        do {
            data = try await client.analytics(days: days, watchId: watchId, marketplace: marketplace)
            error = nil
            if watches.isEmpty {
                watches = (try? await client.watches()) ?? []
            }
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
        }
    }
}
