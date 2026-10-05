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

    // One palette for the app and its widgets (WidgetPalette, in Shared).
    static let scoutBlue = WidgetPalette.blue
    static let dealOrange = WidgetPalette.orange
    static let dealAmber = WidgetPalette.amber
    static let dealBlue = WidgetPalette.lightBlue
    static let scoutGreen = Color(hex: "#3aab61")
}

extension Marketplace {
    var color: Color { WidgetPalette.color(for: self) }
}

extension DealLabel {
    var color: Color { WidgetPalette.color(for: self) }
}

extension ListingDecision {
    var title: String {
        switch self {
        case .buy: "Buy"
        case .watch: "Maybe"
        case .pass: "Pass"
        }
    }

    var symbol: String {
        switch self {
        case .buy: "cart.fill"
        case .watch: "bookmark.fill"
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

/// Three lines like the web table's stacked row: title, the price against
/// typical, then where and when.
struct ListingRow: View {
    var listing: Listing

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ListingThumbnail(url: listing.imageURL, size: 64)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(listing.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                        .strikethrough(listing.hidden == true)
                    Spacer(minLength: 4)
                    if let verdict = VerificationVerdict(listing: listing) {
                        Image(systemName: verdict.symbol)
                            .font(.footnote)
                            .foregroundStyle(verdict.color)
                            .accessibilityLabel(verdict.title)
                    }
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
                    // Only a real discount is coloured; at or above typical stays quiet.
                    if let below = listing.belowTypical, below < 0 {
                        Text("−\(Int(abs(below).rounded()))%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(listing.dealStrength >= 3 ? listing.dealLabel.color : .primary)
                    }
                    if let typical = listing.typical {
                        Text("typ. \(Format.pln(typical))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                ListingSignals(listing: listing)
            }
        }
        .padding(.vertical, 2)
        .opacity(listing.aiFiltered == true ? 0.55 : 1)
    }

    private var meta: String {
        var parts = [listing.marketplace.rawValue]
        if listing.shippingAvailable == false { parts.append("pickup only") }
        if listing.aiFiltered == true { parts.append("filtered by AI") }
        parts.append(listing.observedDate.map(Format.relative) ?? listing.observed)
        return parts.joined(separator: " · ")
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

/// Swipe right to triage, swipe left to hide, or long-press for both plus
/// "I bought this" and the listing's link; the server keeps the listing's note.
struct TriageActions: ViewModifier {
    @Environment(AppModel.self) private var model
    var listing: Listing
    var onChange: (Listing) -> Void

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                ForEach(ListingDecision.allCases, id: \.self) { decision in
                    Button {
                        toggle(decision)
                    } label: {
                        Label(decision.title, systemImage: decision.symbol)
                    }
                    .tint(decision == .pass ? .gray : decision.color)
                }
            }
            .swipeActions(edge: .trailing) {
                Button(action: toggleHidden) {
                    Label(listing.hidden == true ? "Unhide" : "Hide", systemImage: listing.hidden == true ? "eye" : "eye.slash")
                }
                .tint(.indigo)
            }
            .contextMenu {
                ControlGroup {
                    ForEach(ListingDecision.allCases, id: \.self) { decision in
                        Toggle(isOn: Binding(get: { listing.decision == decision }, set: { _ in toggle(decision) })) {
                            Label(decision.title, systemImage: decision.symbol)
                        }
                    }
                }
                Button(action: toggleHidden) {
                    Label(listing.hidden == true ? "Unhide" : "Hide", systemImage: listing.hidden == true ? "eye" : "eye.slash")
                }
                Button(action: addFlip) {
                    Label("I bought this", systemImage: "shippingbox")
                }
                Divider()
                ListingLinkActions(url: listing.webURL, marketplace: listing.marketplace)
            } preview: {
                ListingPreview(listing: listing)
            }
    }

    private func toggle(_ decision: ListingDecision) {
        let next: ListingDecision? = listing.decision == decision ? nil : decision
        apply(decision: .some(next))
    }

    private func toggleHidden() {
        let hiding = listing.hidden != true
        apply(hidden: hiding)
        if hiding {
            model.showUndo("Listing hidden") { [self] in apply(hidden: false) }
        }
    }

    /// Shows the change at once and puts the row back if the server refuses
    /// it. Sends only the changed field, so a stale copy of the note is never
    /// written back.
    private func apply(decision: ListingDecision?? = .none, hidden: Bool? = nil) {
        guard let client = model.client else { return }
        let original = listing
        var optimistic = listing
        if let decision { optimistic.decision = decision }
        if let hidden { optimistic.hidden = hidden }
        model.play(.selection)
        withAnimation { onChange(optimistic) }
        Task { @MainActor in
            do {
                let action = try await client.patchListingAction(key: original.key, decision: decision, hidden: hidden)
                var updated = original
                updated.decision = action.decision
                updated.note = action.note
                updated.hidden = action.hidden
                onChange(updated)
            } catch {
                withAnimation { onChange(original) }
                model.report(error)
            }
        }
    }

    /// The same as "I bought this" in the listing's details.
    private func addFlip() {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                _ = try await client.createFlip(FlipDraft(listing: listing))
                model.play(.success)
            } catch {
                model.report(error)
            }
        }
    }
}

/// Open, share, and copy a marketplace listing's address, for context menus.
struct ListingLinkActions: View {
    var url: URL?
    var marketplace: Marketplace

    var body: some View {
        if let url {
            Link(destination: url) {
                Label("Open on \(marketplace.rawValue)", systemImage: "safari")
            }
            ShareLink(item: url) {
                Label("Share link", systemImage: "square.and.arrow.up")
            }
            Button {
                UIPasteboard.general.url = url
            } label: {
                Label("Copy link", systemImage: "doc.on.doc")
            }
        }
    }
}

/// A long-press preview: the photo at the size the details header loads it
/// (so opening the listing next draws it from cache), the title, and the price.
struct ListingPreview: View {
    var listing: Listing

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let url = listing.imageURL {
                PipelineImage(url: url, contentMode: .fit, pointSize: ImagePipeline.headerPoints) {
                    ProgressView()
                }
                .frame(width: 320, height: 240)
                .background(Color.secondary.opacity(0.08))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(listing.title)
                    .font(.headline)
                    .lineLimit(3)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Format.pln(listing.price))
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                    if let below = listing.belowTypical, below < 0 {
                        Text(Format.versusTypical(below))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(listing.dealStrength >= 3 ? listing.dealLabel.color : .primary)
                    }
                }
                Text(verbatim: ([listing.marketplace.rawValue, listing.condition, listing.location] as [String?]).compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let verdict = VerificationVerdict(listing: listing) {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(verdict.title, systemImage: verdict.symbol)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(verdict.color)
                        if let summary = listing.aiDescriptionVerification?.summary, !summary.isEmpty {
                            Text(summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                    .padding(.top, 4)
                }
            }
            .padding(12)
        }
        .frame(width: 320, alignment: .leading)
    }
}

extension View {
    func undoToastHost() -> some View {
        modifier(UndoToastHost())
    }

    func triageActions(for listing: Listing, onChange: @escaping (Listing) -> Void) -> some View {
        modifier(TriageActions(listing: listing, onChange: onChange))
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
    /// Off where the list shows `PlaceholderRows` while it loads.
    var spinner = true
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
            } else if spinner {
                ProgressView()
            }
        }
    }
}

/// Grey rows shaped like the content, pulsing while a list loads for the
/// first time, so the screen doesn't jump from a spinner to rows.
struct PlaceholderRows: View {
    var count = 6
    /// The thumbnail's side, or nil for text-only rows.
    var thumbnail: CGFloat? = 64

    var body: some View {
        ForEach(0..<count, id: \.self) { _ in
            HStack(alignment: .top, spacing: 12) {
                if let thumbnail {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.secondary.opacity(0.2))
                        .frame(width: thumbnail, height: thumbnail)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(verbatim: "A listing title that runs fairly long")
                        .font(.subheadline.weight(.semibold))
                    Text(verbatim: "1 234 zł")
                        .font(.headline)
                    Text(verbatim: "Marketplace · 5 min ago")
                        .font(.caption)
                }
            }
            .padding(.vertical, 2)
            .redacted(reason: .placeholder)
            .phaseAnimator([1.0, 0.45]) { content, opacity in
                content.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.9)
            }
            .accessibilityHidden(true)
        }
    }
}

/// What the AI description check concluded, for rows, previews and details.
struct VerificationVerdict {
    var title: String
    var symbol: String
    var color: Color

    init(decision: String) {
        switch decision {
        case "pass":
            title = "Description checks out"
            symbol = "checkmark.seal.fill"
            color = .scoutGreen
        case "reject":
            title = "Description raises concerns"
            symbol = "exclamationmark.octagon.fill"
            color = .red
        default:
            title = "Inconclusive"
            symbol = "questionmark.circle"
            color = .secondary
        }
    }

    /// Nil until a check has finished; a pending or unconfigured check says nothing yet.
    init?(listing: Listing) {
        if let decision = listing.aiDescriptionVerification?.decision {
            self.init(decision: decision)
        } else if let status = listing.aiDescriptionVerificationStatus, ["pass", "reject", "unknown"].contains(status) {
            self.init(decision: status)
        } else {
            return nil
        }
    }
}

/// The Undo toast, above the tab bar of the tab it is applied to.
struct UndoToastHost: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let toast = model.toast {
                    HStack(spacing: 16) {
                        Text(verbatim: toast.message)
                            .font(.subheadline)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Button("Undo") { model.undoToast() }
                            .font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(.regularMaterial, in: Capsule())
                    .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .id(toast.id)
                }
            }
            .animation(.spring(duration: 0.35), value: model.toast?.id)
    }
}
