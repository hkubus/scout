import Charts
import SwiftUI
import ScoutKit

struct WatchDetailView: View {
    @Environment(AppModel.self) private var model
    @State private var watch: Watch
    @State private var analytics: WatchAnalytics?
    @State private var days = 30
    @State private var error: String?
    @State private var scanQueued = false
    @State private var editor: WatchEditorRequest?
    /// The watch changes the shown watch was fetched for; a range change
    /// alone only needs new analytics.
    @State private var loadedVersion: WatchVersion?

    init(watch: Watch) {
        _watch = State(initialValue: watch)
    }

    /// Changes to this watch: its scans and edits, edits that name no watch
    /// (deletes), and triage, which changes its deal counts.
    private struct WatchVersion: Hashable {
        var changes: Int
        var allWatches: Int
        var triage: Int
    }

    private struct LoadKey: Hashable {
        var days: Int
        var version: WatchVersion
    }

    private var version: WatchVersion {
        WatchVersion(changes: model.watchChanges[watch.id, default: 0], allWatches: model.allWatchesToken, triage: model.triageToken)
    }

    var body: some View {
        List {
            Section {
                HStack {
                    WatchStatusBadge(status: scanQueued ? "Scan queued" : watch.status)
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
                if let analytics {
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
                        LabeledContent("Middle half", value: "\(Format.pln(low)) – \(Format.pln(high))")
                    }
                }
                NavigationLink(value: WatchListingsRoute(watchId: watch.id, name: watch.name)) {
                    Label("Listings", systemImage: "list.bullet.rectangle")
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

            Section("Asking prices") {
                Picker("Range", selection: $days) {
                    Text("7d").tag(7)
                    Text("30d").tag(30)
                    Text("90d").tag(90)
                    Text("180d").tag(180)
                }
                .pickerStyle(.segmented)
                if let analytics {
                    PriceBandChart(points: analytics.points.compactMap { PriceBandPoint($0) })
                        .frame(height: 170)
                        .padding(.vertical, 6)
                    LabeledContent("Listings seen", value: "\(analytics.current.listingCount)")
                    if let rate = analytics.current.strongDealRate {
                        LabeledContent("Strong (≥12%) share", value: Format.percent(rate))
                    }
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
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

            Section {
                DisclosureGroup("Search settings") {
                    LabeledContent("Query", value: watch.query)
                    if !watch.terms.isEmpty { LabeledContent("Must include", value: watch.terms) }
                    if !watch.excluded.isEmpty { LabeledContent("Excludes", value: watch.excluded) }
                    LabeledContent("Marketplaces", value: watch.sources.map(\.rawValue).joined(separator: ", "))
                    if watch.condition != "Any" { LabeledContent("Condition", value: watch.condition) }
                    if let category = watch.olxCategory, watch.sources.contains(.olx) {
                        LabeledContent("OLX category", value: category.label)
                    }
                    if let seller = watch.sellerType {
                        LabeledContent("Sellers", value: seller == SellerType.business.rawValue ? "Business only" : "Private only")
                    }
                    if watch.ignorePromoted == true {
                        LabeledContent("Promoted listings", value: "Skipped")
                    }
                    if watch.minPrice != nil || watch.maxPrice != nil {
                        LabeledContent("Price", value: "\(watch.minPrice.map(Format.pln) ?? "any") – \(watch.maxPrice.map(Format.pln) ?? "any")")
                    }
                    if let target = watch.targetPrice {
                        LabeledContent("Alert at or below", value: Format.pln(target))
                    }
                    if let saving = watch.minSaving {
                        LabeledContent("Minimum saving", value: Format.pln(saving))
                    }
                    LabeledContent("Scan interval", value: Format.minutes(watch.interval))
                    LabeledContent("Next scan", value: watch.nextScan)
                }
            }
        }
        .navigationTitle(watch.name)
        .navigationBarTitleDisplayMode(.inline)
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
        .sheet(item: $editor) { request in
            WatchEditorView(request: request) { _ in }
        }
        .refreshable {
            loadedVersion = nil
            await load()
        }
        .reloadOnChange(of: LoadKey(days: days, version: version)) { await load() }
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
        let id = watch.id
        let days = days
        let version = version
        do {
            async let loadedAnalytics = client.watchAnalytics(id: id, days: days)
            if loadedVersion != version {
                if let fresh = try await client.watches(includeArchived: true).first(where: { $0.id == id }) {
                    watch = fresh
                }
                loadedVersion = version
            }
            analytics = try await loadedAnalytics
            error = nil
            return true
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
            return false
        }
    }

    private func scan() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                // Confirmed in the status badge, like a swipe in the list, not a blocking alert.
                _ = try await client.queueScan(watchId: watch.id)
                model.play(.success)
                scanQueued = true
                try? await Task.sleep(for: .seconds(6))
                scanQueued = false
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
                model.play(.success)
                loadedVersion = nil
                await load()
                model.refreshUnlessLive()
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
                model.play(.selection)
                loadedVersion = nil
                await load()
            } catch {
                model.report(error)
            }
        }
    }
}
