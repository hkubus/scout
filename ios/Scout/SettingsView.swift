import SwiftUI
import ScoutKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var health: Health?
    @State private var readiness: Readiness?
    @State private var connectors: [Connector] = []
    @State private var serverSettings: ServerSettings?
    @State private var updatingNotifications = false
    @State private var error: String?

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Address", value: model.serverURL?.absoluteString ?? "Demo data")
                    LabeledContent("Live updates") {
                        ConnectionIndicator()
                            .foregroundStyle(.secondary)
                    }
                    if case let .offline(reason) = model.connection {
                        Text(reason)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if let readiness {
                        LabeledContent("Status", value: readiness.isReady ? "Ready" : readiness.status.capitalized)
                        if let degraded = readiness.connectors?.degraded, !degraded.isEmpty {
                            LabeledContent("Degraded", value: degraded.joined(separator: ", "))
                        }
                    }
                    if let version = health?.version {
                        LabeledContent("Server version", value: version)
                    }
                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                    if let url = model.serverURL {
                        Link(destination: url) {
                            Label("Open web app", systemImage: "safari")
                        }
                    }
                    Button(role: .destructive) {
                        model.disconnect()
                    } label: {
                        Text(verbatim: model.isDemo ? "Leave demo" : "Change server")
                    }
                }

                if !connectors.isEmpty {
                    Section("Connectors") {
                        ForEach(connectors, id: \.name) { connector in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Circle()
                                        .fill(color(for: connector.status))
                                        .frame(width: 8, height: 8)
                                    Text(connector.name).font(.body.weight(.medium))
                                    Spacer()
                                    Text(connector.status)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Text(connector.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                Text("Last success \(connector.lastSuccess) · \(connector.latency)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }

                notificationsSection

                Section {
                    Button {
                        model.showWidgetGallery = true
                    } label: {
                        Label("Preview widgets", systemImage: "square.grid.2x2")
                    }
                } header: {
                    Text("Widgets")
                } footer: {
                    Text(widgetFooter)
                }

                Section {
                    LabeledContent("App version", value: Self.appVersion)
                } footer: {
                    Text("Marketplace prices shown in Scout are public asking prices, not completed sales.")
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(isPresented: $model.showWidgetGallery) {
                WidgetGalleryView()
            }
            .refreshable { await load() }
            .task(id: model.refreshToken) { await load() }
        }
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            async let loadedHealth = client.health()
            async let loadedReadiness = client.readiness()
            async let loadedConnectors = client.connectors()
            let (health, readiness, connectors) = try await (loadedHealth, loadedReadiness, loadedConnectors)
            self.health = health
            self.readiness = readiness
            self.connectors = connectors
            serverSettings = try? await client.settings()
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
        }
    }

    @ViewBuilder
    private var notificationsSection: some View {
        if let ntfy = serverSettings?.ntfy {
            Section {
                if !ntfy.configured {
                    Text("Set up ntfy in the Scout web app's Settings to get deal alerts on this phone.")
                        .foregroundStyle(.secondary)
                } else if let openInApp = ntfy.openInApp {
                    Toggle(isOn: Binding(get: { openInApp }, set: setOpenInApp)) {
                        Text("Open alerts in this app")
                    }
                    .disabled(updatingNotifications)
                } else {
                    Text("Update the Scout server to open ntfy alerts in this app.")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Notifications")
            } footer: {
                if ntfy.configured && ntfy.openInApp != nil {
                    Text("Tapping an ntfy alert opens the listing here, and the alert's Open listing button still goes to the marketplace. This applies to every device subscribed to the topic, so leave it off if you also read alerts on a computer or Android.")
                }
            }
        }
    }

    private func setOpenInApp(_ enabled: Bool) {
        guard let client = model.client else { return }
        updatingNotifications = true
        Task { @MainActor in
            defer { updatingNotifications = false }
            do {
                serverSettings = try await client.setNtfyOpenInApp(enabled)
            } catch {
                model.report(error)
            }
        }
    }

    private var widgetFooter: String {
        let add = "Long-press the Home Screen, tap Edit → Add Widget, and search for Scout. Lock Screen widgets are available too."
        if model.isDemo || SharedStore.isAvailable { return add }
        return add + " This install can't share the server address with widgets, so long-press a widget, choose Edit Widget, and enter your server address there."
    }

    private func color(for status: String) -> Color {
        switch status {
        case "OK": .scoutGreen
        case "Warning": .orange
        case "Degraded": .red
        default: .secondary
        }
    }

    private static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(build))"
    }
}
