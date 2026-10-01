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
    @State private var resalePrice = ""
    @State private var sellOn: FlipChannel = .olx
    @State private var feePresets = FeePresets.defaults
    @State private var addingFlip = false
    @State private var flipAdded = false

    var body: some View {
        List {
            if let detail {
                header(detail.listing)
                if detail.history.count > 1 {
                    Section("Price history") {
                        PriceHistoryChart(points: detail.history, typical: detail.listing.typical)
                            .frame(height: 170)
                            .padding(.vertical, 6)
                    }
                }
                triage(detail)
                verification(detail)
                if let text = detail.descriptionSnapshot?.description, !text.isEmpty {
                    Section("Description") {
                        Text(text)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                }
                facts(detail.listing, detail: detail)
                flip(detail.listing)
                createWatch(detail.listing)
            } else if previewOnly, let listing = link.preview {
                header(listing)
                Section {
                    Text("Scout hasn't stored the full details for this listing yet.")
                        .foregroundStyle(.secondary)
                }
                facts(listing, detail: nil)
                flip(listing)
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
        .task { await loadFeePresets() }
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
                HStack(spacing: 8) {
                    DealBadge(label: listing.dealLabel)
                    if let below = listing.belowTypical {
                        Text(Format.versusTypical(below))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(below < 0 ? listing.dealLabel.color : .secondary)
                    }
                }
                if let typical = listing.typical {
                    Text(verbatim: "Typical asking price \(Format.pln(typical))" + (listing.typicalSource == "reference-band" ? " (research band)" : ""))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let variant = listing.variantLabel {
                    Label("Model: \(variant)", systemImage: "square.stack.3d.up")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func triage(_ detail: ListingDetail) -> some View {
        Section {
            Picker("Decision", selection: $decision) {
                Text("None").tag(ListingDecision?.none)
                ForEach(ListingDecision.allCases, id: \.self) { decision in
                    Text(decision.title).tag(ListingDecision?.some(decision))
                }
            }
            .pickerStyle(.segmented)
            TextField("Note", text: $note, axis: .vertical)
                .lineLimit(2...6)
            Toggle("Hide from feeds and alerts", isOn: $hidden)
            Button {
                save()
            } label: {
                HStack {
                    Text("Save")
                    Spacer()
                    if saving { ProgressView() }
                }
            }
            .disabled(saving || !hasChanges(detail.action))
        } header: {
            Text("Triage")
        } footer: {
            if let updated = detail.action.updatedAt {
                Text("Updated \(Format.relative(iso: updated))")
            }
        }
    }

    @ViewBuilder
    private func verification(_ detail: ListingDetail) -> some View {
        let listing = detail.listing
        if let result = listing.aiDescriptionVerification {
            let verdict = VerificationVerdict(decision: result.decision)
            Section {
                Label(verdict.title, systemImage: verdict.symbol)
                    .foregroundStyle(verdict.color)
                Text(result.summary)
                    .font(.callout)
                ForEach(result.issues, id: \.self) { issue in
                    Label(issue, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                }
                ForEach(result.evidence, id: \.self) { evidence in
                    Text(evidence)
                        .font(.footnote.italic())
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("AI check")
            } footer: {
                Text(verbatim: ["Confidence \(Int((result.confidence * 100).rounded()))%", detail.verificationModel].compactMap { $0 }.joined(separator: " · "))
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
        } footer: {
            Text("Starts from the cleaned-up title, this marketplace, and a price range of ±25% around this price.")
        }
    }

    /// Display-only estimate: resale minus the chosen platform's seller fee
    /// and this price. "I bought this" starts a flip in the ledger.
    private func flip(_ listing: Listing) -> some View {
        Section {
            TextField("Expected resale (zł)", text: $resalePrice)
                .keyboardType(.numberPad)
            Picker("Sell on", selection: $sellOn) {
                ForEach(FlipChannel.all) { channel in
                    Text(verbatim: channel.rawValue).tag(channel)
                }
            }
            if let estimate = flipEstimate(for: listing) {
                LabeledContent("Platform fee", value: Format.zl(estimate.fee))
                LabeledContent("Net if resold") {
                    Text(verbatim: Format.zl(estimate.net))
                        .monospacedDigit()
                        .foregroundStyle(estimate.net >= 0 ? Color.scoutGreen : Color.red)
                }
            }
            Button {
                addFlip(listing)
            } label: {
                HStack {
                    Label(flipAdded ? "Added to Flips" : "I bought this", systemImage: flipAdded ? "checkmark.circle" : "shippingbox")
                    Spacer()
                    if addingFlip { ProgressView() }
                }
            }
            .disabled(addingFlip || flipAdded)
        } header: {
            Text("Flip")
        } footer: {
            Text("An estimate from the fee presets in Market → Flips. “I bought this” adds the item to your ledger at this price, dated today.")
        }
    }

    private func flipEstimate(for listing: Listing) -> (fee: Double, net: Double)? {
        guard let resale = Double(resalePrice.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")), resale > 0 else { return nil }
        return Profit.estimate(buyPrice: listing.price, buyCosts: 0, resalePrice: resale, preset: feePresets[sellOn])
    }

    private func addFlip(_ listing: Listing) {
        guard let client = model.client else { return }
        addingFlip = true
        Task { @MainActor in
            defer { addingFlip = false }
            do {
                _ = try await client.createFlip(FlipDraft(listing: listing))
                flipAdded = true
            } catch {
                model.report(error)
            }
        }
    }

    private func loadFeePresets() async {
        guard let client = model.client, let data = try? await client.flips() else { return }
        feePresets = data.feePresets
    }

    private var shownListing: Listing? {
        detail?.listing ?? (previewOnly ? link.preview : nil)
    }

    private func facts(_ listing: Listing, detail: ListingDetail?) -> some View {
        Section("Details") {
            LabeledContent("Marketplace") { MarketplaceTag(marketplace: listing.marketplace) }
            LabeledContent("Watch", value: listing.watch)
            if let condition = listing.condition { LabeledContent("Condition", value: condition) }
            if let location = listing.location { LabeledContent("Location", value: location) }
            LabeledContent("Shipping", value: listing.shippingAvailable.map { $0 ? "Available" : "Pickup only" } ?? "Unknown")
            if let posted = listing.postedDate {
                LabeledContent("Posted", value: Format.relative(posted))
                if let bumped = listing.bumpedDate {
                    LabeledContent("Last bumped", value: Format.relative(bumped))
                }
            }
            if let seller = listing.sellerType {
                LabeledContent("Seller", value: (seller == SellerType.business.rawValue ? "Business" : "Private") + (listing.promoted == true ? " · promoted" : ""))
            } else if listing.promoted == true {
                LabeledContent("Promoted", value: "Yes")
            }
            if let detail {
                LabeledContent("First seen", value: Format.relative(iso: detail.firstSeenAt))
                LabeledContent("Last seen", value: Format.relative(iso: detail.lastSeenAt))
            }
        }
    }

    // MARK: Actions

    private func hasChanges(_ action: ListingAction) -> Bool {
        decision != action.decision || note != action.note || hidden != action.hidden
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            let detail = try await client.listingDetail(key: link.key, watchId: link.watchId)
            if self.detail == nil {
                // Resell on the same platform at the typical price by default.
                sellOn = FlipChannel(detail.listing.marketplace)
                if resalePrice.isEmpty, let typical = detail.listing.typical { resalePrice = String(Int(typical.rounded())) }
            }
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
