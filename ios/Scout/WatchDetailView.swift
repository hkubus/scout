import Charts
import SwiftUI
import ScoutKit

struct WatchDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var watch: Watch
    @State private var analytics: WatchAnalytics?
    @State private var days = 30
    @State private var error: String?
    @State private var scanMessage: String?
    @State private var editor: WatchEditorRequest?

    init(watch: Watch) {
        _watch = State(initialValue: watch)
    }

    var body: some View {
        List {
            Section {
                HStack {
                    WatchStatusBadge(status: watch.status)
                    Spacer()
                    DealCountChips(counts: watch.dealCounts)
                }
                if watch.status == "Learning" {
                    ProgressView(value: min(watch.readiness, 100), total: 100) {
                        Text("Learning typical prices")
                    } currentValueLabel: {
                        Text("\(watch.samples) of \(watch.targetSamples) samples over \(Int(watch.observationHours)) h")
                    }
                }
                NavigationLink(value: WatchListingsRoute(watchId: watch.id, name: watch.name)) {
                    Label("Listings", systemImage: "list.bullet.rectangle")
                }
            }

            Section {
                Picker("Range", selection: $days) {
                    Text("7d").tag(7)
                    Text("30d").tag(30)
                    Text("90d").tag(90)
                    Text("180d").tag(180)
                }
                .pickerStyle(.segmented)
                if let analytics {
                    PriceBandChart(points: analytics.points.compactMap { PriceBandPoint($0) })
                        .frame(height: 190)
                        .padding(.vertical, 6)
                    if let median = analytics.current.medianPrice {
                        LabeledContent("Median asking price") {
                            HStack(spacing: 6) {
                                Text(Format.pln(median)).monospacedDigit()
                                if let change = analytics.medianChangePercent {
                                    Text(String(format: "%+.1f%%", change))
                                        .foregroundStyle(change < 0 ? Color.scoutGreen : Color.secondary)
                                }
                            }
                        }
                    }
                    if let low = analytics.current.lowerPrice, let high = analytics.current.upperPrice {
                        LabeledContent("Typical range", value: "\(Format.pln(low)) – \(Format.pln(high))")
                    }
                    LabeledContent("Listings seen", value: "\(analytics.current.listingCount)")
                    if let rate = analytics.current.strongDealRate {
                        LabeledContent("Strong deal rate", value: Format.percent(rate))
                    }
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: {
                Text("Asking prices")
            } footer: {
                Text("Public asking prices, not completed sales.")
            }

            if let sources = analytics?.sources, !sources.isEmpty {
                Section("By marketplace") {
                    ForEach(sources, id: \.source) { source in
                        LabeledContent {
                            Text(source.medianPrice.map(Format.pln) ?? "—").monospacedDigit()
                        } label: {
                            MarketplaceTag(marketplace: source.source)
                            Text("\(source.listingCount) listings · \(source.strongDealCount) strong")
                        }
                    }
                }
            }

            if !watch.variants.isEmpty {
                Section("Models") {
                    ForEach(watch.variants, id: \.key) { variant in
                        LabeledContent {
                            Text(variant.typical.map(Format.pln) ?? "Learning").monospacedDigit()
                        } label: {
                            Text(variant.label)
                            Text("\(variant.samples)/\(variant.targetSamples) samples")
                        }
                    }
                }
            }

            Section("Search") {
                LabeledContent("Query", value: watch.query)
                if !watch.terms.isEmpty { LabeledContent("Must include", value: watch.terms) }
                if !watch.excluded.isEmpty { LabeledContent("Excludes", value: watch.excluded) }
                LabeledContent("Marketplaces", value: watch.sources.map(\.rawValue).joined(separator: ", "))
                LabeledContent("Condition", value: watch.condition)
                if watch.minPrice != nil || watch.maxPrice != nil {
                    LabeledContent("Price", value: "\(watch.minPrice.map(Format.pln) ?? "any") – \(watch.maxPrice.map(Format.pln) ?? "any")")
                }
                LabeledContent("Scan interval", value: Format.minutes(watch.interval))
                LabeledContent("Next scan", value: watch.nextScan)
            }
        }
        .navigationTitle(watch.name)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        editor = .edit(watch)
                    } label: {
                        Label("Edit watch", systemImage: "pencil")
                    }
                    Button(action: scan) {
                        Label("Scan now", systemImage: "arrow.triangle.2.circlepath")
                    }
                    if !watch.isArchived {
                        Button(action: toggleEnabled) {
                            Label(watch.enabled ? "Pause watch" : "Resume watch", systemImage: watch.enabled ? "pause" : "play")
                        }
                    }
                    Button(role: watch.isArchived ? nil : .destructive, action: toggleArchived) {
                        Label(watch.isArchived ? "Restore watch" : "Archive watch", systemImage: watch.isArchived ? "tray.and.arrow.up" : "archivebox")
                    }
                } label: {
                    Label("Actions", systemImage: "ellipsis.circle")
                }
            }
        }
        .alert("Scan", isPresented: Binding(get: { scanMessage != nil }, set: { if !$0 { scanMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(scanMessage ?? "")
        }
        .sheet(item: $editor) { request in
            WatchEditorView(request: request) { _ in }
        }
        .refreshable { await load() }
        .task(id: "\(days)-\(model.refreshToken)") { await load() }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            analytics = try await client.watchAnalytics(id: watch.id, days: days)
            if let fresh = try await client.watches(includeArchived: true).first(where: { $0.id == watch.id }) {
                watch = fresh
            }
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
        }
    }

    private func scan() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                scanMessage = try await client.queueScan(watchId: watch.id).message
            } catch {
                model.report(error)
            }
        }
    }

    private func toggleArchived() {
        guard let client = model.client else { return }
        let archived = !watch.isArchived
        Task { @MainActor in
            do {
                try await client.updateWatch(id: watch.id, patch: WatchPatch(archived: archived))
                await load()
                model.refresh()
            } catch {
                model.report(error)
            }
        }
    }

    private func toggleEnabled() {
        guard let client = model.client else { return }
        let enabled = !watch.enabled
        Task { @MainActor in
            do {
                try await client.updateWatch(id: watch.id, patch: WatchPatch(enabled: enabled))
                await load()
            } catch {
                model.report(error)
            }
        }
    }
}
