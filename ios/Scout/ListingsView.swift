import SwiftUI
import ScoutKit

/// Paginated, filterable listing history, either global or for one watch.
struct ListingsView: View {
    @Environment(AppModel.self) private var model
    private let watch: WatchListingsRoute?

    @State private var filters = Filters()
    @State private var search = ""
    @State private var listings: [Listing] = []
    @State private var pagination: Pagination?
    @State private var loadingMore = false
    @State private var error: String?

    init(watch: WatchListingsRoute? = nil) {
        self.watch = watch
    }

    private struct Filters: Hashable {
        var sort: ListingSort = .newest
        var marketplace: Marketplace?
        var decision: ListingDecision?
        var visibility: ListingVisibility = .visible
    }

    private struct LoadKey: Hashable {
        var filters: Filters
        var search: String
        var refreshToken: Int
    }

    var body: some View {
        List {
            if pagination != nil && listings.isEmpty {
                ContentUnavailableView.search(text: search)
            }
            ForEach(listings, id: \.rowID) { listing in
                NavigationLink(value: ListingLink(listing)) {
                    ListingRow(listing: listing)
                }
                .triageSwipeActions(for: listing) { updated in
                    replace(updated)
                }
                .onAppear {
                    if listing.rowID == listings.last?.rowID { Task { @MainActor in await loadMore() } }
                }
            }
            if loadingMore {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .listStyle(.plain)
        .overlay { LoadingOverlay(isLoaded: pagination != nil, error: error, retry: reload) }
        .navigationTitle(watch?.name ?? "Listings")
        .searchable(text: $search, prompt: "Search titles")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { filterMenu }
        }
        .refreshable { await reload() }
        .task(id: LoadKey(filters: filters, search: search, refreshToken: model.refreshToken)) {
            if !search.isEmpty {
                try? await Task.sleep(nanoseconds: 350_000_000)
                if Task.isCancelled { return }
            }
            await reload()
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Sort", selection: $filters.sort) {
                Text("Newest").tag(ListingSort.newest)
                Text("Strongest deal").tag(ListingSort.strongest)
                Text("Lowest price").tag(ListingSort.price)
            }
            Picker("Marketplace", selection: $filters.marketplace) {
                Text("All marketplaces").tag(Marketplace?.none)
                ForEach(Marketplace.all, id: \.self) { marketplace in
                    Text(marketplace.rawValue).tag(Marketplace?.some(marketplace))
                }
            }
            Picker("Decision", selection: $filters.decision) {
                Text("Any decision").tag(ListingDecision?.none)
                ForEach(ListingDecision.allCases, id: \.self) { decision in
                    Label(decision.title, systemImage: decision.symbol).tag(ListingDecision?.some(decision))
                }
            }
            Picker("Show", selection: $filters.visibility) {
                Text("Visible").tag(ListingVisibility.visible)
                Text("Hidden").tag(ListingVisibility.hidden)
                Text("All").tag(ListingVisibility.all)
            }
        } label: {
            Label("Filter", systemImage: filters == Filters() ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
    }

    private func query(page: Int) -> ListingsQuery {
        ListingsQuery(
            page: page,
            marketplace: filters.marketplace,
            search: search,
            watchId: watch?.watchId,
            sort: filters.sort,
            decision: filters.decision,
            visibility: filters.visibility
        )
    }

    private func reload() async {
        guard let client = model.client else { return }
        do {
            let page = try await client.listings(query(page: 1))
            listings = page.listings
            pagination = page.pagination
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
        }
    }

    private func loadMore() async {
        guard let client = model.client, let pagination, pagination.hasNext, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await client.listings(query(page: pagination.page + 1))
            let known = Set(listings.map(\.rowID))
            listings += page.listings.filter { !known.contains($0.rowID) }
            self.pagination = page.pagination
        } catch {
            model.report(error)
        }
    }

    private func replace(_ listing: Listing) {
        guard let index = listings.firstIndex(where: { $0.rowID == listing.rowID }) else { return }
        let leavesFilter = (filters.visibility == .visible && listing.hidden == true)
            || (filters.visibility == .hidden && listing.hidden != true)
            || (filters.decision != nil && listing.decision != filters.decision)
        if leavesFilter {
            listings.remove(at: index)
        } else {
            listings[index] = listing
        }
    }
}
