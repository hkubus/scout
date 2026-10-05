import SwiftUI
import ScoutKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var health: Health?
    @State private var readiness: Readiness?
    @State private var connectors: [Connector] = []
    @State private var serverSettings: ServerSettings?
    @State private var updatingNotifications = false
    @State private var newAPIToken = ""
    @State private var savingAPIToken = false
    @State private var apiTokenError: String?
    @State private var error: String?

    /// Pushed from the gear on Deals.
    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                NavigationLink(value: WatchesRoute()) {
                    Label("Watches", systemImage: "binoculars")
                }
            } footer: {
                Text("What Scout scans for deals, and how often.")
            }

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
                // Connector trouble shows in the Connectors list below.
                if let readiness, !readiness.isReady {
                    LabeledContent("Status", value: readiness.status.capitalized)
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

            notificationsSection

            if !connectors.isEmpty {
                Section("Connectors") {
                    ForEach(connectors, id: \.name) { connector in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Circle()
                                    .fill(color(for: connector.status))
                                    .frame(width: 8, height: 8)
                                Text(connector.name)
                                Spacer()
                                Text(connector.status == "OK" ? connector.lastSuccess : connector.status)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            // Only a problem needs its explanation.
                            if connector.status != "OK" && connector.status != "Idle" {
                                Text(connector.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }

            apiTokenSection

            Section {
                // The gallery is a screenshot surface; the system widget picker previews widgets for everyone else.
                if model.isDemo {
                    Button {
                        model.showWidgetGallery = true
                    } label: {
                        Label("Preview widgets", systemImage: "square.grid.2x2")
                    }
                }
                LabeledContent("App version", value: Self.appVersion)
                if let version = health?.version {
                    LabeledContent("Server version", value: version)
                }
            } footer: {
                Text(widgetFooter)
            }
        }
        .navigationTitle("Settings")
        .navigationDestination(isPresented: $model.showWidgetGallery) {
            WidgetGalleryView()
        }
        .refreshable { await load() }
        .reloadOnChange(of: model.serverToken) { await load() }
    }

    @discardableResult
    private func load() async -> Bool {
        guard let client = model.client else { return false }
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
            // A cancelled or failed settings fetch leaves the server settings
            // section missing, so don't mark the load done: the next
            // appearance loads again.
            return !Task.isCancelled && serverSettings != nil
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
            return false
        }
    }

    @ViewBuilder
    private var apiTokenSection: some View {
        if !model.isDemo, let client = model.client {
            Section {
                DisclosureGroup {
                    SecureField(client.apiToken == nil ? "Paste an API token" : "Paste a new API token", text: $newAPIToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit { saveAPIToken(newAPIToken) }
                    Button {
                        saveAPIToken(newAPIToken)
                    } label: {
                        HStack {
                            Text("Save token")
                            Spacer()
                            if savingAPIToken { ProgressView() }
                        }
                    }
                    .disabled(savingAPIToken || newAPIToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if client.apiToken != nil {
                        Button("Remove token", role: .destructive) { saveAPIToken("") }
                            .disabled(savingAPIToken)
                    }
                } label: {
                    LabeledContent("API token", value: Self.masked(client.apiToken))
                }
            } footer: {
                if let apiTokenError {
                    Text(apiTokenError).foregroundStyle(.red)
                }
            }
        }
    }

    /// Verifies the token with the server, then keeps it; an empty one clears it.
    private func saveAPIToken(_ token: String) {
        guard !savingAPIToken else { return }
        savingAPIToken = true
        apiTokenError = nil
        Task { @MainActor in
            defer { savingAPIToken = false }
            do {
                try await model.updateAPIToken(token)
                newAPIToken = ""
            } catch {
                if !error.isCancellation { apiTokenError = error.localizedDescription }
            }
        }
    }

    /// Only the last characters, enough to tell tokens apart.
    private static func masked(_ token: String?) -> String {
        guard let token else { return "None" }
        return token.count > 8 ? "••••\(token.suffix(4))" : "••••"
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
                    Text("Applies to every device on the topic; leave it off if you also read alerts on a computer or Android.")
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
        let add = "Widgets: long-press the Home Screen, tap Edit → Add Widget, and search for Scout."
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
