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
