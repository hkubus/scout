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
                facts(detail)
            }
        }
        .overlay { LoadingOverlay(isLoaded: detail != nil, error: error, retry: load) }
        .navigationTitle(detail?.listing.title ?? "Listing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let url = detail?.listing.webURL {
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
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else {
                        Color.secondary.opacity(0.1)
                    }
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

    private func facts(_ detail: ListingDetail) -> some View {
        let listing = detail.listing
        return Section("Details") {
            LabeledContent("Marketplace") { MarketplaceTag(marketplace: listing.marketplace) }
            LabeledContent("Watch", value: listing.watch)
            if let condition = listing.condition { LabeledContent("Condition", value: condition) }
            if let location = listing.location { LabeledContent("Location", value: location) }
            LabeledContent("Shipping", value: listing.shippingAvailable.map { $0 ? "Available" : "Pickup only" } ?? "Unknown")
            LabeledContent("First seen", value: Format.relative(iso: detail.firstSeenAt))
            LabeledContent("Last seen", value: Format.relative(iso: detail.lastSeenAt))
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
            self.detail = detail
            decision = detail.action.decision
            note = detail.action.note
            hidden = detail.action.hidden
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.localizedDescription }
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

private struct PriceHistoryChart: View {
    var points: [PriceHistoryPoint]
    var typical: Double?

    private struct Point: Identifiable {
        var id: Int
        var date: Date
        var price: Double
    }

    private var series: [Point] {
        points.enumerated().compactMap { index, point in
            point.date.map { Point(id: index, date: $0, price: point.price) }
        }
    }

    var body: some View {
        Chart {
            ForEach(series) { point in
                LineMark(x: .value("Date", point.date), y: .value("Price", point.price))
                    .interpolationMethod(.stepEnd)
                PointMark(x: .value("Date", point.date), y: .value("Price", point.price))
                    .symbolSize(18)
            }
            if let typical {
                RuleMark(y: .value("Typical", typical))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .foregroundStyle(.secondary)
                    .annotation(position: .top, alignment: .leading) {
                        Text("typical").font(.caption2).foregroundStyle(.secondary)
                    }
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine()
                AxisValueLabel {
                    if let price = value.as(Double.self) { Text(Format.pln(price)) }
                }
            }
        }
    }
}
