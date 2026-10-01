import SwiftUI
import ScoutKit

enum Format {
    static func pln(_ value: Double) -> String {
        value.formatted(.currency(code: "PLN").precision(.fractionLength(0)).locale(Locale(identifier: "pl_PL")))
    }

    /// `belowTypical` is signed: -36.7 means 37% under the typical asking price.
    static func versusTypical(_ percent: Double) -> String {
        let rounded = Int(abs(percent).rounded())
        return percent < 0 ? "\(rounded)% below typical" : "\(rounded)% above typical"
    }

    static func relative(_ date: Date) -> String {
        date.formatted(.relative(presentation: .named))
    }

    static func relative(iso: String?, fallback: String = "—") -> String {
        guard let date = ScoutDate.parse(iso) else { return fallback }
        return relative(date)
    }

    /// Values that are already percentages (0–100), as the server sends them.
    static func percent(_ value: Double?, digits: Int = 1) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.\(digits)f%%", value)
    }

    static func day(_ iso: String?) -> String {
        guard let date = ScoutDate.parse(iso) else { return "—" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    static func minutes(_ value: Double) -> String {
        value >= 60 && value.truncatingRemainder(dividingBy: 60) == 0 ? "\(Int(value / 60)) h" : "\(Int(value)) min"
    }

    /// Compact age like the web chips: "3 min", "5 h", "2 d", "4 mo", "1 y".
    static func age(since date: Date, now: Date = Date()) -> String {
        let elapsed = max(0, now.timeIntervalSince(date))
        if elapsed < 3600 { return "\(max(1, Int(elapsed / 60))) min" }
        if elapsed < 86_400 { return "\(Int(elapsed / 3600)) h" }
        if elapsed < 30 * 86_400 { return "\(Int(elapsed / 86_400)) d" }
        if elapsed < 365 * 86_400 { return "\(Int(elapsed / (30 * 86_400))) mo" }
        return "\(Int(elapsed / (365 * 86_400))) y"
    }

    /// Money with up to two decimals, for ledger amounts.
    static func zl(_ value: Double) -> String {
        value.formatted(.currency(code: "PLN").precision(.fractionLength(0...2)).locale(Locale(identifier: "pl_PL")))
    }
}

extension Color {
    init(hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let value = UInt64(digits, radix: 16) ?? 0
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    static let scoutBlue = Color(hex: "#1d61e8")
    static let dealOrange = Color(hex: "#f15a35")
    static let dealAmber = Color(hex: "#f4b734")
    static let dealBlue = Color(hex: "#87a7e8")
    static let scoutGreen = Color(hex: "#3aab61")
}

extension Marketplace {
    var color: Color {
        switch self {
        case .olx: Color(hex: "#159b96")
        case .allegroLokalnie: Color(hex: "#f27526")
        case .vinted: Color(hex: "#55a9b0")
        default: .secondary
        }
    }
}

extension DealLabel {
    var color: Color {
        switch self {
        case .exceptional: .dealOrange
        case .veryStrong: .dealAmber
        case .strong: .dealBlue
        default: .secondary
        }
    }
}

extension ListingDecision {
    var title: String {
        switch self {
        case .buy: "Buy"
        case .watch: "Watch"
        case .pass: "Pass"
        }
    }

    var symbol: String {
        switch self {
        case .buy: "cart.fill"
        case .watch: "eye.fill"
        case .pass: "xmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .buy: .scoutGreen
        case .watch: .scoutBlue
        case .pass: .secondary
        }
    }
}

/// Five rising bars like the web UI's deal-strength meter.
struct DealBars: View {
    var strength: Double
    var label: DealLabel

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Double(index) < strength.rounded() ? label.color : Color.secondary.opacity(0.2))
                    .frame(width: 4, height: 7 + CGFloat(index) * 2)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Deal strength \(Int(strength)) of 5")
    }
}

struct DealBadge: View {
    var label: DealLabel

    var body: some View {
        Text(label.rawValue)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(label == .watch ? Color.secondary : label.color)
            .background(label.color.opacity(0.14), in: Capsule())
    }
}

struct MarketplaceTag: View {
    var marketplace: Marketplace

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(marketplace.color).frame(width: 7, height: 7)
            Text(marketplace.rawValue)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

struct ListingThumbnail: View {
    var url: URL?
    var size: CGFloat

    var body: some View {
        PipelineImage(url: url, contentMode: .fill, pointSize: size) {
            ZStack {
                Color.secondary.opacity(0.12)
                Image(systemName: "photo").foregroundStyle(.tertiary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// An image Scout serves itself (saved listing photos). Loaded through the
/// client so the API token is sent, which `AsyncImage` can't do.
struct ServerImage<Placeholder: View>: View {
    var client: ScoutClient
    var url: URL
    var contentMode: ContentMode
    /// The side of the square it fills, or the longest side it fits in.
    var pointSize: CGFloat
    var placeholder: () -> Placeholder

    init(client: ScoutClient, url: URL, contentMode: ContentMode = .fill, pointSize: CGFloat, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.client = client
        self.url = url
        self.contentMode = contentMode
        self.pointSize = pointSize
        self.placeholder = placeholder
    }

    var body: some View {
        let client = client
        PipelineImage(url: url, contentMode: contentMode, pointSize: pointSize, fetch: { try await client.serverData($0) }, placeholder: placeholder)
    }
}

struct ListingRow: View {
    var listing: Listing

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ListingThumbnail(url: listing.imageURL, size: 68)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(listing.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                        .strikethrough(listing.hidden == true)
                    Spacer(minLength: 4)
                    if let decision = listing.decision {
                        Image(systemName: decision.symbol)
                            .foregroundStyle(decision.color)
                            .accessibilityLabel(decision.title)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Format.pln(listing.price))
                        .font(.headline)
                        .monospacedDigit()
                    if let typical = listing.typical {
                        Text("typ. \(Format.pln(typical))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    DealBars(strength: listing.dealStrength, label: listing.dealLabel)
                    if let below = listing.belowTypical, below < 0 {
                        Text("−\(Int(abs(below).rounded()))%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(listing.dealLabel.color)
                    }
                    MarketplaceTag(marketplace: listing.marketplace)
                    Spacer(minLength: 0)
                    Text(listing.observedDate.map(Format.relative) ?? listing.observed)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ListingSignals(listing: listing)
                if listing.aiFiltered == true {
                    Label("AI marked as not relevant", systemImage: "sparkles")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .opacity(listing.aiFiltered == true ? 0.55 : 1)
    }
}

/// When a listing was really posted, and whether it's promoted or from a
/// business: OLX's "newest" order is really "most recently refreshed", so a
/// months-old listing can sit at the top of a scan.
struct ListingSignals: View {
    var listing: Listing

    var body: some View {
        if hasSignals {
            HStack(spacing: 6) {
                if let posted = listing.postedDate {
                    Text(verbatim: postedText(posted))
                        .foregroundStyle(ageColor(posted))
                }
                if listing.promoted == true {
                    Text("Promoted")
                        .padding(.horizontal, 5)
                        .overlay(Capsule().stroke(Color.secondary.opacity(0.4)))
                        .foregroundStyle(.secondary)
                }
                if listing.isBusinessSeller {
                    Text("Business")
                        .padding(.horizontal, 5)
                        .background(Color.scoutBlue.opacity(0.14), in: Capsule())
                        .foregroundStyle(Color.scoutBlue)
                }
            }
            .font(.caption2.weight(.medium))
            .lineLimit(1)
        }
    }

    private var hasSignals: Bool {
        listing.postedDate != nil || listing.promoted == true || listing.isBusinessSeller
    }

    private func postedText(_ posted: Date) -> String {
        if let bumped = listing.bumpedDate {
            return "Posted \(Format.age(since: posted)) ago · bumped \(Format.age(since: bumped)) ago"
        }
        return "Posted \(Format.age(since: posted)) ago"
    }

    private func ageColor(_ posted: Date) -> Color {
        let age = Date().timeIntervalSince(posted)
        if age < 86_400 { return .scoutGreen }
        if age > 30 * 86_400 { return .dealOrange }
        return .secondary
    }
}

/// A form row that opens the OLX category picker for `query`.
struct OlxCategoryField: View {
    var query: String
    @Binding var category: OlxCategory?

    var body: some View {
        NavigationLink {
            OlxCategoryPickerView(query: query, category: $category)
        } label: {
            LabeledContent("OLX category") {
                Text(verbatim: category?.label ?? "All categories")
            }
        }
    }
}

/// OLX's own per-category hit counts for the query, loaded on demand (one request).
struct OlxCategoryPickerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var query: String
    @Binding var category: OlxCategory?
    @State private var options: [OlxCategoryOption] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            Section {
                Button {
                    category = nil
                    dismiss()
                } label: {
                    row(title: "All categories", detail: "OLX searches every category", selected: category == nil)
                }
                if let category, !options.contains(where: { $0.id == category.id }) {
                    row(title: category.label, detail: category.readablePath, selected: true)
                }
            }
            if !options.isEmpty {
                Section {
                    ForEach(options) { option in
                        Button {
                            category = option.category
                            dismiss()
                        } label: {
                            row(title: option.label, detail: "\(option.count.formatted()) listings · \(option.category.readablePath)", selected: category?.id == option.id)
                                .padding(.leading, CGFloat(max(0, option.depth - minDepth)) * 14)
                        }
                    }
                } header: {
                    Text(verbatim: "Matches for “\(trimmedQuery)”")
                } footer: {
                    Text("Only OLX scans use this. Pick the category of the item itself, so whole PCs or cases don't skew the typical price.")
                }
            } else if loaded && error == nil {
                Section {
                    Text(verbatim: "OLX has no category counts for “\(trimmedQuery)”.")
                        .foregroundStyle(.secondary)
                }
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                }
            }
        }
        .overlay {
            if !loaded && error == nil && !trimmedQuery.isEmpty { ProgressView() }
        }
        .navigationTitle("OLX category")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var minDepth: Int { options.map(\.depth).min() ?? 1 }

    private func row(title: String, detail: String, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title)
                    .foregroundStyle(.primary)
                Text(verbatim: detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if selected {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.scoutBlue)
            }
        }
    }

    private func load() async {
        guard let client = model.client, !trimmedQuery.isEmpty else {
            loaded = true
            if trimmedQuery.isEmpty { error = "Enter the search query first." }
            return
        }
        do {
            // Path order reads as a tree: parents come before their children.
            options = try await client.olxCategories(query: trimmedQuery).sorted { $0.path < $1.path }
            error = nil
        } catch {
            if error.isCancellation { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

/// Swipe right to triage, swipe left to hide; the server keeps the listing's note.
struct TriageSwipeActions: ViewModifier {
    @Environment(AppModel.self) private var model
    var listing: Listing
    var onChange: (Listing) -> Void

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                ForEach(ListingDecision.allCases, id: \.self) { decision in
                    Button {
                        let next: ListingDecision? = listing.decision == decision ? nil : decision
                        apply(decision: .some(next))
                    } label: {
                        Label(decision.title, systemImage: decision.symbol)
                    }
                    .tint(decision == .pass ? .gray : decision.color)
                }
            }
            .swipeActions(edge: .trailing) {
                Button {
                    apply(hidden: !(listing.hidden ?? false))
                } label: {
                    Label(listing.hidden == true ? "Unhide" : "Hide", systemImage: listing.hidden == true ? "eye" : "eye.slash")
                }
                .tint(.indigo)
            }
    }

    /// Sends only the swiped field, so a stale copy of the note is never written back.
    private func apply(decision: ListingDecision?? = .none, hidden: Bool? = nil) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                let action = try await client.patchListingAction(key: listing.key, decision: decision, hidden: hidden)
                var updated = listing
                updated.decision = action.decision
                updated.note = action.note
                updated.hidden = action.hidden
                onChange(updated)
            } catch {
                model.report(error)
            }
        }
    }
}

extension View {
    func triageSwipeActions(for listing: Listing, onChange: @escaping (Listing) -> Void) -> some View {
        modifier(TriageSwipeActions(listing: listing, onChange: onChange))
    }

    /// Navigation targets shared by every tab's stack.
    func scoutDestinations() -> some View {
        navigationDestination(for: ListingLink.self) { ListingDetailView(link: $0) }
            .navigationDestination(for: Watch.self) { WatchDetailView(watch: $0) }
            .navigationDestination(for: WatchListingsRoute.self) { ListingsView(watch: $0) }
            .navigationDestination(for: AllListingsRoute.self) { _ in ListingsView() }
            .navigationDestination(for: MarketWatch.self) { ResearchWatchDetailView(watch: $0) }
            .navigationDestination(for: MarketTrackedListing.self) { ResearchListingDetailView(listing: $0) }
            .navigationDestination(for: ResearchListingsRoute.self) { ResearchListingsView(route: $0) }
    }
}

struct ConnectionIndicator: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(verbatim: title)
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        switch model.connection {
        case .demo: "Demo data"
        case .live: "Live"
        case .connecting: "Connecting…"
        case .offline: "Offline"
        }
    }

    private var color: Color {
        switch model.connection {
        case .demo: .orange
        case .live: .scoutGreen
        case .connecting: .secondary
        case .offline: .red
        }
    }
}

/// Spinner while loading, an error with retry, or the content once loaded.
struct LoadingOverlay: View {
    var isLoaded: Bool
    var error: String?
    var retry: () async -> Void

    var body: some View {
        if !isLoaded {
            if let error {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await retry() } }
                        .buttonStyle(.borderedProminent)
                }
            } else {
                ProgressView()
            }
        }
    }
}
