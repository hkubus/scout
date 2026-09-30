import SwiftUI
import ScoutKit

/// Create a watch, or edit an existing one's main settings.
struct WatchEditorRequest: Identifiable {
    let id = UUID()
    var draft: WatchDraft
    /// `nil` creates a new watch.
    var watchID: String?

    static func create(_ draft: WatchDraft = WatchDraft()) -> WatchEditorRequest {
        WatchEditorRequest(draft: draft, watchID: nil)
    }

    static func edit(_ watch: Watch) -> WatchEditorRequest {
        WatchEditorRequest(draft: WatchDraft(watch: watch), watchID: watch.id)
    }
}

struct WatchEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let request: WatchEditorRequest
    /// Called with the created watch, or `nil` after an edit.
    var onSaved: (Watch?) -> Void

    @State private var draft: WatchDraft
    @State private var minPrice: String
    @State private var maxPrice: String
    @State private var saving = false
    @State private var error: String?

    private static let intervals = [5, 10, 15, 30, 60, 120, 240, 720, 1440]

    init(request: WatchEditorRequest, onSaved: @escaping (Watch?) -> Void) {
        self.request = request
        self.onSaved = onSaved
        _draft = State(initialValue: request.draft)
        _minPrice = State(initialValue: request.draft.minPrice.map { String(Int($0)) } ?? "")
        _maxPrice = State(initialValue: request.draft.maxPrice.map { String(Int($0)) } ?? "")
    }

    private var isNew: Bool { request.watchID == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name, e.g. Steam Deck OLED 512GB", text: $draft.name)
                    TextField("Search query", text: $draft.query)
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Watch")
                } footer: {
                    Text("Scout searches every selected marketplace for the query, learns the typical asking price, and alerts on listings well below it.")
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
                    TextField("Location", text: $draft.location)
                    TextField("Minimum price (zł)", text: $minPrice)
                        .keyboardType(.numberPad)
                    TextField("Maximum price (zł)", text: $maxPrice)
                        .keyboardType(.numberPad)
                    Toggle("Require shipping", isOn: $draft.shippingOnly)
                }

                Section {
                    Picker("Scan every", selection: $draft.interval) {
                        ForEach(intervalOptions, id: \.self) { minutes in
                            Text(Format.minutes(Double(minutes))).tag(minutes)
                        }
                    }
                    Picker("Sensitivity", selection: $draft.sensitivity) {
                        ForEach(sensitivityOptions, id: \.self) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                    Toggle("Scan typo variants", isOn: $draft.typoVariants)
                    Toggle("AI relevance filtering", isOn: $draft.aiRelevance)
                } header: {
                    Text("Scanning")
                } footer: {
                    Text(verbatim: isNew
                        ? "Typo variants add up to 2 extra searches per scan. AI filtering drops accessories, parts, and unrelated listings."
                        : "Model variants, exact search URLs, per-marketplace intervals, and research baselines are edited in the web app and are kept as they are.")
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(Text(verbatim: isNew ? "New watch" : "Edit watch"))
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

    /// Standard choices plus the watch's current value when it's non-standard.
    private var conditionOptions: [String] {
        WatchDraft.conditions.contains(draft.condition) ? WatchDraft.conditions : WatchDraft.conditions + [draft.condition]
    }

    private var intervalOptions: [Int] {
        Self.intervals.contains(draft.interval) ? Self.intervals : (Self.intervals + [draft.interval]).sorted()
    }

    private struct SensitivityOption: Hashable {
        var label: String
        var value: Double
    }

    private var sensitivityOptions: [SensitivityOption] {
        let standard = WatchDraft.sensitivities.map { SensitivityOption(label: $0.label, value: $0.value) }
        if standard.contains(where: { $0.value == draft.sensitivity }) { return standard }
        return standard + [SensitivityOption(label: "Custom (\(draft.sensitivity.formatted()))", value: draft.sensitivity)]
    }

    private func sourceBinding(_ marketplace: Marketplace) -> Binding<Bool> {
        Binding(
            get: { draft.sources.contains(marketplace) },
            set: { enabled in
                if enabled {
                    if !draft.sources.contains(marketplace) { draft.sources.append(marketplace) }
                } else {
                    draft.sources.removeAll { $0 == marketplace }
                }
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
                    try await client.updateWatch(id: id, draft: draft)
                    onSaved(nil)
                } else {
                    let watch = try await client.createWatch(draft)
                    onSaved(watch)
                }
                model.refresh()
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
