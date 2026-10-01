import Charts
import SwiftUI
import ScoutKit

struct ListingDetailView: View {
    @Environment(AppModel.self) private var model
    var link: ListingLink

    @State private var detail: ListingDetail?
    @State private var error: String?
    @State private var decision: ListingDecision?
    @State private var note = ""
    @State private var hidden = false
    @State private var saving = false
    @State private var previewOnly = false
    @State private var editor: WatchEditorRequest?
    @State private var descriptionExpanded = false

    var body: some View {
        List {
            if let detail {
                header(detail.listing)
                triage(detail)
                verification(detail)
                // A flat line says nothing a sentence can't.
                if Set(detail.history.map(\.price)).count > 1 {
                    Section("Price history") {
                        PriceHistoryChart(points: detail.history, typical: detail.listing.typical)
                            .frame(height: 120)
                            .padding(.vertical, 4)
                    }
                }
                if let text = detail.descriptionSnapshot?.description, !text.isEmpty {
                    Section("Description") {
                        Text(text)
                            .font(.callout)
                            .lineLimit(descriptionExpanded ? nil : 6)
                            .textSelection(.enabled)
                        if !descriptionExpanded && text.count > 280 {
                            Button("Show full description") { descriptionExpanded = true }
                                .font(.callout)
                        }
                    }
                }
                facts(detail.listing, detail: detail)
                createWatch(detail.listing)
            } else if previewOnly, let listing = link.preview {
                header(listing)
                Section {
                    Text("Scout hasn't stored the full details for this listing yet.")
                        .foregroundStyle(.secondary)
                }
                facts(listing, detail: nil)
                createWatch(listing)
            }
        }
        .sheet(item: $editor) { request in
            WatchEditorView(request: request) { created in
                if let created { model.showWatch(created) }
            }
        }
        .overlay { LoadingOverlay(isLoaded: detail != nil || previewOnly, error: error, retry: load) }
        .navigationTitle(shownListing?.title ?? "Listing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let url = shownListing?.webURL {
                    ShareLink(item: url)
                    Link(destination: url) {
                        Label("Open listing", systemImage: "safari")
                    }
                }
            }
        }
        .task(id: link) { await load() }
    }

    // MARK: Sections

    @ViewBuilder
    private func header(_ listing: Listing) -> some View {
        Section {
            if let url = listing.imageURL {
                PipelineImage(url: url, contentMode: .fit, pointSize: ImagePipeline.headerPoints) {
                    Color.secondary.opacity(0.1)
                }
                .frame(maxWidth: .infinity, minHeight: 200, maxHeight: 320)
                .listRowInsets(EdgeInsets())
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(listing.title)
                    .font(.title3.weight(.semibold))
                if !listing.subtitle.isEmpty {
                    Text(listing.subtitle)
                        .foregroundStyle(.secondary)
                }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Format.pln(listing.price))
                        .font(.largeTitle.weight(.bold))
                        .monospacedDigit()
                    if listing.priceNegotiable == true {
                        Text("negotiable")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let typical = listing.typical {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let below = listing.belowTypical, below < 0 {
                            Text(Format.versusTypical(below))
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(listing.dealStrength >= 3 ? listing.dealLabel.color : .primary)
                        } else if let below = listing.belowTypical, below > 0 {
                            Text(Format.versusTypical(below))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Text(verbatim: "typical \(Format.pln(typical))" + (listing.typicalSource == "reference-band" ? " (research)" : ""))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("Typical price is still learning")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Text(verbatim: factsLine(listing))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    /// The decision and Hide save as soon as they change; only a note needs Save.
    private func triage(_ detail: ListingDetail) -> some View {
        Section {
            Picker("Decision", selection: $decision) {
                Text("None").tag(ListingDecision?.none)
                ForEach(ListingDecision.allCases, id: \.self) { decision in
                    Text(decision.title).tag(ListingDecision?.some(decision))
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: decision) { _, value in
                if value != detail.action.decision { save() }
            }
            TextField("Note", text: $note, axis: .vertical)
                .lineLimit(1...6)
            if note != detail.action.note {
                Button {
                    save()
                } label: {
                    HStack {
                        Text("Save note")
                        Spacer()
                        if saving { ProgressView() }
                    }
                }
                .disabled(saving)
            }
            Toggle("Hide from feeds and alerts", isOn: $hidden)
                .onChange(of: hidden) { _, value in
                    if value != detail.action.hidden { save() }
                }
        }
    }

    @ViewBuilder
    private func verification(_ detail: ListingDetail) -> some View {
        let listing = detail.listing
        if let result = listing.aiDescriptionVerification {
            let verdict = VerificationVerdict(decision: result.decision)
            Section("AI check") {
                VStack(alignment: .leading, spacing: 4) {
                    Label(verdict.title, systemImage: verdict.symbol)
                        .foregroundStyle(verdict.color)
                    Text(result.summary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(result.issues, id: \.self) { issue in
                    Label(issue, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                }
            }
        } else if let status = listing.aiDescriptionVerificationStatus, status == "pending" {
            Section("AI check") {
                Label("Checking the description…", systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func createWatch(_ listing: Listing) -> some View {
        Section {
            Button {
                editor = .create(WatchDraft(listing: listing))
            } label: {
                Label("Create a watch from this listing", systemImage: "bell.badge")
            }
        }
    }

    private var shownListing: Listing? {
        detail?.listing ?? (previewOnly ? link.preview : nil)
    }

    /// Marketplace, shipping, condition and place on one line under the price.
    private func factsLine(_ listing: Listing) -> String {
        var parts = [listing.marketplace.rawValue]
        if let shipping = listing.shippingAvailable { parts.append(shipping ? "shipping" : "pickup only") }
        if let condition = listing.condition { parts.append(condition) }
        if let location = listing.location { parts.append(location) }
        if let variant = listing.variantLabel { parts.append("model \(variant)") }
        return parts.joined(separator: " · ")
    }

    private func facts(_ listing: Listing, detail: ListingDetail?) -> some View {
        Section("Details") {
            LabeledContent("Watch", value: listing.watch)
            if let detail {
                LabeledContent("Seen", value: "\(Format.relative(iso: detail.firstSeenAt)) – \(Format.relative(iso: detail.lastSeenAt))")
            }
        }
    }

    // MARK: Actions

    private func load() async {
        guard let client = model.client else { return }
        do {
            let detail = try await client.listingDetail(key: link.key, watchId: link.watchId)
            self.detail = detail
            decision = detail.action.decision
            note = detail.action.note
            hidden = detail.action.hidden
            previewOnly = false
            error = nil
        } catch {
            if error.isCancellation { return }
            if link.preview != nil, let apiError = error as? ScoutAPIError, case .server(status: 404, message: _) = apiError {
                previewOnly = true
            } else {
                self.error = error.localizedDescription
            }
        }
    }

    private func save() {
        guard let client = model.client, detail != nil else { return }
        saving = true
        Task { @MainActor in
            defer { saving = false }
            do {
                let action = try await client.updateListingAction(key: link.key, action: ListingAction(decision: decision, note: note, hidden: hidden))
                detail?.action = action
                detail?.listing.decision = action.decision
                detail?.listing.hidden = action.hidden
            } catch {
                model.report(error)
            }
        }
    }
}

private struct VerificationVerdict {
    var title: String
    var symbol: String
    var color: Color

    init(decision: String) {
        switch decision {
        case "pass":
            title = "Description checks out"
            symbol = "checkmark.seal.fill"
            color = .scoutGreen
        case "reject":
            title = "Description raises concerns"
            symbol = "exclamationmark.octagon.fill"
            color = .red
        default:
            title = "Inconclusive"
            symbol = "questionmark.circle"
            color = .secondary
        }
    }
}
