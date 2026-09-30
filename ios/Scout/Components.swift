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
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                ZStack {
                    Color.secondary.opacity(0.12)
                    Image(systemName: "photo").foregroundStyle(.tertiary)
                }
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
    var placeholder: () -> Placeholder
    @State private var image: UIImage?

    init(client: ScoutClient, url: URL, contentMode: ContentMode = .fill, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.client = client
        self.url = url
        self.contentMode = contentMode
        self.placeholder = placeholder
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            image = (try? await client.serverData(url)).flatMap(UIImage.init(data:))
        }
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

/// Swipe right to triage, swipe left to hide; keeps the listing's note.
struct TriageSwipeActions: ViewModifier {
    @Environment(AppModel.self) private var model
    var listing: Listing
    var onChange: (Listing) -> Void

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                ForEach(ListingDecision.allCases, id: \.self) { decision in
                    Button {
                        apply(decision: listing.decision == decision ? nil : decision, hidden: listing.hidden ?? false)
                    } label: {
                        Label(decision.title, systemImage: decision.symbol)
                    }
                    .tint(decision == .pass ? .gray : decision.color)
                }
            }
            .swipeActions(edge: .trailing) {
                Button {
                    apply(decision: listing.decision, hidden: !(listing.hidden ?? false))
                } label: {
                    Label(listing.hidden == true ? "Unhide" : "Hide", systemImage: listing.hidden == true ? "eye" : "eye.slash")
                }
                .tint(.indigo)
            }
    }

    private func apply(decision: ListingDecision?, hidden: Bool) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                let action = try await client.updateListingAction(key: listing.key, action: ListingAction(decision: decision, note: listing.note ?? "", hidden: hidden))
                var updated = listing
                updated.decision = action.decision
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
