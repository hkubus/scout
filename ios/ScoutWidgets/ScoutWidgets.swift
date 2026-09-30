import AppIntents
import SwiftUI
import WidgetKit

@main
struct ScoutWidgetsBundle: WidgetBundle {
    var body: some Widget {
        DealsWidget()
        SummaryWidget()
    }
}

/// Lets a widget point at a server directly when it can't read the app's
/// connection through the shared App Group.
struct ScoutWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Scout server"
    static var description = IntentDescription("Shows deals from your Scout server.")

    @Parameter(title: "Server address", description: "Leave empty to use the server the Scout app is connected to.")
    var serverAddress: String?

    init() {}
}

struct DealsWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ScoutDeals", intent: ScoutWidgetIntent.self, provider: ScoutTimelineProvider()) { entry in
            DealsWidgetView(entry: entry)
        }
        .configurationDisplayName("Top deals")
        .description("The strongest current deals from your watches.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct SummaryWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ScoutSummary", intent: ScoutWidgetIntent.self, provider: ScoutTimelineProvider()) { entry in
            SummaryWidgetView(entry: entry)
        }
        .configurationDisplayName("Scout summary")
        .description("Strong deals, new listings today, and active watches.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct DealsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: ScoutWidgetEntry

    var body: some View {
        DealsWidgetContent(entry: entry, family: family)
            .containerBackground(.fill.tertiary, for: .widget)
    }
}

private struct SummaryWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: ScoutWidgetEntry

    var body: some View {
        SummaryWidgetContent(entry: entry, family: family)
            .containerBackground(.fill.tertiary, for: .widget)
    }
}
