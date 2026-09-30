import SwiftUI
import ScoutKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var health: Health?
    @State private var readiness: Readiness?
    @State private var connectors: [Connector] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    LabeledContent("Address", value: model.serverURL?.absoluteString ?? "Demo data")
                    LabeledContent("Live updates") {
                        ConnectionIndicator()
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

                Section {
                    LabeledContent("App version", value: Self.appVersion)
                } footer: {
                    Text("Marketplace prices shown in Scout are public asking prices, not completed sales.")
                }
            }
            .navigationTitle("Settings")
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
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
        }
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
