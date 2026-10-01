import SwiftUI
import ScoutKit

struct MarketWatchEditorRequest: Identifiable {
    let id = UUID()
    var draft: MarketWatchDraft
    /// `nil` creates a new research watch.
    var watchID: String?

    static func create(_ draft: MarketWatchDraft = MarketWatchDraft()) -> MarketWatchEditorRequest {
        MarketWatchEditorRequest(draft: draft, watchID: nil)
    }

    static func edit(_ watch: MarketWatch) -> MarketWatchEditorRequest {
        MarketWatchEditorRequest(draft: MarketWatchDraft(watch: watch), watchID: watch.id)
    }
}

struct MarketWatchEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let request: MarketWatchEditorRequest

    @State private var draft: MarketWatchDraft
    @State private var minPrice: String
    @State private var maxPrice: String
    @State private var saving = false
    @State private var error: String?

    private static let intervals = [6, 12, 24, 48, 72, 168]

    init(request: MarketWatchEditorRequest) {
        self.request = request
        _draft = State(initialValue: request.draft)
        _minPrice = State(initialValue: request.draft.minPrice.map { String(Int($0)) } ?? "")
        _maxPrice = State(initialValue: request.draft.maxPrice.map { String(Int($0)) } ?? "")
    }

    private var isNew: Bool { request.watchID == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, e.g. Steam Deck OLED market", text: $draft.name)
                    TextField("Search query", text: $draft.query)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Research watch")
                } footer: {
                    Text(verbatim: isNew
                        ? "Research watches record asking-price snapshots separately from deal alerts."
                        : "Changing the search criteria starts a new comparable series. Earlier observations stay available as a previous series.")
                }

                Section("Matching") {
                    TextField("Must include, e.g. oled, 512gb", text: $draft.terms)
                        .textInputAutocapitalization(.never)
                    TextField("Exclude, e.g. broken, parts", text: $draft.excluded)
                        .textInputAutocapitalization(.never)
                }

                Section("Marketplaces") {
                    ForEach(Marketplace.all, id: \.self) { marketplace in
                        Toggle(isOn: sourceBinding(marketplace)) {
                            MarketplaceTag(marketplace: marketplace)
                                .font(.body)
                                .foregroundStyle(.primary)
                        }
                    }
                }

                Section("Filters") {
                    Picker("Condition", selection: $draft.condition) {
                        ForEach(conditionOptions, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("Minimum price (zł)", text: $minPrice)
                        .keyboardType(.numberPad)
                    TextField("Maximum price (zł)", text: $maxPrice)
                        .keyboardType(.numberPad)
                    Toggle("Shipping only", isOn: $draft.shippingOnly)
                    Toggle("Scan typo variants", isOn: $draft.typoVariants)
                }

                Section("Snapshots") {
                    Picker("Snapshot every", selection: $draft.intervalHours) {
                        ForEach(intervalOptions, id: \.self) { hours in
                            Text(verbatim: hours % 24 == 0 && hours >= 24 ? "\(hours / 24) d" : "\(hours) h").tag(hours)
                        }
                    }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(Text(verbatim: isNew ? "New research watch" : "Edit research watch"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(action: save) {
                            Text(verbatim: isNew ? "Create" : "Save")
                        }
                        .disabled(draft.validationError != nil)
                    }
                }
            }
            .onChange(of: minPrice) { _, text in draft.minPrice = Self.price(text) }
            .onChange(of: maxPrice) { _, text in draft.maxPrice = Self.price(text) }
            .interactiveDismissDisabled(saving)
        }
    }

    private var conditionOptions: [String] {
        MarketWatchDraft.conditions.contains(draft.condition) ? MarketWatchDraft.conditions : MarketWatchDraft.conditions + [draft.condition]
    }

    private var intervalOptions: [Int] {
        Self.intervals.contains(draft.intervalHours) ? Self.intervals : (Self.intervals + [draft.intervalHours]).sorted()
    }

    private func sourceBinding(_ marketplace: Marketplace) -> Binding<Bool> {
        Binding(
            get: { draft.sources.contains(marketplace) },
            set: { enabled in
                var selected = draft.sources.filter { $0 != marketplace }
                if enabled { selected.append(marketplace) }
                // Keep the saved order: the server compares sources exactly, so
                // re-enabling a marketplace must not reorder it and start a new series.
                let order = request.draft.sources + Marketplace.all.filter { !request.draft.sources.contains($0) }
                draft.sources = order.filter { selected.contains($0) }
            }
        )
    }

    private func save() {
        if let problem = draft.validationError {
            error = problem
            return
        }
        guard let client = model.client else { return }
        saving = true
        error = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                if let id = request.watchID {
                    try await client.updateMarketWatch(id: id, draft: draft, original: request.draft)
                } else {
                    _ = try await client.createMarketWatch(draft)
                }
                model.refreshUnlessLive()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private static func price(_ text: String) -> Double? {
        Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
    }
}
