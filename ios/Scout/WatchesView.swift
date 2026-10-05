import SwiftUI
import ScoutKit

/// Settings → Watches, pushed on the Deals stack, so its pushes go there too.
struct WatchesView: View {
    @Environment(AppModel.self) private var model
    @State private var watches: [Watch]?
    @State private var includeArchived = false
    @State private var error: String?
    @State private var editor: WatchEditorRequest?

    private struct LoadKey: Hashable {
        var includeArchived: Bool
        var watchesToken: Int
    }

    var body: some View {
        List {
            if watches == nil && error == nil {
                PlaceholderRows(thumbnail: nil)
            }
            if let watches {
                if watches.isEmpty {
                    ContentUnavailableView("No watches", systemImage: "binoculars", description: Text("Tap + to create a watch."))
                }
                ForEach(watches) { watch in
                    NavigationLink(value: watch) {
                        WatchRow(watch: watch)
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            scan(watch)
                        } label: {
                            Label("Scan now", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .tint(.scoutBlue)
                    }
                    .swipeActions(edge: .trailing) {
                        if !watch.isArchived {
                            Button {
                                setEnabled(!watch.enabled, for: watch)
                            } label: {
                                Label(watch.enabled ? "Pause" : "Resume", systemImage: watch.enabled ? "pause.fill" : "play.fill")
                            }
                            .tint(watch.enabled ? Color.orange : Color.scoutGreen)
                        }
                    }
                    .contextMenu { actions(for: watch) }
                }
                Section {
                    Toggle("Show archived watches", isOn: $includeArchived)
                }
            }
        }
        .animation(.default, value: watches)
        .overlay { LoadingOverlay(isLoaded: watches != nil, error: error, spinner: false, retry: { await load() }) }
        .navigationTitle("Watches")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editor = .create()
                } label: {
                    Label("New watch", systemImage: "plus")
                }
            }
        }
        .refreshable { await load() }
        .reloadOnChange(of: LoadKey(includeArchived: includeArchived, watchesToken: model.watchesToken)) { await load() }
        .onChange(of: model.pendingWatchID) { _, id in
            if id != nil { Task { @MainActor in await load() } }
        }
        .onChange(of: model.pendingNewWatch != nil, initial: true) {
            if let draft = model.pendingNewWatch {
                model.pendingNewWatch = nil
                editor = .create(draft)
            }
        }
        .sheet(item: $editor) { request in
            WatchEditorView(request: request) { created in
                if let created { model.dealsPath.append(created) }
            }
        }
    }

    @ViewBuilder
    private func actions(for watch: Watch) -> some View {
        Button {
            scan(watch)
        } label: {
            Label("Scan now", systemImage: "arrow.triangle.2.circlepath")
        }
        if !watch.isArchived {
            Button {
                setEnabled(!watch.enabled, for: watch)
            } label: {
                Label(watch.enabled ? "Pause" : "Resume", systemImage: watch.enabled ? "pause" : "play")
            }
        }
        Button {
            editor = .edit(watch)
        } label: {
            Label("Edit watch", systemImage: "pencil")
        }
        Button {
            model.dealsPath.append(WatchListingsRoute(watchId: watch.id, name: watch.name))
        } label: {
            Label("Listings", systemImage: "list.bullet.rectangle")
        }
        Divider()
        Button(role: watch.isArchived ? nil : .destructive) {
            setArchived(!watch.isArchived, for: watch)
        } label: {
            Label(watch.isArchived ? "Restore watch" : "Archive watch", systemImage: watch.isArchived ? "tray.and.arrow.up" : "archivebox")
        }
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
        do {
            let loaded = try await client.watches(includeArchived: includeArchived)
            watches = loaded
            error = nil
            if let id = model.pendingWatchID, let watch = loaded.first(where: { $0.id == id }) {
                model.pendingWatchID = nil
                model.dealsPath.append(watch)
            }
            return true
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
            return false
        }
    }

    private func setEnabled(_ enabled: Bool, for watch: Watch) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                try await client.updateWatch(id: watch.id, patch: WatchPatch(enabled: enabled))
                model.play(.selection)
                await load()
            } catch {
                model.report(error)
            }
        }
    }

    private func setArchived(_ archived: Bool, for watch: Watch) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                try await client.updateWatch(id: watch.id, patch: WatchPatch(archived: archived))
                model.play(.success)
                await load()
                model.refreshUnlessLive()
            } catch {
                model.report(error)
            }
        }
    }

    private func scan(_ watch: Watch) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                _ = try await client.queueScan(watchId: watch.id)
                model.play(.success)
            } catch {
                model.report(error)
            }
        }
    }
}

struct WatchStatusBadge: View {
    var status: String

    private var color: Color {
        if status.hasPrefix("Learning") { return .scoutBlue }
        switch status {
        case "Ready": return .scoutGreen
        case "Paused": return .orange
        default: return .secondary
        }
    }

    var body: some View {
    Text(status)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
    }
}

/// Two lines: the name and its state, then its deals and schedule.
private struct WatchRow: View {
    var watch: Watch

    var body: some View {
    VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline) {
            Text(watch.name)
                .font(.headline)
                .lineLimit(1)
            Spacer()
            WatchStatusBadge(status: watch.status == "Learning" ? "Learning \(Int(min(watch.readiness, 100)))%" : watch.status)
        }
        HStack(spacing: 10) {
            DealCountChips(counts: watch.dealCounts)
            Spacer(minLength: 0)
            Text(verbatim: schedule)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
    .padding(.vertical, 2)
    .opacity(watch.enabled ? 1 : 0.6)
    }

    private var schedule: String {
        let sources = watch.sources.map { $0 == .allegroLokalnie ? "Allegro" : $0.rawValue }.joined(separator: ", ")
        return watch.enabled ? "\(sources) · every \(Format.minutes(watch.interval))" : "\(sources) · paused"
    }
}

struct DealCountChips: View {
    var counts: WatchDealCounts

    var body: some View {
    if counts.total == 0 {
        Text("No strong deals")
            .font(.caption)
            .foregroundStyle(.secondary)
    } else {
        HStack(spacing: 6) {
            chip(counts.exceptional, label: .exceptional)
            chip(counts.veryStrong, label: .veryStrong)
            chip(counts.strong, label: .strong)
        }
    }
    }

    @ViewBuilder
    private func chip(_ count: Int, label: DealLabel) -> some View {
        if count > 0 {
            Text("\(count) \(label.rawValue.lowercased())")
                .font(.caption.weight(.semibold))
                .foregroundStyle(label.color)
        }
    }
}
