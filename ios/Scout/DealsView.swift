import SwiftUI
import ScoutKit

/// How many deals the tab shows; the rest are one tap away in All listings.
private let topDealCount = 25

/// The web's Top deals: Strong+ listings still worth a look, one status line.
struct DealsView: View {
    @Environment(AppModel.self) private var model
    @State private var dashboard: DashboardData?
    @State private var error: String?
    @State private var scanQueued = false
    /// Bumped when triage needs a reload rather than a row patch.
    @State private var triageReloads = 0

    var body: some View {
        NavigationStack {
            List {
                if let dashboard {
                    let deals = topDeals(dashboard.listings)
                    Section {
                        if deals.isEmpty {
                            ContentUnavailableView("No strong deals right now", systemImage: "tag", description: Text("Listings at least 12% below their typical price show up here."))
                        }
                        ForEach(deals, id: \.rowID) { listing in
                            NavigationLink(value: ListingLink(listing)) {
                                ListingRow(listing: listing)
                            }
                            .triageSwipeActions(for: listing) { updated in
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
            .overlay { LoadingOverlay(isLoaded: dashboard != nil, error: error, retry: { await load() }) }
            .navigationTitle("Deals")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Scan now", action: scanAll)
                        .disabled(scanQueued)
                }
            }
            .refreshable { await load() }
            .reloadOnChange(of: [model.refreshToken, triageReloads]) { await load() }
            .onChange(of: model.listingAction) { _, action in
                if let action { apply(action) }
            }
            .scoutDestinations()
        }
    }

    /// Not hidden, not filtered by AI, not passed (the widget's rule) and
    /// Strong or better; untriaged rows lead within a tier.
    private func topDeals(_ listings: [Listing]) -> [Listing] {
        let candidates = listings.filter {
            $0.hidden != true && $0.aiFiltered != true && $0.decision != .pass && $0.dealStrength >= 3
        }
        let sorted = candidates.sorted { left, right in
            if left.dealStrength != right.dealStrength { return left.dealStrength > right.dealStrength }
            if (left.decision == nil) != (right.decision == nil) { return left.decision == nil }
            return left.observedAt > right.observedAt
        }
        return Array(sorted.prefix(topDealCount))
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
        do {
            let action = model.listingAction
            var dashboard = try await client.dashboard()
            // Triage patches rows in place, so a response the server may have
            // built before a triage event arrived would undo it.
            if model.listingAction != action {
                dashboard = try await client.dashboard()
            }
            self.dashboard = dashboard
            error = nil
            model.publishWidgets(from: dashboard)
            return true
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
            return false
        }
    }

    /// Triage from any client: a decision is patched into the rows, which
    /// is all it changes here; hiding changes the stats, so it reloads.
    private func apply(_ action: ListingActionEvent) {
        guard var dashboard else { return }
        guard let listings = action.patched(dashboard.listings) else {
            triageReloads += 1
            return
        }
        dashboard.listings = listings
        self.dashboard = dashboard
        model.publishWidgets(from: dashboard)
    }

    private func replace(_ listing: Listing) {
        guard var dashboard else { return }
        if listing.hidden == true {
            dashboard.listings.removeAll { $0.rowID == listing.rowID }
        } else if let index = dashboard.listings.firstIndex(where: { $0.rowID == listing.rowID }) {
            dashboard.listings[index] = listing
        }
        self.dashboard = dashboard
    }

    /// Confirms in the status line instead of a blocking alert.
    private func scanAll() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                _ = try await client.queueScan()
                scanQueued = true
                try? await Task.sleep(for: .seconds(6))
                scanQueued = false
            } catch {
                model.report(error)
            }
        }
    }
}
