import SwiftUI
import ScoutKit

// Market research: recurring snapshots that track asking-price movement and
// estimate where listings leave the market. A listing's last asking price
// before it disappears is a probable-sale estimate, never a confirmed sale.

struct ResearchListingsRoute: Hashable {
    var watchId: String?
    var name: String?
}

/// The Research screen's data. MarketView owns it, so switching to Analytics
/// and back shows it again without a reload.
@MainActor
@Observable
final class ResearchStore {
    var data: MarketResearchData?
    var error: String?
    let memory = LoadMemory()
}

struct ResearchView: View {
    @Environment(AppModel.self) private var model
    var store: ResearchStore
    @State private var editor: MarketWatchEditorRequest?

    var body: some View {
        List {
            if let data = store.data {
                Section {
                    StatGrid(items: stats(data))
                } footer: {
                    Text("A listing counts as no longer available only after three verified checks. A missing or blocked search result alone is never treated as a sale.")
                }

                Section("Research watches") {
                    if data.watches.isEmpty {
                        ContentUnavailableView {
                            Label("No research watches yet", systemImage: "chart.bar.doc.horizontal")
                        } description: {
                            Text("Create one to collect daily asking-price snapshots.")
                        } actions: {
                            Button("New research watch") { editor = .create() }
                        }
                    }
                    ForEach(data.watches) { watch in
                        NavigationLink(value: watch) {
                            ResearchWatchRow(watch: watch)
                        }
                        .swipeActions(edge: .leading) {
                            Button {
                                scan(watch)
                            } label: {
                                Label("Scan now", systemImage: "arrow.triangle.2.circlepath")
                            }
                            .tint(.scoutBlue)
                        }
                        .swipeActions(edge: .trailing) {
                            Button {
                                setEnabled(!watch.enabled, for: watch)
                            } label: {
                                Label(watch.enabled ? "Pause" : "Resume", systemImage: watch.enabled ? "pause.fill" : "play.fill")
                            }
                            .tint(watch.enabled ? Color.orange : Color.scoutGreen)
                        }
                    }
                }

                if !data.watches.isEmpty {
                    Section {
                        NavigationLink(value: ResearchListingsRoute(watchId: nil, name: nil)) {
                            Label("Saved listings", systemImage: "tray.full")
                        }
                    }
                }
            }
        }
        .overlay { LoadingOverlay(isLoaded: store.data != nil, error: store.error, retry: { await load() }) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editor = .create()
                } label: {
                    Label("New research watch", systemImage: "plus")
                }
            }
        }
        .sheet(item: $editor) { request in
            MarketWatchEditorView(request: request)
        }
        .refreshable { await load() }
        .reloadOnChange(of: model.researchToken, memory: store.memory) { await load() }
    }

    private func stats(_ data: MarketResearchData) -> [StatGrid.Item] {
        let band = data.aggregates?.saleBand
        return [
            StatGrid.Item(title: "Research watches", value: "\(data.watches.count)", detail: "\(data.watches.filter(\.enabled).count) active"),
            StatGrid.Item(title: "Live listings", value: "\(data.aggregates?.activeCount ?? 0)", detail: "currently observed"),
            StatGrid.Item(title: "Ended listings", value: "\(data.aggregates?.endedCount ?? 0)", detail: "verified unavailable"),
            StatGrid.Item(
                title: "Probable-sale median",
                value: band?.median.map(Format.pln) ?? "Learning",
                detail: band?.median != nil ? "estimate · \(band?.eligibleCount ?? 0) probable sales" : "\(band?.eligibleCount ?? 0) eligible so far"
            ),
        ]
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
        do {
            store.data = try await client.marketResearch(page: 1, pageSize: 1)
            store.error = nil
            return true
        } catch {
            if !error.isCancellation { store.error = error.localizedDescription }
            return false
        }
    }

    private func scan(_ watch: MarketWatch) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                _ = try await client.scanMarketWatch(id: watch.id)
            } catch {
                model.report(error)
            }
        }
    }

    private func setEnabled(_ enabled: Bool, for watch: MarketWatch) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                try await client.setMarketWatchEnabled(id: watch.id, enabled: enabled)
                await load()
            } catch {
                model.report(error)
            }
        }
    }
}

private struct ResearchWatchRow: View {
    var watch: MarketWatch

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(watch.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                WatchStatusBadge(status: watch.enabled ? "Active" : "Paused")
            }
            HStack(spacing: 10) {
                ForEach(watch.sources, id: \.self) { MarketplaceTag(marketplace: $0) }
            }
            HStack(spacing: 12) {
                Text("\(watch.totalListings) tracked · \(watch.endedListings) ended")
                Spacer(minLength: 0)
                SaleBandLabel(band: watch.saleBand)
            }
            .font(.caption)
            Text(verbatim: "Every \(watch.intervalHours) h · last \(watch.lastScan) · next \(watch.nextScan)")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .opacity(watch.enabled ? 1 : 0.6)
    }
}

private struct SaleBandLabel: View {
    var band: SaleBand?

    var body: some View {
        if let median = band?.median {
            Text("sale ≈ \(Format.pln(median))")
                .fontWeight(.semibold)
                .foregroundStyle(Color.dealOrange)
        } else {
            Text("sale estimate learning")
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Research watch detail

struct ResearchWatchDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var watch: MarketWatch
    @State private var trend: MarketWatchTrend?
    @State private var days = 90
    @State private var error: String?
    @State private var scanMessage: String?
    @State private var editor: MarketWatchEditorRequest?
    @State private var confirmingDelete = false
    /// The changes the shown summary was fetched for; a range change alone
    /// only needs a new trend.
    @State private var loadedVersion: WatchVersion?

    init(watch: MarketWatch) {
        _watch = State(initialValue: watch)
    }

    /// Changes to this research watch, including ones that name no watch.
    private struct WatchVersion: Hashable {
        var changes: Int
        var allMarketWatches: Int
    }

    private struct LoadKey: Hashable {
        var days: Int
        var version: WatchVersion
    }

    private var version: WatchVersion {
        WatchVersion(changes: model.marketWatchChanges[watch.id, default: 0], allMarketWatches: model.allMarketWatchesToken)
    }

    var body: some View {
        List {
            Section {
                HStack {
                    WatchStatusBadge(status: watch.enabled ? "Active" : "Paused")
                    Spacer()
                    Text("\(watch.totalListings) tracked · \(watch.activeListings) live · \(watch.endedListings) ended")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                NavigationLink(value: ResearchListingsRoute(watchId: watch.id, name: watch.name)) {
                    Label("Saved listings", systemImage: "tray.full")
                }
            }

            Section {
                Picker("Range", selection: $days) {
                    Text("30d").tag(30)
                    Text("90d").tag(90)
                    Text("180d").tag(180)
                }
                .pickerStyle(.segmented)
                if let trend {
                    PriceBandChart(points: trend.points.compactMap { PriceBandPoint($0) }, reference: trend.probableSaleMedian)
                        .frame(height: 200)
                        .padding(.vertical, 6)
                    StatGrid(items: trendStats(trend))
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } header: {
                Text("Asking prices vs probable sales")
            } footer: {
                Text("The solid line is the median asking price of live listings, with the middle 50% shaded. The dashed line is the probable-sale median, estimated from listings verified as no longer available. It's an estimate, not a confirmed sale price.")
            }

            if let band = watch.saleBand {
                Section("Probable-sale band") {
                    LabeledContent("Median", value: band.median.map(Format.pln) ?? "Learning")
                    if let low = band.p25, let high = band.p75 {
                        LabeledContent("Middle 50%", value: "\(Format.pln(low)) – \(Format.pln(high))")
                    }
                    LabeledContent("Probable sales", value: "\(band.eligibleCount) of \(band.sampleCount) ended")
                    if band.excludedStale > 0 {
                        LabeledContent("Excluded as stale", value: "\(band.excludedStale)")
                    }
                    LabeledContent("Window", value: "\(band.windowDays) days")
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
                if watch.shippingOnly { LabeledContent("Shipping", value: "Required") }
                LabeledContent("Snapshot every", value: "\(watch.intervalHours) h")
                LabeledContent("Last snapshot", value: watch.lastScan)
                LabeledContent("Next snapshot", value: watch.nextScan)
            }
        }
        .navigationTitle(watch.name)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        editor = .edit(watch)
                    } label: {
                        Label("Edit research watch", systemImage: "pencil")
                    }
                    Button(action: scan) {
                        Label("Scan now", systemImage: "arrow.triangle.2.circlepath")
                    }
                    Button(action: toggleEnabled) {
                        Label(watch.enabled ? "Pause" : "Resume", systemImage: watch.enabled ? "pause" : "play")
                    }
                    Button(role: .destructive) {
                        confirmingDelete = true
                    } label: {
                        Label("Delete research watch", systemImage: "trash")
                    }
                } label: {
                    Label("Actions", systemImage: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("Delete \(watch.name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete research watch", role: .destructive, action: delete)
        } message: {
            Text("Its snapshots and saved listings are deleted too.")
        }
        .alert("Scan", isPresented: Binding(get: { scanMessage != nil }, set: { if !$0 { scanMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(scanMessage ?? "")
        }
        .sheet(item: $editor) { request in
            MarketWatchEditorView(request: request)
        }
        .refreshable {
            loadedVersion = nil
            await load()
        }
        .reloadOnChange(of: LoadKey(days: days, version: version)) { await load() }
    }

    private func trendStats(_ trend: MarketWatchTrend) -> [StatGrid.Item] {
        let last = trend.points.last { $0.medianPrice != nil }
        let band: String
        if let low = last?.lowerPrice, let high = last?.upperPrice {
            band = "\(Format.pln(low)) – \(Format.pln(high))"
        } else {
            band = "—"
        }
        return [
            StatGrid.Item(title: "Live median", value: last?.medianPrice.map(Format.pln) ?? "—", detail: "latest observed day"),
            StatGrid.Item(title: "Live band", value: band, detail: "middle 50% of asking prices"),
            StatGrid.Item(title: "Probable-sale median", value: trend.probableSaleMedian.map(Format.pln) ?? "Learning", detail: "estimate"),
            StatGrid.Item(title: "Observations", value: "\(trend.totalObservations)", detail: "in the last \(trend.rangeDays) days"),
        ]
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
        let id = watch.id
        let days = days
        let version = version
        do {
            async let loadedTrend = client.marketWatchTrend(id: id, days: days)
            if loadedVersion != version {
                if let fresh = try await client.marketResearch(page: 1, pageSize: 1).watches.first(where: { $0.id == id }) {
                    watch = fresh
                }
                loadedVersion = version
            }
            trend = try await loadedTrend
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
                scanMessage = try await client.scanMarketWatch(id: watch.id).message
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
                try await client.setMarketWatchEnabled(id: watch.id, enabled: enabled)
                loadedVersion = nil
                await load()
            } catch {
                model.report(error)
            }
        }
    }

    private func delete() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                try await client.deleteMarketWatch(id: watch.id)
                model.refreshUnlessLive()
                dismiss()
            } catch {
                model.report(error)
            }
        }
    }
}

// MARK: - Saved listings

struct ResearchListingsView: View {
    @Environment(AppModel.self) private var model
    var route: ResearchListingsRoute

    @State private var status: MarketListingStatus?
    @State private var listings: [MarketTrackedListing] = []
    @State private var pagination: Pagination?
    @State private var loadingMore = false
    @State private var error: String?
    /// The status filter the rows were loaded for.
    @State private var loadedStatus: MarketListingStatus??

    private struct LoadKey: Hashable {
        var status: MarketListingStatus?
        var researchToken: Int
    }

    var body: some View {
        List {
            if pagination != nil && listings.isEmpty {
                ContentUnavailableView("No saved listings here", systemImage: "tray", description: Text("The first successful snapshot fills this history."))
            }
            ForEach(listings) { listing in
                NavigationLink(value: listing) {
                    ResearchListingRow(listing: listing)
                }
                .onAppear {
                    if listing.id == listings.last?.id { Task { @MainActor in await loadMore() } }
                }
            }
            if loadingMore {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .listStyle(.plain)
        .overlay { LoadingOverlay(isLoaded: pagination != nil, error: error, retry: { await reload() }) }
        .navigationTitle(route.name ?? "Saved listings")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Status", selection: $status) {
                        Text("All statuses").tag(MarketListingStatus?.none)
                        Text("Active").tag(MarketListingStatus?.some(.active))
                        Text("No longer available").tag(MarketListingStatus?.some(.ended))
                        Text("Previous series").tag(MarketListingStatus?.some(.superseded))
                    }
                } label: {
                    Label("Filter", systemImage: status == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .refreshable { await reload() }
        .reloadOnChange(of: LoadKey(status: status, researchToken: model.researchToken)) { await reload() }
    }

    /// Loads page 1 for a new status filter. For the same one it refetches
    /// every page already loaded in one request, so a refresh keeps the rows
    /// and scroll position.
    @discardableResult
    private func reload() async -> Bool {
        guard let client = model.client else { return false }
        let status = status
        let pages = loadedStatus == .some(status) ? ReloadPolicy.pagesToKeep(loadedRows: listings.count, maxRows: 400) : 1
        do {
            let page = try await client.marketResearch(page: 1, pageSize: pages * 50, watchId: route.watchId, status: status)
            listings = page.listings
            if let loaded = page.pagination {
                pagination = Pagination(page: pages, pageSize: 50, total: loaded.total, hasNext: loaded.total > pages * 50)
            } else {
                pagination = Pagination(page: 1, pageSize: 50, total: page.listings.count, hasNext: false)
            }
            loadedStatus = .some(status)
            error = nil
            return true
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
            return false
        }
    }

    private func loadMore() async {
        guard let client = model.client, let pagination, pagination.hasNext, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.marketResearch(page: pagination.page + 1, pageSize: 50, watchId: route.watchId, status: status)
            let known = Set(listings.map(\.id))
            listings += page.listings.filter { !known.contains($0.id) }
            self.pagination = page.pagination
        } catch {
            model.report(error)
        }
    }
}

struct ResearchStatusBadge: View {
    var listing: MarketTrackedListing

    private var color: Color {
        switch listing.status {
        case "ended": .dealOrange
        case "superseded": .secondary
        default: listing.missingScans > 0 ? Color.orange : Color.scoutGreen
        }
    }

    var body: some View {
        Text(listing.statusTitle)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }
}

private struct ResearchListingRow: View {
    var listing: MarketTrackedListing

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ListingThumbnail(url: listing.imageURL, size: 60)
            VStack(alignment: .leading, spacing: 4) {
                Text(listing.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Format.pln(listing.lastPrice))
                        .font(.headline)
                        .monospacedDigit()
                    if listing.priceChangePercent != 0 {
                        Text(String(format: "%+.1f%%", listing.priceChangePercent))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(listing.priceChangePercent < 0 ? Color.scoutGreen : Color.red)
                    }
                    Text("from \(Format.pln(listing.firstPrice))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    ResearchStatusBadge(listing: listing)
                    MarketplaceTag(marketplace: listing.marketplace)
                    Spacer(minLength: 0)
                    Text(Format.day(listing.endedAt ?? listing.lastSeenAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Saved listing detail

struct ResearchListingDetailView: View {
    @Environment(AppModel.self) private var model
    var listing: MarketTrackedListing

    @State private var history: [PriceHistoryPoint] = []
    @State private var snapshot: MarketListingSnapshot?
    @State private var snapshotLoaded = false
    @State private var capturing = false
    @State private var enlargedImage: EnlargedImage?

    var body: some View {
        List {
            Section {
                if let url = listing.imageURL {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFit()
                        } else {
                            Color.secondary.opacity(0.1)
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 180, maxHeight: 300)
                    .listRowInsets(EdgeInsets())
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text(listing.title)
                        .font(.title3.weight(.semibold))
                    HStack(spacing: 8) {
                        ResearchStatusBadge(listing: listing)
                        MarketplaceTag(marketplace: listing.marketplace)
                    }
                    Text(Format.pln(listing.lastPrice))
                        .font(.largeTitle.weight(.bold))
                        .monospacedDigit()
                    Text(listing.status == "ended" ? "Last asking price. Not a confirmed sale." : "Current asking price")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            if history.count > 1 {
                Section("Price history") {
                    PriceHistoryChart(points: history, typical: nil)
                        .frame(height: 170)
                        .padding(.vertical, 6)
                }
            }

            Section("Details") {
                LabeledContent("Research watch", value: listing.watchName)
                LabeledContent("First price", value: Format.pln(listing.firstPrice))
                LabeledContent("Lowest price", value: Format.pln(listing.lowestPrice))
                LabeledContent("Change", value: listing.priceChangePercent == 0 ? "—" : String(format: "%+.1f%%", listing.priceChangePercent))
                LabeledContent("Observations", value: "\(listing.observations)")
                LabeledContent("First seen", value: Format.day(listing.firstSeenAt))
                LabeledContent("Last seen", value: Format.day(listing.lastSeenAt))
                if let endedAt = listing.endedAt {
                    LabeledContent("Ended", value: Format.day(endedAt))
                }
                if let reason = listing.endedReason {
                    LabeledContent("Reason", value: reason)
                }
            }

            savedCopy
        }
        .navigationTitle(listing.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let url = listing.webURL {
                    ShareLink(item: url)
                    Link(destination: url) {
                        Label("Open listing", systemImage: "safari")
                    }
                }
            }
        }
        .sheet(item: $enlargedImage) { enlarged in
            NavigationStack {
                Group {
                    if let client = model.client {
                        ServerImage(client: client, url: enlarged.url, contentMode: .fit) { ProgressView() }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { enlargedImage = nil }
                    }
                }
            }
        }
        .task(id: listing.id) { await load() }
    }

    @ViewBuilder
    private var savedCopy: some View {
        Section {
            if let snapshot {
                LabeledContent("Captured", value: Format.day(snapshot.capturedAt))
                LabeledContent("Price then", value: Format.pln(snapshot.price))
                if let condition = snapshot.condition { LabeledContent("Condition", value: condition) }
                if let location = snapshot.location { LabeledContent("Location", value: location) }
                if !snapshot.images.isEmpty, let client = model.client {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(snapshot.images.sorted { $0.position < $1.position }) { image in
                                let url = client.marketSnapshotImageURL(imageId: image.id)
                                Button {
                                    enlargedImage = EnlargedImage(url: url)
                                } label: {
                                    ServerImage(client: client, url: url) {
                                        ZStack {
                                            Color.secondary.opacity(0.12)
                                            Image(systemName: "photo").foregroundStyle(.tertiary)
                                        }
                                    }
                                    .frame(width: 96, height: 96)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                if let description = snapshot.description, !description.isEmpty {
                    Text(description)
                        .font(.callout)
                        .textSelection(.enabled)
                }
            } else if snapshotLoaded {
                Text(listing.snapshotStatus == "failed" ? "Saving a copy failed last time." : "No copy of this listing has been saved yet.")
                    .foregroundStyle(.secondary)
                if listing.status != "ended" {
                    Button(action: capture) {
                        HStack {
                            Label("Save a copy now", systemImage: "square.and.arrow.down")
                            Spacer()
                            if capturing { ProgressView() }
                        }
                    }
                    .disabled(capturing)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } header: {
            Text("Saved copy")
        } footer: {
            Text("A saved copy keeps the description and photos after the listing disappears.")
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        async let loadedHistory = client.marketListingHistory(id: listing.id)
        async let loadedSnapshot = client.marketListingSnapshot(id: listing.id)
        history = (try? await loadedHistory) ?? []
        snapshot = try? await loadedSnapshot
        snapshotLoaded = true
    }

    private func capture() {
        guard let client = model.client else { return }
        capturing = true
        Task { @MainActor in
            defer { capturing = false }
            do {
                snapshot = try await client.captureMarketListingSnapshot(id: listing.id)
            } catch {
                model.report(error)
            }
        }
    }
}

private struct EnlargedImage: Identifiable {
    var url: URL
    var id: String { url.absoluteString }
}
