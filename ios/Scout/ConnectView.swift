import SwiftUI

struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var apiToken = ""
    @State private var connecting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        Image(systemName: "magnifyingglass.circle.fill")
                            .font(.system(size: 64))
                            .foregroundStyle(Color.scoutBlue)
                        Text("Connect to Scout")
                            .font(.title2.bold())
                        Text("Enter the address of the Scout server you run on your network.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section {
                    TextField("scout.lan:3001", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(connect)
                    SecureField("API token (if the server requires sign-in)", text: $apiToken)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(connect)
                    Button(action: connect) {
                        HStack {
                            Text("Connect")
                            Spacer()
                            if connecting { ProgressView() }
                        }
                    }
                    .disabled(connecting || address.trimmingCharacters(in: .whitespaces).isEmpty)
                } header: {
                    Text("Server address")
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(.red)
                    } else {
                        Text("Addresses without a scheme use https://. Type http:// for a plain LAN address. If the server has sign-in enabled, paste one of its SCOUT_API_TOKENS; it's kept in the Keychain.")
                    }
                }

                Section {
                    Button("Explore with demo data") { model.useDemo() }
                }
            }
            .navigationTitle("Scout")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear { if address.isEmpty { address = model.lastServerAddress } }
    }

    private func connect() {
        guard !connecting else { return }
        connecting = true
        error = nil
        Task { @MainActor in
            defer { connecting = false }
            do {
                try await model.connect(to: address, apiToken: apiToken)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
