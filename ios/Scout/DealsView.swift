import SwiftUI
import ScoutKit

/// How many deals the tab shows; the rest are one tap away in All listings.
private let topDealCount = 25

/// The web's Top deals: Strong+ listings still worth a look, one status line.
struct DealsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("dealsSort") private var sort: ListingSort = .strongest
    /// The stats, the last scan and the widget's top deals only
    /// (`dashboard(top:)`); the deals themselves are `deals`.
    @State private var dashboard: DashboardData?
    /// Strong+ rows queried across the whole feed, not ranked within the
    /// dashboard's newest rows; `topDeals` picks what the tab shows.
    @State private var deals = DealRows()
    @State private var error: String?
    @State private var scanQueued = false
    /// Bumped when triage needs a reload rather than a row patch.
    @State private var triageReloads = 0

    /// The loaded rows and the sort they were loaded in, which lags the
    /// picker while the next sort loads.
    private struct DealRows {
        var listings: [Listing] = []
        var sort: ListingSort = .strongest
    }

    private struct LoadKey: Hashable {
        var sort: ListingSort
        var refreshToken: Int
        var triageReloads: Int
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.dealsPath) {
            List {
                if dashboard == nil && error == nil {
                    Section {
                        PlaceholderRows()
                    }
                }
                if let dashboard {
                    let shown = topDeals(deals)
                    Section {
                        if shown.isEmpty {
                            ContentUnavailableView("No strong deals right now", systemImage: "tag", description: Text("Strong-or-better listings, weighing both % and zł below typical, show up here."))
                        }
                        ForEach(shown, id: \.rowID) { listing in
                            NavigationLink(value: ListingLink(listing)) {
                                ListingRow(listing: listing)
                            }
                            .triageActions(for: listing) { updated in
                                replace(updated)
                            }
                        }
                        NavigationLink(value: AllListingsRoute()) {
                            Text("All listings")
                        }
                    } header: {
                        Text(status(dashboard))
                            .textCase(nil)
                    }
                }
            }
            .overlay { LoadingOverlay(isLoaded: dashboard != nil, error: error, spinner: false, retry: { await load() }) }
            .navigationTitle("Deals")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: scanAll) {
                        Label(scanQueued ? "Scan queued" : "Scan now", systemImage: scanQueued ? "checkmark.circle" : "arrow.triangle.2.circlepath")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .disabled(scanQueued)
                }
                ToolbarItem(placement: .topBarTrailing) { sortMenu }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        model.dealsPath.append(SettingsRoute())
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                }
            }
            .refreshable { await load() }
            .reloadOnChange(of: LoadKey(sort: sort, refreshToken: model.refreshToken, triageReloads: triageReloads)) { await load() }
            .onChange(of: model.listingAction) { _, action in
                if let action { apply(action) }
            }
            .scoutDestinations()
            .navigationDestination(for: SettingsRoute.self) { _ in SettingsView() }
            .navigationDestination(for: WatchesRoute.self) { _ in WatchesView() }
        }
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort", selection: $sort) {
                Text("Strongest deal").tag(ListingSort.strongest)
                Text("Newest").tag(ListingSort.newest)
                Text("Lowest price").tag(ListingSort.price)
            }
        } label: {
            Label("Sort", systemImage: "arrow.up.arrow.down")
        }
    }

    /// Strong or better, visible and not filtered by AI (the server's
    /// default). Passed rows come back too, so the query asks for spares.
    private var dealsQuery: ListingsQuery {
        ListingsQuery(pageSize: topDealCount * 2, sort: sort, visibility: .visible, minStrength: 3)
    }

    /// Not hidden, not filtered by AI, not passed (the widget's rule) and
    /// Strong or better, in the server's order for the sort. For Strongest
    /// (tier, then the deepest discount), untriaged rows lead within a tier.
    private func topDeals(_ rows: DealRows) -> [Listing] {
        let candidates = rows.listings.filter {
            $0.hidden != true && $0.aiFiltered != true && $0.decision != .pass && $0.dealStrength >= 3
        }
        guard rows.sort == .strongest else { return Array(candidates.prefix(topDealCount)) }
        let sorted = candidates.enumerated().sorted { left, right in
            if left.element.dealStrength != right.element.dealStrength { return left.element.dealStrength > right.element.dealStrength }
            if (left.element.decision == nil) != (right.element.decision == nil) { return left.element.decision == nil }
            return left.offset < right.offset
        }
        return sorted.prefix(topDealCount).map(\.element)
    }

    /// "12 strong · 3 new today · scanned 5 min ago", plus the connection when it is not live.
    private func status(_ dashboard: DashboardData) -> String {
        var parts = ["\(dashboard.stats.strongDeals) strong", "\(dashboard.stats.newToday) new today"]
        parts.append(scanQueued ? "scan queued" : "scanned \(dashboard.lastScan)")
        switch model.connection {
        case .offline: parts.append("offline")
        case .demo: parts.append("demo data")
        case .live, .connecting: break
        }
        return parts.joined(separator: " · ")
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
        let query = dealsQuery
        do {
            let action = model.listingAction
            var (dashboard, page) = try await fetch(query, from: client)
            // Triage patches rows in place, so a response the server may have
            // built before a triage event arrived would undo it.
            if model.listingAction != action {
                (dashboard, page) = try await fetch(query, from: client)
            }
            show(dashboard, DealRows(listings: page.listings, sort: query.sort))
            error = nil
            model.publishWidgets(from: dashboard)
            return true
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
            return false
        }
    }

    /// The deals, plus the dashboard's stats and the widget's top deals:
    /// `top` leaves out the 500-row feed, the watches and the connectors.
    private func fetch(_ query: ListingsQuery, from client: ScoutClient) async throws -> (DashboardData, ListingsPage) {
        async let dashboard = client.dashboard(top: WidgetSnapshot.dashboardTop)
        async let page = client.listings(query)
        return try await (dashboard, page)
    }

    /// Triage from any client: a decision on a loaded deal is patched into
    /// the rows. Anything else reloads: hiding changes the stats, and a
    /// listing that isn't loaded, or is no longer passed, may now belong
    /// among the deals or the widget's top deals.
    private func apply(_ action: ListingActionEvent) {
        guard var dashboard else { return }
        guard let listings = action.patched(deals.listings) else {
            triageReloads += 1
            return
        }
        if let widgetRows = action.patched(dashboard.listings) {
            dashboard.listings = widgetRows
        } else if action.decision != .pass, deals.listings.contains(where: { $0.key == action.key && $0.decision == .pass }) {
            triageReloads += 1
            return
        }
        withAnimation { show(dashboard, DealRows(listings: listings, sort: deals.sort)) }
        model.publishWidgets(from: dashboard)
    }

    /// Patched in place even when hidden: `topDeals` leaves hidden rows out,
    /// and Undo can bring the row back where it was.
    private func replace(_ listing: Listing) {
        guard var dashboard, let index = deals.listings.firstIndex(where: { $0.rowID == listing.rowID }) else { return }
        var rows = deals
        rows.listings[index] = listing
        if let widgetIndex = dashboard.listings.firstIndex(where: { $0.rowID == listing.rowID }) {
            dashboard.listings[widgetIndex] = listing
        }
        show(dashboard, rows)
    }

    /// Also the tab badge: strong deals on the tab nobody has triaged yet.
    private func show(_ dashboard: DashboardData, _ deals: DealRows) {
        self.dashboard = dashboard
        self.deals = deals
        model.untriagedDeals = topDeals(deals).filter { $0.decision == nil }.count
    }

    /// Confirms in the status line instead of a blocking alert.
    private func scanAll() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                _ = try await client.queueScan()
                model.play(.success)
                withAnimation { scanQueued = true }
                try? await Task.sleep(for: .seconds(6))
                withAnimation { scanQueued = false }
            } catch {
                model.report(error)
            }
        }
    }
}
