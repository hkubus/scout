import Foundation

// The flip ledger (`/api/flips`); mirrors `src/profit.ts` and the `Flip`
// types in `src/types.ts`. This is the operator's private bookkeeping: it is
// display-only and never feeds Scout's market statistics or alerts.

/// Where an item was bought or sold. Open like `Marketplace`, so a channel a
/// newer server adds never breaks decoding.
public struct FlipChannel: RawRepresentable, Codable, Hashable, Sendable, Identifiable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public var id: String { rawValue }

    public static let olx = FlipChannel(rawValue: "OLX")
    public static let allegroLokalnie = FlipChannel(rawValue: "Allegro Lokalnie")
    public static let vinted = FlipChannel(rawValue: "Vinted")
    public static let other = FlipChannel(rawValue: "Other")
    public static let all: [FlipChannel] = [.olx, .allegroLokalnie, .vinted, .other]
    /// The platforms DAC7 counts are shown for.
    public static let platforms: [FlipChannel] = [.olx, .allegroLokalnie, .vinted]

    public init(_ marketplace: Marketplace) {
        self.init(rawValue: marketplace.rawValue)
    }

    /// Default seller fee as of 2026-09, explained for the fee settings.
    public var feeNote: String {
        switch self {
        case .olx: "Standard listing with OLX Przesyłka: no seller fee. If you use “Zapłać, jeśli sprzedasz”, enter its rate (about 6–10% in Elektronika)."
        case .allegroLokalnie: "Kup teraz or auction in Elektronika: 4,9% (7,9% in other categories). Free local listings: 0%."
        case .vinted: "No seller fee; the buyer pays buyer protection."
        default: "Anything else, e.g. a sale in person."
        }
    }
}

public struct FeePreset: Codable, Hashable, Sendable {
    /// Seller commission as a percentage of the sale price.
    public var percent: Double
    /// Fixed seller fee per sale, in PLN.
    public var fixed: Double

    public init(percent: Double, fixed: Double) {
        self.percent = percent
        self.fixed = fixed
    }
}

/// Seller fee presets keyed by channel, as `GET /api/flips` sends them.
public struct FeePresets: Hashable, Sendable {
    public var byChannel: [FlipChannel: FeePreset]

    public init(_ byChannel: [FlipChannel: FeePreset]) {
        self.byChannel = byChannel
    }

    /// Private-seller defaults as of 2026-09 (see `src/profit.ts`).
    public static let defaults = FeePresets([
        .olx: FeePreset(percent: 0, fixed: 0),
        .allegroLokalnie: FeePreset(percent: 4.9, fixed: 0),
        .vinted: FeePreset(percent: 0, fixed: 0),
        .other: FeePreset(percent: 0, fixed: 0),
    ])

    public subscript(channel: FlipChannel) -> FeePreset {
        get { byChannel[channel] ?? Self.defaults.byChannel[channel] ?? FeePreset(percent: 0, fixed: 0) }
        set { byChannel[channel] = newValue }
    }
}

extension FeePresets: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode([String: FeePreset].self)
        var byChannel = Self.defaults.byChannel
        for (key, value) in raw { byChannel[FlipChannel(rawValue: key)] = value }
        self.init(byChannel)
    }

    /// The server's PUT accepts exactly the four known channels.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(Dictionary(uniqueKeysWithValues: FlipChannel.all.map { ($0.rawValue, self[$0]) }))
    }
}

public struct Flip: Codable, Hashable, Sendable, Identifiable {
    public var id: Int
    public var title: String
    /// `Marketplace:listingId` of the listing it was bought from, when known.
    public var listingKey: String?
    public var watchId: String?
    public var buyChannel: FlipChannel
    /// `YYYY-MM-DD`.
    public var boughtOn: String
    public var buyPrice: Double
    /// Shipping in, buyer fees, repairs.
    public var buyCosts: Double
    /// Where it is listed for sale; drives the delist checklist.
    public var listedOn: [FlipChannel]
    public var soldOn: String?
    public var saleChannel: FlipChannel?
    public var salePrice: Double?
    /// Fixed when the sale was recorded, so later preset edits don't change it.
    public var saleFee: Double?
    /// Shipping or packaging the seller paid.
    public var saleCosts: Double?
    /// Channels already taken down after the sale.
    public var delisted: [FlipChannel]
    public var note: String
    public var createdAt: String
    public var updatedAt: String

    public var isSold: Bool { soldOn != nil && salePrice != nil }
    public var cost: Double { Profit.cost(buyPrice: buyPrice, buyCosts: buyCosts) }
    /// Realised net profit, or nil while unsold.
    public var net: Double? {
        Profit.net(buyPrice: buyPrice, buyCosts: buyCosts, salePrice: salePrice, saleFee: saleFee, saleCosts: saleCosts)
    }

    /// Other platforms it is still listed on after the sale.
    public var stillListedElsewhere: [FlipChannel] {
        guard isSold else { return [] }
        return listedOn.filter { $0 != saleChannel && !delisted.contains($0) }
    }
}

public struct FlipsData: Codable, Hashable, Sendable {
    public var flips: [Flip]
    public var feePresets: FeePresets
}

/// Body of `POST /api/flips` and the buy side of an edit.
public struct FlipDraft: Codable, Hashable, Sendable {
    public var title: String
    public var listingKey: String?
    public var watchId: String?
    public var buyChannel: FlipChannel
    public var boughtOn: String
    public var buyPrice: Double
    public var buyCosts: Double
    public var listedOn: [FlipChannel]
    public var note: String

    public init(
        title: String = "",
        listingKey: String? = nil,
        watchId: String? = nil,
        buyChannel: FlipChannel = .olx,
        boughtOn: String = Profit.today(),
        buyPrice: Double = 0,
        buyCosts: Double = 0,
        listedOn: [FlipChannel] = [],
        note: String = ""
    ) {
        self.title = title
        self.listingKey = listingKey
        self.watchId = watchId
        self.buyChannel = buyChannel
        self.boughtOn = boughtOn
        self.buyPrice = buyPrice
        self.buyCosts = buyCosts
        self.listedOn = listedOn
        self.note = note
    }

    public init(flip: Flip) {
        self.init(title: flip.title, listingKey: flip.listingKey, watchId: flip.watchId, buyChannel: flip.buyChannel, boughtOn: flip.boughtOn, buyPrice: flip.buyPrice, buyCosts: flip.buyCosts, listedOn: flip.listedOn, note: flip.note)
    }

    /// "I bought this" from a listing: its title, platform and price, today.
    public init(listing: Listing, extraCosts: Double = 0) {
        self.init(
            title: String(listing.title.prefix(200)),
            listingKey: listing.key,
            watchId: listing.watchId,
            buyChannel: FlipChannel(listing.marketplace),
            buyPrice: listing.price,
            buyCosts: extraCosts
        )
    }

    public var validationError: String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Name the item." }
        if !Profit.isDate(boughtOn) { return "Enter the purchase date." }
        if !buyPrice.isFinite || buyPrice < 0 || !buyCosts.isFinite || buyCosts < 0 { return "Prices can't be negative." }
        return nil
    }

    func normalized() -> FlipDraft {
        var copy = self
        copy.title = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        copy.note = String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))
        var seen = Set<FlipChannel>()
        copy.listedOn = listedOn.filter { seen.insert($0).inserted }
        return copy
    }
}

/// Body of `PATCH /api/flips/:id` with only the fields to change.
public struct FlipSale: Hashable, Sendable {
    public var soldOn: String
    public var saleChannel: FlipChannel
    public var salePrice: Double
    /// nil lets the server apply the channel's preset.
    public var saleFee: Double?
    public var saleCosts: Double
    public var delisted: [FlipChannel]

    public init(soldOn: String = Profit.today(), saleChannel: FlipChannel, salePrice: Double, saleFee: Double? = nil, saleCosts: Double = 0, delisted: [FlipChannel] = []) {
        self.soldOn = soldOn
        self.saleChannel = saleChannel
        self.salePrice = salePrice
        self.saleFee = saleFee
        self.saleCosts = saleCosts
        self.delisted = delisted
    }

    public func validationError(boughtOn: String) -> String? {
        if !Profit.isDate(soldOn) { return "Enter the sale date." }
        if soldOn < boughtOn { return "The sale date can't be before the purchase date." }
        if !salePrice.isFinite || salePrice <= 0 { return "Enter the sale price." }
        if let saleFee, !saleFee.isFinite || saleFee < 0 { return "The fee can't be negative." }
        if !saleCosts.isFinite || saleCosts < 0 { return "Costs can't be negative." }
        return nil
    }
}

struct FlipSaleBody: Encodable {
    var sale: FlipSale

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sale.soldOn, forKey: .soldOn)
        try container.encode(sale.saleChannel, forKey: .saleChannel)
        try container.encode(sale.salePrice, forKey: .salePrice)
        // Omitted rather than null: the server then fixes the preset fee.
        try container.encodeIfPresent(sale.saleFee, forKey: .saleFee)
        try container.encode(sale.saleCosts, forKey: .saleCosts)
        try container.encode(sale.delisted, forKey: .delisted)
    }

    private enum CodingKeys: String, CodingKey { case soldOn, saleChannel, salePrice, saleFee, saleCosts, delisted }
}

/// `{"soldOn": null}` removes a recorded sale.
struct FlipUnsellBody: Encodable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeNil(forKey: .soldOn)
    }

    private enum CodingKeys: String, CodingKey { case soldOn }
}

// MARK: - Maths

public struct SalesRecordRow: Hashable, Sendable, Identifiable {
    public var index: Int
    public var date: String
    public var daySales: Double
    /// Running total since the start of the quarter.
    public var quarterToDate: Double
    public var id: String { date }
}

public struct YearQuarter: Hashable, Sendable, Comparable, Identifiable {
    public var year: Int
    public var quarter: Int
    public var id: String { "\(year)-Q\(quarter)" }
    public var title: String { "Q\(quarter) \(year)" }

    public init(year: Int, quarter: Int) {
        self.year = year
        self.quarter = quarter
    }

    public static func < (lhs: YearQuarter, rhs: YearQuarter) -> Bool {
        (lhs.year, lhs.quarter) < (rhs.year, rhs.quarter)
    }
}

/// Flip maths, identical to `src/profit.ts`. Forward-only and display-only.
public enum Profit {
    /// Działalność nierejestrowana: quarterly revenue limit (225% of the
    /// minimum wage). The quarterly rule starts in 2026.
    public static let unregisteredQuarterlyLimits: [Int: Double] = [2026: 10_813.5]
    /// DAC7: a platform reports a seller after 30 sales or 2 000 € a year.
    public static let dac7Sales = 30
    public static let dac7Euro = 2_000

    static func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }

    public static func saleFee(salePrice: Double, preset: FeePreset) -> Double {
        guard salePrice.isFinite, salePrice > 0 else { return 0 }
        return round2(salePrice * preset.percent / 100 + preset.fixed)
    }

    public static func cost(buyPrice: Double, buyCosts: Double) -> Double {
        round2(buyPrice + buyCosts)
    }

    public static func net(buyPrice: Double, buyCosts: Double, salePrice: Double?, saleFee: Double?, saleCosts: Double?) -> Double? {
        guard let salePrice else { return nil }
        return round2(salePrice - (saleFee ?? 0) - (saleCosts ?? 0) - cost(buyPrice: buyPrice, buyCosts: buyCosts))
    }

    /// What reselling at `resalePrice` on a channel would net after its fee.
    public static func estimate(buyPrice: Double, buyCosts: Double, resalePrice: Double, preset: FeePreset, saleCosts: Double = 0) -> (fee: Double, net: Double) {
        let fee = saleFee(salePrice: resalePrice, preset: preset)
        return (fee, round2(resalePrice - fee - saleCosts - buyPrice - buyCosts))
    }

    public static func quarter(of date: String) -> YearQuarter? {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, (1...12).contains(parts[1]) else { return nil }
        return YearQuarter(year: parts[0], quarter: (parts[1] - 1) / 3 + 1)
    }

    /// Uproszczona ewidencja sprzedaży for one quarter: one row per day with
    /// sales and the running total in the quarter.
    public static func salesRecord(_ flips: [Flip], quarter: YearQuarter) -> [SalesRecordRow] {
        var byDay: [String: Double] = [:]
        for flip in flips {
            guard let soldOn = flip.soldOn, let price = flip.salePrice, Self.quarter(of: soldOn) == quarter else { continue }
            byDay[soldOn] = round2((byDay[soldOn] ?? 0) + price)
        }
        var running = 0.0
        return byDay.keys.sorted().enumerated().map { offset, date in
            running = round2(running + byDay[date]!)
            return SalesRecordRow(index: offset + 1, date: date, daySales: byDay[date]!, quarterToDate: running)
        }
    }

    public static func salesRecordCSV(_ rows: [SalesRecordRow]) -> String {
        func pln(_ value: Double) -> String { String(format: "%.2f", value).replacingOccurrences(of: ".", with: ",") }
        let header = "Lp.;Data sprzedaży;Wartość sprzedaży danego dnia (zł);Wartość sprzedaży narastająco w kwartale (zł)"
        return ([header] + rows.map { "\($0.index);\($0.date);\(pln($0.daySales));\(pln($0.quarterToDate))" }).joined(separator: "\r\n")
    }

    /// Today as a calendar date in the device's time zone.
    public static func today(_ now: Date = Date(), calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    public static func date(from value: String, calendar: Calendar = .current) -> Date? {
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    public static func isDate(_ value: String) -> Bool {
        value.range(of: #"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"#, options: .regularExpression) != nil
    }
}

/// Figures for the Flips summary, computed like the web page.
public struct FlipsSummary: Hashable, Sendable {
    public struct Platform: Hashable, Sendable {
        public var channel: FlipChannel
        public var sales: Int
        public var revenue: Double
    }

    public var quarter: YearQuarter
    public var quarterRevenue: Double
    public var quarterLimit: Double?
    public var quarterNet: Double
    public var yearNet: Double
    public var yearSales: Int
    public var openCount: Int
    public var openCost: Double
    public var platforms: [Platform]

    public init(flips: [Flip], today: String = Profit.today()) {
        let quarter = Profit.quarter(of: today) ?? YearQuarter(year: 1970, quarter: 1)
        let sold = flips.filter(\.isSold)
        let inYear = sold.filter { Profit.quarter(of: $0.soldOn!)?.year == quarter.year }
        let inQuarter = inYear.filter { Profit.quarter(of: $0.soldOn!) == quarter }
        let open = flips.filter { !$0.isSold }
        self.quarter = quarter
        quarterRevenue = Profit.round2(inQuarter.reduce(0) { $0 + ($1.salePrice ?? 0) })
        quarterLimit = Profit.unregisteredQuarterlyLimits[quarter.year]
        quarterNet = Profit.round2(inQuarter.reduce(0) { $0 + ($1.net ?? 0) })
        yearNet = Profit.round2(inYear.reduce(0) { $0 + ($1.net ?? 0) })
        yearSales = inYear.count
        openCount = open.count
        openCost = Profit.round2(open.reduce(0) { $0 + $1.cost })
        platforms = FlipChannel.platforms.map { channel in
            let sales = inYear.filter { $0.saleChannel == channel }
            return Platform(channel: channel, sales: sales.count, revenue: Profit.round2(sales.reduce(0) { $0 + ($1.salePrice ?? 0) }))
        }
    }

    /// Share of the quarterly limit used, when a limit applies to the year.
    public var limitShare: Double? { quarterLimit.map { quarterRevenue / $0 } }
}
