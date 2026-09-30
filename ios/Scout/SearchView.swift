import SwiftUI
import ScoutKit

/// Live search across the marketplaces without creating a watch, like the web
/// Search page. Each marketplace's results stream in over `/events` while the
/// request runs; the HTTP response is authoritative.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("searchAIRelevance") private var aiRelevance = true
    @State private var filters = SearchFilters()
    @State private var lastRequest: SearchFilters?
    @State private var results: [Listing] = []
    @State private var statuses: [SearchSourceStatus] = []
    @State private var searchID: String?
    @State private var searching = false
    @State private var loadingMore = false
    @State private var exhausted = false
    @State private var page = 1
    @State private var error: String?
    @State private var showingFilters = false
    @State private var editor: WatchEditorRequest?

    var body: some View {
        NavigationStack {
            List {
                if !statuses.isEmpty {
                    Section {
                        ForEach(statuses, id: \.source) { SourceStatusRow(status: $0) }
                    }
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
                if !results.isEmpty {
                    Section {
                        ForEach(results, id: \.id) { listing in
                            NavigationLink(value: ListingLink(listing)) {
                                SearchResultRow(listing: listing)
                            }
                        }
                        if canLoadMore {
                            Button(action: loadMore) {
                                HStack {
                                    Text("Load more")
                                    Spacer()
                                    if loadingMore { ProgressView() }
                                }
                            }
                            .disabled(loadingMore)
                        }
                    } header: {
                        Text(verbatim: "\(results.count) \(results.count == 1 ? "result" : "results")\(searching ? " so far…" : "") · lowest price first")
                    }
                }
            }
            .overlay { emptyState }
            .navigationTitle("Search")
            .searchable(text: $filters.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "What are you looking for?")
            .onSubmit(of: .search, startSearch)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let lastRequest {
                        Button {
                            editor = .create(WatchDraft(search: lastRequest))
                        } label: {
                            Label("Save as watch", systemImage: "bell.badge")
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingFilters = true
                    } label: {
                        Label("Filters", systemImage: hasCustomFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    }
                }
            }
            .sheet(isPresented: $showingFilters) {
                SearchFiltersSheet(filters: $filters, aiRelevance: $aiRelevance)
            }
            .sheet(item: $editor) { request in
                WatchEditorView(request: request) { created in
                    if let created { model.showWatch(created) }
                }
            }
            .onChange(of: model.searchProgress) { _, event in
                if let event { merge(event) }
            }
            .task {
                if let query = model.pendingSearchQuery {
                    model.pendingSearchQuery = nil
                    filters.query = query
                    startSearch()
                }
            }
            .scoutDestinations()
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if results.isEmpty && error == nil {
            if searching {
                ProgressView("Searching public marketplace pages…")
            } else if lastRequest != nil {
                ContentUnavailableView("No matching listings", systemImage: "magnifyingglass", description: Text("Try widening the price range or removing a filter."))
            } else {
                ContentUnavailableView("Search marketplaces", systemImage: "magnifyingglass", description: Text("Search OLX, Allegro Lokalnie, and Vinted right now without creating a watch or touching its price history."))
            }
        }
    }

    private var hasCustomFilters: Bool {
        var defaults = SearchFilters()
        defaults.query = filters.query
        return filters != defaults
    }

    private var canLoadMore: Bool {
        lastRequest != nil && !searching && !exhausted && page < 10 && !results.isEmpty
    }

    private func startSearch() {
        var request = filters
        request.aiRelevance = aiRelevance
        request.page = 1
        guard request.hasValidPriceRange else {
            error = "Enter a valid price range; the minimum cannot exceed the maximum."
            return
        }
        guard request.canSearch, let client = model.client else { return }
        let id = UUID().uuidString
        request.searchId = id
        searchID = id
        lastRequest = request
        searching = true
        error = nil
        results = []
        page = 1
        exhausted = false
        statuses = request.sources.map(SearchSourceStatus.searching)
        Task { @MainActor in
            do {
                let response = try await client.search(request)
                guard searchID == id else { return }
                results = [Listing]().mergingSearchResults(response.listings)
                statuses = response.sources
                exhausted = response.listings.isEmpty
            } catch {
                guard searchID == id, !error.isCancellation else { return }
                self.error = error.localizedDescription
                statuses = statuses.filter { $0.status != "searching" }
            }
            if searchID == id { searching = false }
        }
    }

    /// Pages past the server's per-request cap instead of dropping results.
    private func loadMore() {
        guard canLoadMore, !loadingMore, var request = lastRequest, let client = model.client else { return }
        request.page = page + 1
        request.searchId = nil
        let id = searchID
        loadingMore = true
        Task { @MainActor in
            defer { loadingMore = false }
            do {
                let response = try await client.search(request)
                guard searchID == id else { return }
                results = results.mergingSearchResults(response.listings)
                // Keep the first page's counts; only surface new failures.
                for status in response.sources where status.status == "error" {
                    replaceStatus(status)
                }
                page = request.page
                if response.listings.isEmpty { exhausted = true }
            } catch {
                model.report(error)
            }
        }
    }

    private func merge(_ event: SearchProgressEvent) {
        guard searching, event.searchId == searchID else { return }
        replaceStatus(event.status)
        if !event.listings.isEmpty { results = results.mergingSearchResults(event.listings) }
    }

    private func replaceStatus(_ status: SearchSourceStatus) {
        if let index = statuses.firstIndex(where: { $0.source == status.source }) {
            statuses[index] = status
        } else {
            statuses.append(status)
        }
    }
}

private struct SourceStatusRow: View {
    var status: SearchSourceStatus

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(status.source.color)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(status.source.rawValue)
                    .font(.subheadline.weight(.medium))
                Text(verbatim: status.message + (status.pendingShipping > 0 ? " · \(status.pendingShipping) delivery checks pending" : ""))
                    .font(.caption)
                    .foregroundStyle(status.status == "error" ? Color.red : Color.secondary)
            }
            Spacer()
            if status.status == "searching" {
                ProgressView()
            } else {
                Text(String(format: "%.1fs", status.durationMs / 1000))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SearchResultRow: View {
    var listing: Listing

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ListingThumbnail(url: listing.imageURL, size: 60)
            VStack(alignment: .leading, spacing: 4) {
                Text(listing.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Format.pln(listing.price))
                        .font(.headline)
                        .monospacedDigit()
                    if let negotiability {
                        Text(negotiability)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    MarketplaceTag(marketplace: listing.marketplace)
                    Label(shipping, systemImage: listing.shippingAvailable == true ? "shippingbox" : "figure.walk")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                }
                if !details.isEmpty {
                    Text(details)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Only OLX and Allegro Lokalnie say whether the price is negotiable.
    private var negotiability: String? {
        guard listing.marketplace == .olx || listing.marketplace == .allegroLokalnie else { return nil }
        switch listing.priceNegotiable {
        case true?: return "Negotiable"
        case false?: return "Fixed price"
        case nil: return nil
        }
    }

    private var shipping: String {
        switch listing.shippingAvailable {
        case true?: "Shipping"
        case false?: "Pickup only"
        case nil: "Delivery unknown"
        }
    }

    private var details: String {
        [listing.condition, listing.location].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

private struct SearchFiltersSheet: View {
    @Binding var filters: SearchFilters
    @Binding var aiRelevance: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var minPrice = ""
    @State private var maxPrice = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Marketplaces") {
                    ForEach(Marketplace.all, id: \.self) { marketplace in
                        Toggle(isOn: sourceBinding(marketplace)) {
                            MarketplaceTag(marketplace: marketplace)
                                .font(.body)
                                .foregroundStyle(.primary)
                        }
                    }
                }

                Section {
                    TextField("No minimum", text: $minPrice)
                        .keyboardType(.numberPad)
                    TextField("No maximum", text: $maxPrice)
                        .keyboardType(.numberPad)
                } header: {
                    Text("Price (zł)")
                } footer: {
                    if !filters.hasValidPriceRange {
                        Text("The minimum cannot exceed the maximum.").foregroundStyle(.red)
                    }
                }

                Section("Listing") {
                    Picker("Condition", selection: $filters.condition) {
                        ForEach(SearchCondition.allCases, id: \.self) { condition in
                            Text(condition.rawValue).tag(condition)
                        }
                    }
                    Picker("Seller (OLX only)", selection: $filters.ownerType) {
                        Text("Any").tag(SellerType?.none)
                        Text("Private").tag(SellerType?.some(SellerType.private))
                        Text("Business").tag(SellerType?.some(SellerType.business))
                    }
                    TextField("Location (anywhere)", text: $filters.location)
                    Toggle("Shipping only", isOn: $filters.shippingOnly)
                }

                Section("Terms") {
                    TextField("Must include, e.g. oled, 512gb", text: $filters.terms)
                        .textInputAutocapitalization(.never)
                    TextField("Exclude, e.g. broken, parts", text: $filters.excluded)
                        .textInputAutocapitalization(.never)
                }

                Section {
                    Toggle("AI relevance filtering", isOn: $aiRelevance)
                } footer: {
                    Text("Hides accessories, parts, and unrelated matches. Searching is faster with it off.")
                }

                Section {
                    Button("Reset filters", role: .destructive) {
                        let query = filters.query
                        filters = SearchFilters(query: query)
                        minPrice = ""
                        maxPrice = ""
                    }
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                minPrice = filters.minPrice.map { String(Int($0)) } ?? ""
                maxPrice = filters.maxPrice.map { String(Int($0)) } ?? ""
            }
            .onChange(of: minPrice) { _, text in filters.minPrice = Self.price(text) }
            .onChange(of: maxPrice) { _, text in filters.maxPrice = Self.price(text) }
        }
        .presentationDetents([.medium, .large])
    }

    private func sourceBinding(_ marketplace: Marketplace) -> Binding<Bool> {
        Binding(
            get: { filters.sources.contains(marketplace) },
            set: { enabled in
                if enabled {
                    if !filters.sources.contains(marketplace) { filters.sources.append(marketplace) }
                } else {
                    filters.sources.removeAll { $0 == marketplace }
                }
            }
        )
    }

    private static func price(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }
}
