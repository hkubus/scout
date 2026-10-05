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
    /// The filters and search the rows were loaded for.
    @State private var loadedQuery: LoadedQuery?
    /// Bumped when triage needs a reload rather than a row patch.
    @State private var triageReloads = 0

    init(watch: WatchListingsRoute? = nil) {
        self.watch = watch
    }

    private struct Filters: Hashable {
        var sort: ListingSort = .newest
        var marketplace: Marketplace?
        var decision: ListingDecision?
        var visibility: ListingVisibility = .visible
    }

    private struct LoadedQuery: Hashable {
        var filters: Filters
        var search: String
    }

    private struct LoadKey: Hashable {
        var query: LoadedQuery
        var refreshToken: Int
        var triageReloads: Int
    }

    var body: some View {
        List {
            if pagination == nil && error == nil {
                PlaceholderRows()
            }
            if pagination != nil && listings.isEmpty {
                ContentUnavailableView.search(text: search)
            }
            ForEach(listings, id: \.rowID) { listing in
                NavigationLink(value: ListingLink(listing)) {
                    ListingRow(listing: listing)
                }
                .triageActions(for: listing) { updated in
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
        .overlay { LoadingOverlay(isLoaded: pagination != nil, error: error, spinner: false, retry: { await reload() }) }
        .navigationTitle(watch?.name ?? "Listings")
        .searchable(text: $search, prompt: "Search titles")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { filterMenu }
        }
        .refreshable { await reload() }
        .reloadOnChange(of: LoadKey(query: LoadedQuery(filters: filters, search: search), refreshToken: model.refreshToken, triageReloads: triageReloads)) {
            if !search.isEmpty, LoadedQuery(filters: filters, search: search) != loadedQuery {
                try? await Task.sleep(nanoseconds: 350_000_000)
                if Task.isCancelled { return false }
            }
            return await reload()
        }
        .onChange(of: model.listingAction) { _, action in
            if let action { apply(action) }
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

    /// Loads page 1 for new filters or search. For the same ones it refetches
    /// every page already loaded in one request, so a refresh keeps the rows
    /// and scroll position instead of dropping back to the first page.
    @discardableResult
    private func reload() async -> Bool {
        guard let client = model.client else { return false }
        let current = LoadedQuery(filters: filters, search: search)
        let pages = current == loadedQuery ? ReloadPolicy.pagesToKeep(loadedRows: listings.count, maxRows: 500) : 1
        var request = query(page: 1)
        request.pageSize = pages * 50
        do {
            let action = model.listingAction
            var page = try await client.listings(request)
            // Triage patches rows in place, so a response the server may have
            // built before a triage event arrived would undo it.
            if model.listingAction != action {
                page = try await client.listings(request)
            }
            listings = page.listings
            pagination = Pagination(page: pages, pageSize: 50, total: page.pagination.total, hasNext: page.pagination.total > pages * 50)
            loadedQuery = current
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
            let page = try await client.listings(query(page: pagination.page + 1))
            let known = Set(listings.map(\.rowID))
            listings += page.listings.filter { !known.contains($0.rowID) }
            self.pagination = page.pagination
        } catch {
            model.report(error)
        }
    }

    /// A row that isn't loaded but now belongs (Undo, or a refused change
    /// put back) comes back with a reload, which keeps the scroll position.
    private func replace(_ listing: Listing) {
        guard let index = listings.firstIndex(where: { $0.rowID == listing.rowID }) else {
            if triageFilter.admits(listing) { triageReloads += 1 }
            return
        }
        if triageFilter.admits(listing) {
            listings[index] = listing
        } else {
            listings.remove(at: index)
            dropFromTotal(1)
        }
    }

    private var triageFilter: ListingFilter {
        ListingFilter(decision: filters.decision, visibility: filters.visibility)
    }

    /// Rows that left the filters are no longer counted by the server either.
    private func dropFromTotal(_ removed: Int) {
        guard removed > 0, var pagination else { return }
        pagination.total = max(0, pagination.total - removed)
        self.pagination = pagination
    }

    /// Triage from any client. This list shows no stats, so decision and
    /// hidden are patched into loaded rows (dropping those that leave the
    /// filters); it reloads only when a listing that isn't loaded may now
    /// belong in it.
    private func apply(_ action: ListingActionEvent) {
        guard pagination != nil else { return }
        switch action.triage(listings, filter: triageFilter) {
        case let .patched(rows, removed):
            withAnimation { listings = rows }
            dropFromTotal(removed)
        case .reload:
            triageReloads += 1
        case .unchanged:
            break
        }
    }
}
