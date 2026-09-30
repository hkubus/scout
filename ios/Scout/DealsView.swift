import SwiftUI
import ScoutKit

/// The web overview: headline stats and the freshest scored listings.
struct DealsView: View {
    @Environment(AppModel.self) private var model
    @State private var dashboard: DashboardData?
    @State private var error: String?
    @State private var scanMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let dashboard {
                    Section {
                        HStack(spacing: 0) {
                            StatTile(value: dashboard.stats.watching, title: "Watching")
                            Divider()
                            StatTile(value: dashboard.stats.newToday, title: "New today")
                            Divider()
                            StatTile(value: dashboard.stats.strongDeals, title: "Strong deals")
                        }
                        .padding(.vertical, 4)
                    } footer: {
                        VStack(alignment: .leading, spacing: 4) {
                            ConnectionIndicator()
                            Text("Last scan \(dashboard.lastScan). Prices are asking prices, not completed sales.")
                        }
                    }

                    Section {
                        NavigationLink(value: AllListingsRoute()) {
                            Label("All listings", systemImage: "list.bullet.rectangle")
                        }
                    }

                    Section("Latest") {
                        if dashboard.listings.isEmpty {
                            ContentUnavailableView("No deals yet", systemImage: "tag", description: Text("Scored listings appear here as your watches learn typical prices."))
                        }
                        ForEach(dashboard.listings, id: \.rowID) { listing in
                            NavigationLink(value: ListingLink(listing)) {
                                ListingRow(listing: listing)
                            }
                            .triageSwipeActions(for: listing) { updated in
                                replace(updated)
                            }
                        }
                    }
                }
            }
            .overlay { LoadingOverlay(isLoaded: dashboard != nil, error: error, retry: load) }
            .navigationTitle("Deals")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: scanAll) {
                        Label("Scan all watches", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
            }
            .refreshable { await load() }
            .task(id: model.refreshToken) { await load() }
            .alert("Scan", isPresented: Binding(get: { scanMessage != nil }, set: { if !$0 { scanMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(scanMessage ?? "")
            }
            .scoutDestinations()
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            let dashboard = try await client.dashboard()
            self.dashboard = dashboard
            error = nil
            model.publishWidgets(from: dashboard)
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
        }
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

    private func scanAll() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                scanMessage = try await client.queueScan().message
            } catch {
                model.report(error)
            }
        }
    }
}

private struct StatTile: View {
    var value: Int
    var title: String

    var body: some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.title2.weight(.bold))
                .monospacedDigit()
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}
