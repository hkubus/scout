import SwiftUI
import UIKit
import WidgetKit
import ScoutKit

// Compiled into both the widget extension and the app; the app uses the same
// views for its widget preview screen. Keep this file free of app-only helpers.

enum WidgetState: Hashable {
    case ready
    case notConfigured
    /// Showing cached data (if any) because the server couldn't be reached.
    case offline(String)
}

struct ScoutWidgetEntry: TimelineEntry {
    var date: Date
    var snapshot: WidgetSnapshot?
    var state: WidgetState
}

extension WidgetSnapshot {
    static var demo: WidgetSnapshot {
        make(from: DemoTransport.dashboard(), isDemo: true)
    }
}

enum WidgetPalette {
    static let blue = Color(red: 0.114, green: 0.380, blue: 0.910)
    static let orange = Color(red: 0.945, green: 0.353, blue: 0.208)
    static let amber = Color(red: 0.957, green: 0.718, blue: 0.204)
    static let lightBlue = Color(red: 0.529, green: 0.655, blue: 0.910)

    static func color(for label: DealLabel) -> Color {
        switch label {
        case .exceptional: orange
        case .veryStrong: amber
        case .strong: lightBlue
        default: .secondary
        }
    }

    static func color(for marketplace: Marketplace) -> Color {
        switch marketplace {
        case .olx: Color(red: 0.082, green: 0.608, blue: 0.588)
        case .allegroLokalnie: Color(red: 0.949, green: 0.459, blue: 0.149)
        case .vinted: Color(red: 0.333, green: 0.663, blue: 0.690)
        default: .secondary
        }
    }
}

private let dealsURL = URL(string: "scout://deals")!

// MARK: - Top deals widget

struct DealsWidgetContent: View {
    var entry: ScoutWidgetEntry
    var family: WidgetFamily

    var body: some View {
        if let snapshot = entry.snapshot {
            switch family {
            case .systemSmall:
                SmallDealView(snapshot: snapshot, state: entry.state)
            case .systemLarge:
                DealListView(snapshot: snapshot, state: entry.state, rows: 6)
            default:
                DealListView(snapshot: snapshot, state: entry.state, rows: 3)
            }
        } else {
            WidgetMessageView(state: entry.state)
        }
    }
}

private struct SmallDealView: View {
    var snapshot: WidgetSnapshot
    var state: WidgetState

    var body: some View {
        if let deal = snapshot.deals.first {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .top) {
                    WidgetThumbnail(deal: deal, size: 42)
                    Spacer(minLength: 4)
                    DealChip(label: deal.dealLabel)
                }
                Spacer(minLength: 2)
                Text(deal.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(2)
                Text(WidgetFormat.pln(deal.price))
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                HStack(spacing: 4) {
                    if let discount = WidgetFormat.discount(deal.belowTypical) {
                        Text(discount)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(WidgetPalette.color(for: deal.dealLabel))
                    }
                    Text(deal.marketplace.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .widgetURL(deal.deepLink)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                WidgetHeader(title: "Top deals", trailing: nil)
                Spacer()
                Text("No deals yet")
                    .font(.subheadline.weight(.semibold))
                Text("Watching \(snapshot.stats.watching)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                WidgetFooter(snapshot: snapshot, state: state)
            }
            .widgetURL(dealsURL)
        }
    }
}

private struct DealListView: View {
    var snapshot: WidgetSnapshot
    var state: WidgetState
    var rows: Int

    /// The medium family has room for three one-line rows, not a footer as well.
    private var compact: Bool { rows <= 3 }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 9) {
            WidgetHeader(title: "Top deals", trailing: "\(snapshot.stats.strongDeals) strong · \(snapshot.stats.newToday) new today")
            if snapshot.deals.isEmpty {
                Spacer()
                Text("No deals yet — your watches are still learning typical prices.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(snapshot.deals.prefix(rows)) { deal in
                    Link(destination: deal.deepLink) {
                        DealRow(deal: deal, thumbnailSize: compact ? 26 : 38, showsMarketplace: !compact)
                    }
                }
            }
            Spacer(minLength: 0)
            // Compact widgets only mention their data when it is stale or demo.
            if !compact || state != .ready || snapshot.isDemo {
                WidgetFooter(snapshot: snapshot, state: state)
            }
        }
        .widgetURL(dealsURL)
    }
}

private struct DealRow: View {
    var deal: WidgetDeal
    var thumbnailSize: CGFloat
    var showsMarketplace: Bool

    var body: some View {
        HStack(spacing: 8) {
            WidgetThumbnail(deal: deal, size: thumbnailSize)
            VStack(alignment: .leading, spacing: 1) {
                Text(deal.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if showsMarketplace {
                    Text(deal.marketplace.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let discount = WidgetFormat.discount(deal.belowTypical) {
                    Text(discount)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(WidgetPalette.color(for: deal.dealLabel))
                }
                Text(WidgetFormat.pln(deal.price))
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
            }
        }
    }
}

// MARK: - Summary widget

struct SummaryWidgetContent: View {
    var entry: ScoutWidgetEntry
    var family: WidgetFamily

    var body: some View {
        if let snapshot = entry.snapshot {
            content(snapshot)
                .widgetURL(dealsURL)
        } else {
            WidgetMessageView(state: entry.state)
        }
    }

    @ViewBuilder
    private func content(_ snapshot: WidgetSnapshot) -> some View {
        let top = snapshot.deals.first
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: "flame.fill")
                        .font(.caption)
                    Text("\(snapshot.stats.strongDeals)")
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Label("\(snapshot.stats.strongDeals) strong deals", systemImage: "flame.fill")
                    .font(.headline)
                    .widgetAccentable()
                if let top {
                    Text(top.title)
                        .lineLimit(1)
                    Text([WidgetFormat.pln(top.price), WidgetFormat.discount(top.belowTypical)].compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        case .accessoryInline:
            Label(top.map { "\(snapshot.stats.strongDeals) strong · top \(WidgetFormat.pln($0.price))" } ?? "\(snapshot.stats.strongDeals) strong deals", systemImage: "flame")
        default:
            VStack(alignment: .leading, spacing: 6) {
                WidgetHeader(title: "Scout", trailing: nil)
                Spacer(minLength: 0)
                StatLine(value: snapshot.stats.strongDeals, title: "strong deals", color: WidgetPalette.orange, large: true)
                StatLine(value: snapshot.stats.newToday, title: "new today", color: .primary, large: false)
                if let top {
                    Text([WidgetFormat.pln(top.price), WidgetFormat.discount(top.belowTypical)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .lineLimit(1)
                }
                WidgetFooter(snapshot: snapshot, state: state)
            }
        }
    }

    private var state: WidgetState { entry.state }
}

private struct StatLine: View {
    var value: Int
    var title: String
    var color: Color
    var large: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("\(value)")
                .font(large ? .title.weight(.bold) : .headline)
                .monospacedDigit()
                .foregroundStyle(color)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Shared pieces

private struct WidgetHeader: View {
    var title: String
    var trailing: String?

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "flame.fill")
                .foregroundStyle(WidgetPalette.orange)
            Text(title)
                .font(.caption.weight(.bold))
            Spacer(minLength: 4)
            if let trailing {
                Text(trailing)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .font(.caption)
    }
}

private struct WidgetFooter: View {
    var snapshot: WidgetSnapshot
    var state: WidgetState

    var body: some View {
        Group {
            switch state {
            case .offline:
                Text("Offline · \(snapshot.generatedAt, style: .time)")
            default:
                if snapshot.isDemo {
                    Text("Demo data")
                } else {
                    Text("Updated \(snapshot.generatedAt, style: .time)")
                }
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

private struct DealChip: View {
    var label: DealLabel

    var body: some View {
        Text(label == .watch ? "Fair" : label.rawValue)
            .font(.system(size: 9, weight: .bold))
            .lineLimit(1)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .foregroundStyle(WidgetPalette.color(for: label))
            .background(WidgetPalette.color(for: label).opacity(0.16), in: Capsule())
    }
}

struct WidgetThumbnail: View {
    var deal: WidgetDeal
    var size: CGFloat

    var body: some View {
        Group {
            if let data = deal.thumbnail, let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    WidgetPalette.color(for: deal.marketplace).opacity(0.18)
                    Image(systemName: "tag.fill")
                        .font(.system(size: size * 0.4))
                        .foregroundStyle(WidgetPalette.color(for: deal.marketplace))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
    }
}

private struct WidgetMessageView: View {
    var state: WidgetState

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: state == .notConfigured ? "magnifyingglass.circle.fill" : "wifi.slash")
                .font(.title2)
                .foregroundStyle(WidgetPalette.blue)
            Text(verbatim: title)
                .font(.caption.weight(.semibold))
                .multilineTextAlignment(.center)
            if case let .offline(reason) = state {
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }
        }
        .widgetURL(dealsURL)
    }

    private var title: String {
        switch state {
        case .notConfigured: "Open Scout to connect to your server"
        case .offline: "Can't reach Scout"
        case .ready: "No data yet"
        }
    }
}
