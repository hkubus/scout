import SwiftUI
import ScoutKit

/// The flip ledger: what was bought, where it is listed, and what each sale
/// netted. Private bookkeeping, like the web Flips page; nothing here feeds
/// Scout's market statistics.
struct FlipsView: View {
    @Environment(AppModel.self) private var model
    @State private var data: FlipsData?
    @State private var error: String?
    @State private var editor: FlipEditorRequest?
    @State private var selling: Flip?

    var body: some View {
        List {
            if let data, let summary {
                summarySection(summary)
                let unsold = data.flips.filter { !$0.isSold }
                let sold = data.flips.filter(\.isSold)
                if data.flips.isEmpty {
                    Section {
                        Text("No flips yet. Add one with +, or use “I bought this” in a listing's details.")
                            .foregroundStyle(.secondary)
                    }
                }
                if !unsold.isEmpty {
                    Section("Unsold") {
                        ForEach(unsold) { flip in
                            flipRow(flip)
                        }
                    }
                }
                if !sold.isEmpty {
                    Section("Sold") {
                        ForEach(sold) { flip in
                            flipRow(flip)
                        }
                    }
                }
                Section {
                    ForEach(summary.platforms, id: \.channel) { platform in
                        LabeledContent {
                            Text(verbatim: "\(platform.sales) / \(Profit.dac7Sales)")
                                .monospacedDigit()
                                .foregroundStyle(Double(platform.sales) >= Double(Profit.dac7Sales) * 0.8 ? Color.dealOrange : Color.primary)
                        } label: {
                            Text(verbatim: platform.channel.rawValue)
                            Text(verbatim: "\(Format.zl(platform.revenue)) in sales")
                        }
                    }
                } header: {
                    Text(verbatim: "DAC7 · sales per platform in \(String(summary.quarter.year))")
                } footer: {
                    Text("A platform reports you to the tax office after 30 sales or 2 000 € of sales on it in a year. It is only a report and creates no tax by itself.")
                }
                Section {
                    NavigationLink {
                        SalesRecordView(flips: data.flips)
                    } label: {
                        Label("Sales record", systemImage: "list.number")
                    }
                    NavigationLink {
                        FeePresetsView(presets: data.feePresets) { saved in
                            self.data?.feePresets = saved
                        }
                    } label: {
                        Label("Seller fee presets", systemImage: "percent")
                    }
                } footer: {
                    Text("The sales record is the uproszczona ewidencja sprzedaży for działalność nierejestrowana. These figures are for your own records, not tax advice.")
                }
            }
        }
        .overlay { LoadingOverlay(isLoaded: data != nil, error: error, retry: load) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editor = .create()
                } label: {
                    Label("Add flip", systemImage: "plus")
                }
                .disabled(data == nil)
            }
        }
        .sheet(item: $editor) { request in
            FlipEditorView(request: request) { saved in replace(saved) }
        }
        .sheet(item: $selling) { flip in
            SellFlipView(flip: flip, feePresets: data?.feePresets ?? .defaults) { saved in replace(saved) }
        }
        .refreshable { await load() }
        .task(id: model.flipsToken) { await load() }
    }

    private var summary: FlipsSummary? {
        data.map { FlipsSummary(flips: $0.flips) }
    }

    @ViewBuilder
    private func summarySection(_ summary: FlipsSummary) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(verbatim: "Revenue \(summary.quarter.title)")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text(verbatim: Format.zl(summary.quarterRevenue))
                        .font(.headline)
                        .monospacedDigit()
                }
                if let limit = summary.quarterLimit, let share = summary.limitShare {
                    ProgressView(value: min(1, share))
                        .tint(share >= 0.8 ? Color.dealOrange : Color.scoutGreen)
                    Text(verbatim: limitMessage(limit: limit, revenue: summary.quarterRevenue, share: share))
                        .font(.caption)
                        .foregroundStyle(share >= 0.8 ? Color.dealOrange : Color.secondary)
                } else {
                    Text("No quarterly limit on record for this year.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            LabeledContent("Net this quarter") {
                Text(verbatim: Format.zl(summary.quarterNet))
                    .monospacedDigit()
                    .foregroundStyle(summary.quarterNet >= 0 ? Color.scoutGreen : Color.red)
            }
            LabeledContent("Net this year", value: Format.zl(summary.yearNet))
            LabeledContent("Unsold", value: "\(summary.openCount) · \(Format.zl(summary.openCost)) tied up")
            let stillListed = (data?.flips ?? []).filter { !$0.stillListedElsewhere.isEmpty }
            ForEach(stillListed) { flip in
                Label {
                    Text(verbatim: "\(flip.title) is sold but still listed on \(flip.stillListedElsewhere.map(\.rawValue).joined(separator: ", ")).")
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.dealOrange)
                }
                .font(.footnote)
            }
        } footer: {
            Text("Działalność nierejestrowana: revenue (full sale prices) in a quarter may not exceed the limit. Above it you have 7 days to register a business.")
        }
    }

    private func limitMessage(limit: Double, revenue: Double, share: Double) -> String {
        if share >= 1 { return "Over the \(Format.zl(limit)) quarterly limit: register a business within 7 days." }
        return "\(Format.zl(limit - revenue)) left of the \(Format.zl(limit)) quarterly limit (\(Int((share * 100).rounded()))% used)."
    }

    private func flipRow(_ flip: Flip) -> some View {
        Button {
            if flip.isSold { selling = flip } else { editor = .edit(flip) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: flip.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(verbatim: "Bought \(flip.boughtOn) · \(flip.buyChannel.rawValue) · \(Format.zl(flip.cost))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let soldOn = flip.soldOn, let price = flip.salePrice {
                        Text(verbatim: "Sold \(soldOn) · \(flip.saleChannel?.rawValue ?? "") · \(Format.zl(price))" + ((flip.saleFee ?? 0) > 0 ? " · fee \(Format.zl(flip.saleFee ?? 0))" : ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if !flip.listedOn.isEmpty {
                        Text(verbatim: "Listed on \(flip.listedOn.map(\.rawValue).joined(separator: ", "))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 6)
                if let net = flip.net {
                    Text(verbatim: Format.zl(net))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(net >= 0 ? Color.scoutGreen : Color.red)
                } else {
                    Text("Unsold")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.scoutBlue)
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                selling = flip
            } label: {
                Label(flip.isSold ? "Edit sale" : "Sold", systemImage: "banknote")
            }
            .tint(.scoutGreen)
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                delete(flip)
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                editor = .edit(flip)
            } label: {
                Label("Edit", systemImage: "pencil")
            }
            if flip.isSold {
                Button {
                    removeSale(flip)
                } label: {
                    Label("Unsell", systemImage: "arrow.uturn.backward")
                }
                .tint(.orange)
            }
        }
    }

    private func replace(_ flip: Flip) {
        guard var current = data else { return }
        if let index = current.flips.firstIndex(where: { $0.id == flip.id }) {
            current.flips[index] = flip
        } else {
            current.flips.insert(flip, at: 0)
        }
        data = current
    }

    private func load() async {
        guard let client = model.client else { return }
        do {
            data = try await client.flips()
            error = nil
        } catch {
            if error.isCancellation { return }
            self.error = error.localizedDescription
        }
    }

    private func delete(_ flip: Flip) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                try await client.deleteFlip(id: flip.id)
                data?.flips.removeAll { $0.id == flip.id }
            } catch {
                model.report(error)
            }
        }
    }

    private func removeSale(_ flip: Flip) {
        guard let client = model.client else { return }
        Task { @MainActor in
            do {
                replace(try await client.removeSale(flipId: flip.id))
            } catch {
                model.report(error)
            }
        }
    }
}

// MARK: - Editing

struct FlipEditorRequest: Identifiable {
    let id = UUID()
    var draft: FlipDraft
    /// `nil` creates a new flip.
    var flipID: Int?

    static func create(_ draft: FlipDraft = FlipDraft()) -> FlipEditorRequest {
        FlipEditorRequest(draft: draft, flipID: nil)
    }

    static func edit(_ flip: Flip) -> FlipEditorRequest {
        FlipEditorRequest(draft: FlipDraft(flip: flip), flipID: flip.id)
    }
}

/// A calendar date field over a `YYYY-MM-DD` string.
private struct CalendarDateField: View {
    var title: String
    @Binding var value: String
    var earliest: String?

    var body: some View {
        if let lower = earliest.flatMap({ Profit.date(from: $0) }) {
            DatePicker(title, selection: binding, in: lower..., displayedComponents: .date)
        } else {
            DatePicker(title, selection: binding, displayedComponents: .date)
        }
    }

    private var binding: Binding<Date> {
        Binding(
            get: { Profit.date(from: value) ?? Date() },
            set: { value = Profit.today($0) }
        )
    }
}

private func amount(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { return 0 }
    guard let value = Double(trimmed.replacingOccurrences(of: ",", with: ".")), value.isFinite, value >= 0 else { return nil }
    return value
}

private func amountText(_ value: Double) -> String {
    value == 0 ? "" : (value.rounded() == value ? String(Int(value)) : String(value))
}

struct FlipEditorView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let request: FlipEditorRequest
    var onSaved: (Flip) -> Void

    @State private var draft: FlipDraft
    @State private var buyPrice: String
    @State private var buyCosts: String
    @State private var saving = false
    @State private var error: String?

    init(request: FlipEditorRequest, onSaved: @escaping (Flip) -> Void) {
        self.request = request
        self.onSaved = onSaved
        _draft = State(initialValue: request.draft)
        _buyPrice = State(initialValue: amountText(request.draft.buyPrice))
        _buyCosts = State(initialValue: amountText(request.draft.buyCosts))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Item") {
                    TextField("e.g. Gigabyte RTX 3070 Eagle", text: $draft.title)
                    CalendarDateField(title: "Bought on", value: $draft.boughtOn, earliest: nil)
                    Picker("Bought from", selection: $draft.buyChannel) {
                        ForEach(FlipChannel.all) { channel in
                            Text(verbatim: channel.rawValue).tag(channel)
                        }
                    }
                }
                Section {
                    TextField("Price paid (zł)", text: $buyPrice)
                        .keyboardType(.decimalPad)
                    TextField("Extra costs (zł)", text: $buyCosts)
                        .keyboardType(.decimalPad)
                } header: {
                    Text("Cost")
                } footer: {
                    Text("Extra costs are shipping in, buyer fees, and repairs.")
                }
                Section {
                    ForEach(FlipChannel.all) { channel in
                        Toggle(isOn: listedBinding(channel)) {
                            Text(verbatim: channel.rawValue)
                        }
                    }
                } header: {
                    Text("Listed for sale on")
                } footer: {
                    Text("Used for the delist checklist when it sells.")
                }
                Section("Note") {
                    TextField("Optional", text: $draft.note, axis: .vertical)
                        .lineLimit(1...4)
                }
                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(Text(verbatim: request.flipID == nil ? "Add flip" : "Edit flip"))
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
                        Button("Save", action: save)
                            .disabled(buyPrice.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    private func listedBinding(_ channel: FlipChannel) -> Binding<Bool> {
        Binding(
            get: { draft.listedOn.contains(channel) },
            set: { enabled in
                draft.listedOn.removeAll { $0 == channel }
                if enabled { draft.listedOn.append(channel) }
            }
        )
    }

    private func save() {
        guard let price = amount(buyPrice), let costs = amount(buyCosts) else {
            error = "Enter prices as numbers of at least zero."
            return
        }
        var body = draft
        body.buyPrice = price
        body.buyCosts = costs
        if let problem = body.validationError {
            error = problem
            return
        }
        guard let client = model.client else { return }
        saving = true
        error = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                let saved: Flip
                if let id = request.flipID {
                    saved = try await client.updateFlip(id: id, draft: body)
                } else {
                    saved = try await client.createFlip(body)
                }
                onSaved(saved)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct SellFlipView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let flip: Flip
    let feePresets: FeePresets
    var onSaved: (Flip) -> Void

    @State private var soldOn: String
    @State private var channel: FlipChannel
    @State private var salePrice: String
    @State private var fee: String
    @State private var saleCosts: String
    @State private var delisted: [FlipChannel]
    @State private var saving = false
    @State private var error: String?

    init(flip: Flip, feePresets: FeePresets, onSaved: @escaping (Flip) -> Void) {
        self.flip = flip
        self.feePresets = feePresets
        self.onSaved = onSaved
        _soldOn = State(initialValue: flip.soldOn ?? Profit.today())
        _channel = State(initialValue: flip.saleChannel ?? flip.listedOn.first ?? .olx)
        _salePrice = State(initialValue: flip.salePrice.map(amountText) ?? "")
        _fee = State(initialValue: flip.saleFee.map { String($0) } ?? "")
        _saleCosts = State(initialValue: amountText(flip.saleCosts ?? 0))
        _delisted = State(initialValue: flip.delisted)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    CalendarDateField(title: "Sold on", value: $soldOn, earliest: flip.boughtOn)
                    Picker("Platform", selection: $channel) {
                        ForEach(FlipChannel.all) { option in
                            Text(verbatim: option.rawValue).tag(option)
                        }
                    }
                    .onChange(of: channel) { fee = "" }
                    TextField("Sale price (zł)", text: $salePrice)
                        .keyboardType(.decimalPad)
                    TextField("Platform fee (zł) · preset \(Format.zl(presetFee))", text: $fee)
                        .keyboardType(.decimalPad)
                    TextField("Your selling costs (zł)", text: $saleCosts)
                        .keyboardType(.decimalPad)
                } header: {
                    Text(verbatim: flip.title)
                } footer: {
                    Text(verbatim: "Leave the fee empty to use the \(channel.rawValue) preset (\(feePresets[channel].percent.formatted())%\(feePresets[channel].fixed > 0 ? " + \(Format.zl(feePresets[channel].fixed))" : "")). The fee is stored with the sale. Selling costs are shipping or packaging you paid.")
                }
                if !otherListings.isEmpty {
                    Section {
                        ForEach(otherListings) { listed in
                            Toggle(isOn: delistedBinding(listed)) {
                                Text(verbatim: "Taken down on \(listed.rawValue)")
                            }
                        }
                    } header: {
                        Text("Delist everywhere else")
                    } footer: {
                        Text("So it can't sell twice.")
                    }
                }
                Section {
                    LabeledContent("Cost", value: Format.zl(flip.cost))
                    LabeledContent("Net profit") {
                        if let net {
                            Text(verbatim: Format.zl(net))
                                .monospacedDigit()
                                .foregroundStyle(net >= 0 ? Color.scoutGreen : Color.red)
                        } else {
                            Text("—")
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
            .navigationTitle(Text(verbatim: flip.isSold ? "Edit sale" : "Mark as sold"))
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
                        Button("Save", action: save)
                            .disabled(sale == nil)
                    }
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    private var otherListings: [FlipChannel] {
        flip.listedOn.filter { $0 != channel }
    }

    private var presetFee: Double {
        Profit.saleFee(salePrice: amount(salePrice) ?? 0, preset: feePresets[channel])
    }

    /// The sale to send; nil while a field is invalid.
    private var sale: FlipSale? {
        guard let price = amount(salePrice), price > 0, let costs = amount(saleCosts) else { return nil }
        let enteredFee: Double?
        if fee.trimmingCharacters(in: .whitespaces).isEmpty {
            enteredFee = nil
        } else {
            guard let value = amount(fee) else { return nil }
            enteredFee = value
        }
        let sale = FlipSale(soldOn: soldOn, saleChannel: channel, salePrice: price, saleFee: enteredFee, saleCosts: costs, delisted: delisted.filter { otherListings.contains($0) })
        return sale.validationError(boughtOn: flip.boughtOn) == nil ? sale : nil
    }

    private var net: Double? {
        guard let sale else { return nil }
        return Profit.net(buyPrice: flip.buyPrice, buyCosts: flip.buyCosts, salePrice: sale.salePrice, saleFee: sale.saleFee ?? presetFee, saleCosts: sale.saleCosts)
    }

    private func delistedBinding(_ listed: FlipChannel) -> Binding<Bool> {
        Binding(
            get: { delisted.contains(listed) },
            set: { done in
                delisted.removeAll { $0 == listed }
                if done { delisted.append(listed) }
            }
        )
    }

    private func save() {
        guard let sale, let client = model.client else { return }
        saving = true
        error = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                onSaved(try await client.recordSale(flipId: flip.id, sale: sale))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - Records and settings

/// Uproszczona ewidencja sprzedaży for one quarter, shareable as CSV.
struct SalesRecordView: View {
    var flips: [Flip]
    @State private var quarter: YearQuarter
    @State private var csvURL: URL?

    init(flips: [Flip]) {
        self.flips = flips
        _quarter = State(initialValue: Profit.quarter(of: Profit.today()) ?? YearQuarter(year: 2026, quarter: 1))
    }

    var body: some View {
        List {
            Section {
                Picker("Quarter", selection: $quarter) {
                    ForEach(quarters) { option in
                        Text(verbatim: option.title).tag(option)
                    }
                }
            } footer: {
                Text("One row per day with sales, with the running total for the quarter. Purchase costs are kept in the ledger, not here.")
            }
            let rows = Profit.salesRecord(flips, quarter: quarter)
            if rows.isEmpty {
                Section {
                    Text(verbatim: "No sales in \(quarter.title).")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach(rows) { row in
                        LabeledContent {
                            Text(verbatim: Format.zl(row.quarterToDate))
                                .monospacedDigit()
                        } label: {
                            Text(verbatim: "\(row.index). \(row.date)")
                            Text(verbatim: "\(Format.zl(row.daySales)) that day")
                        }
                    }
                } header: {
                    Text("Quarter to date")
                }
            }
        }
        .navigationTitle("Sales record")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let csvURL {
                    ShareLink(item: csvURL) {
                        Label("Share CSV", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
        .task(id: quarter) { writeCSV() }
    }

    private var quarters: [YearQuarter] {
        var all = Set(flips.compactMap { $0.soldOn.flatMap(Profit.quarter(of:)) })
        all.insert(quarter)
        if let current = Profit.quarter(of: Profit.today()) { all.insert(current) }
        return all.sorted(by: >)
    }

    private func writeCSV() {
        let rows = Profit.salesRecord(flips, quarter: quarter)
        guard !rows.isEmpty else {
            csvURL = nil
            return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ewidencja-sprzedazy-\(quarter.year)-Q\(quarter.quarter).csv")
        do {
            // BOM so spreadsheet apps read the Polish headers as UTF-8.
            try ("\u{FEFF}" + Profit.salesRecordCSV(rows)).write(to: url, atomically: true, encoding: .utf8)
            csvURL = url
        } catch {
            csvURL = nil
        }
    }
}

struct FeePresetsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var onSaved: (FeePresets) -> Void
    @State private var percent: [FlipChannel: String]
    @State private var fixed: [FlipChannel: String]
    @State private var saving = false
    @State private var error: String?

    init(presets: FeePresets, onSaved: @escaping (FeePresets) -> Void) {
        self.onSaved = onSaved
        _percent = State(initialValue: Dictionary(uniqueKeysWithValues: FlipChannel.all.map { ($0, presets[$0].percent.formatted()) }))
        _fixed = State(initialValue: Dictionary(uniqueKeysWithValues: FlipChannel.all.map { ($0, presets[$0].fixed.formatted()) }))
    }

    var body: some View {
        Form {
            ForEach(FlipChannel.all) { channel in
                Section {
                    LabeledContent("Commission (%)") {
                        TextField("0", text: binding(channel, in: $percent))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Fixed fee (zł)") {
                        TextField("0", text: binding(channel, in: $fixed))
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                } header: {
                    Text(verbatim: channel.rawValue)
                } footer: {
                    Text(verbatim: channel.feeNote)
                }
            }
            Section {
                Button(action: save) {
                    HStack {
                        Text("Save presets")
                        Spacer()
                        if saving { ProgressView() }
                    }
                }
                .disabled(saving || parsed == nil)
            } footer: {
                if let error {
                    Text(verbatim: error).foregroundStyle(.red)
                } else {
                    Text("Private-seller rates as of September 2026; check them against your own account. Recorded sales keep the fee they were saved with.")
                }
            }
        }
        .navigationTitle("Fee presets")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func binding(_ channel: FlipChannel, in values: Binding<[FlipChannel: String]>) -> Binding<String> {
        Binding(
            get: { values.wrappedValue[channel] ?? "" },
            set: { values.wrappedValue[channel] = $0 }
        )
    }

    /// Locale-formatted numbers use a comma; the server wants plain numbers.
    private var parsed: FeePresets? {
        var presets = FeePresets.defaults
        for channel in FlipChannel.all {
            guard let rate = amount((percent[channel] ?? "").replacingOccurrences(of: "\u{00A0}", with: "")), rate <= 50,
                  let flat = amount((fixed[channel] ?? "").replacingOccurrences(of: "\u{00A0}", with: "")), flat <= 1000
            else { return nil }
            presets[channel] = FeePreset(percent: rate, fixed: flat)
        }
        return presets
    }

    private func save() {
        guard let presets = parsed, let client = model.client else { return }
        saving = true
        error = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                onSaved(try await client.saveFeePresets(presets))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
