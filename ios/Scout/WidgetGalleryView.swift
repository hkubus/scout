import SwiftUI
import WidgetKit
import ScoutKit

/// Renders the widget views at their iPhone sizes with the data the widgets
/// would show, so they can be checked without adding them to the Home Screen.
struct WidgetGalleryView: View {
    @Environment(AppModel.self) private var model

    private var entry: ScoutWidgetEntry {
        let snapshot = model.widgetSnapshot ?? SharedStore.loadSnapshot() ?? .demo
        return ScoutWidgetEntry(date: Date(), snapshot: snapshot, state: .ready)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Long-press the Home Screen, tap Edit → Add Widget, and search for Scout.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                GalleryItem(title: "Top deals — small and summary") {
                    HStack(spacing: 18) {
                        HomeWidgetFrame(width: 158) { DealsWidgetContent(entry: entry, family: .systemSmall) }
                        HomeWidgetFrame(width: 158) { SummaryWidgetContent(entry: entry, family: .systemSmall) }
                    }
                }
                GalleryItem(title: "Top deals — medium") {
                    HomeWidgetFrame(width: 338) { DealsWidgetContent(entry: entry, family: .systemMedium) }
                }
                GalleryItem(title: "Top deals — large") {
                    HomeWidgetFrame(width: 338, height: 354) { DealsWidgetContent(entry: entry, family: .systemLarge) }
                }
                GalleryItem(title: "Lock Screen") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 12) {
                            LockWidgetFrame(width: 72, height: 72) { SummaryWidgetContent(entry: entry, family: .accessoryCircular) }
                            LockWidgetFrame(width: 170, height: 72) { SummaryWidgetContent(entry: entry, family: .accessoryRectangular) }
                        }
                        LockWidgetFrame(width: 250, height: 26) { SummaryWidgetContent(entry: entry, family: .accessoryInline) }
                    }
                }
            }
            .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Widgets")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct GalleryItem<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
    }
}

private struct HomeWidgetFrame<Content: View>: View {
    var width: CGFloat
    var height: CGFloat = 158
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(16)
            .frame(width: width, height: height, alignment: .topLeading)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
    }
}

private struct LockWidgetFrame<Content: View>: View {
    var width: CGFloat
    var height: CGFloat
    @ViewBuilder var content: Content

    var body: some View {
        content
            .foregroundStyle(.white)
            .frame(width: width, height: height)
            .background(Color.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .environment(\.colorScheme, .dark)
    }
}
