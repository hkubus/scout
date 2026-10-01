import Foundation

/// The editable fields of a watch, used both to create one (`POST
/// /api/watches`) and to update one (`PATCH /api/watches/:id`). Advanced
/// settings (model variants, exact URLs, per-marketplace intervals, research
/// baselines) are left to the web app; a PATCH without them leaves them as is.
public struct WatchDraft: Hashable, Sendable {
    public static let conditions = ["Any", "New", "Like new", "Very good", "Good"]
    public static let sensitivities: [(label: String, value: Double)] = [("Conservative", 0.8), ("Balanced", 1), ("Sensitive", 1.3)]

    public var name: String
    public var query: String
    public var terms: String
    public var excluded: String
    public var sources: [Marketplace]
    public var location: String
    public var condition: String
    /// Minutes between scans, 5–1440.
    public var interval: Int
    public var minPrice: Double?
    public var maxPrice: Double?
    public var shippingOnly: Bool
    public var typoVariants: Bool
    public var aiRelevance: Bool
    /// 0.6–1.6; higher flags smaller discounts.
    public var sensitivity: Double
    /// OLX scans only search this category; nil searches all of OLX.
    public var olxCategory: OlxCategory?
    /// Only learn from and alert on this seller type; nil is any seller.
    public var sellerType: SellerType?
    /// Skip paid placements and highlights.
    public var ignorePromoted: Bool

    public init(
        name: String = "",
        query: String = "",
        terms: String = "",
        excluded: String = "",
        sources: [Marketplace] = Marketplace.all,
        location: String = "Polska",
        condition: String = "Any",
        interval: Int = 5,
        minPrice: Double? = nil,
        maxPrice: Double? = nil,
        shippingOnly: Bool = false,
        typoVariants: Bool = false,
        aiRelevance: Bool = true,
        sensitivity: Double = 1,
        olxCategory: OlxCategory? = nil,
        sellerType: SellerType? = nil,
        ignorePromoted: Bool = false
    ) {
        self.name = name
        self.query = query
        self.terms = terms
        self.excluded = excluded
        self.sources = sources
        self.location = location
        self.condition = condition
        self.interval = interval
        self.minPrice = minPrice
        self.maxPrice = maxPrice
        self.shippingOnly = shippingOnly
        self.typoVariants = typoVariants
        self.aiRelevance = aiRelevance
        self.sensitivity = sensitivity
        self.olxCategory = olxCategory
        self.sellerType = sellerType
        self.ignorePromoted = ignorePromoted
    }

    public init(watch: Watch) {
        self.init(
            name: watch.name,
            query: watch.query,
            terms: watch.terms,
            excluded: watch.excluded,
            sources: watch.sources,
            location: watch.location,
            condition: watch.condition,
            interval: Int(watch.interval),
            minPrice: watch.minPrice,
            maxPrice: watch.maxPrice,
            shippingOnly: watch.shippingOnly,
            typoVariants: watch.typoVariants,
            aiRelevance: watch.aiRelevance,
            sensitivity: watch.sensitivity,
            olxCategory: watch.olxCategory,
            sellerType: watch.sellerType.flatMap(SellerType.init(rawValue:)),
            ignorePromoted: watch.ignorePromoted ?? false
        )
    }

    /// "Save as watch" from a manual search, as on the web Search page.
    public init(search: SearchFilters) {
        let query = search.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let location = search.location.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(
            name: query.isEmpty ? "" : "\(query) watch",
            query: query,
            terms: search.terms.trimmingCharacters(in: .whitespacesAndNewlines),
            excluded: search.excluded.trimmingCharacters(in: .whitespacesAndNewlines),
            sources: search.sources,
            location: location.isEmpty ? "Polska" : location,
            condition: search.condition.rawValue,
            minPrice: search.minPrice,
            maxPrice: search.maxPrice,
            shippingOnly: search.shippingOnly,
            aiRelevance: search.aiRelevance,
            olxCategory: search.sources.contains(.olx) ? search.olxCategory : nil,
            sellerType: search.ownerType
        )
    }

    /// Prefill from a stored listing: a cleaned-up title as the query, its
    /// marketplace, and a ±25% price band (`watchPresetFromListing` on the web).
    public init(listing: Listing) {
        let query = Self.titleQuery(from: listing.title)
        let price = listing.price.isFinite && listing.price > 0 ? listing.price : nil
        let location = listing.location?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.init(
            name: query.isEmpty ? "" : "\(query) watch",
            query: query,
            sources: [listing.marketplace],
            location: location.isEmpty ? "Polska" : location,
            minPrice: price.map { max(0, Self.roundTo5($0 * 0.75)) },
            maxPrice: price.map { Self.roundTo5($0 * 1.25) },
            shippingOnly: listing.shippingAvailable == true
        )
    }

    /// Why the server would reject this draft, if it would.
    /// The name is optional: an empty one becomes the query (see `normalized`).
    public var validationError: String? {
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Enter what Scout should search for." }
        if sources.isEmpty { return "Pick at least one marketplace." }
        if !(5...1440).contains(interval) { return "The scan interval must be between 5 and 1440 minutes." }
        if let minPrice, minPrice < 0 { return "The minimum price can't be negative." }
        if let maxPrice, maxPrice <= 0 { return "The maximum price must be above zero." }
        if let minPrice, let maxPrice, minPrice > maxPrice { return "The minimum price can't exceed the maximum." }
        return nil
    }

    func normalized() -> WatchDraft {
        var copy = self
        copy.query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(240))
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.name = String((name.isEmpty ? copy.query : name).prefix(120))
        copy.terms = terms.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.excluded = excluded.trimmingCharacters(in: .whitespacesAndNewlines)
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.location = place.isEmpty ? "Polska" : place
        copy.sensitivity = min(1.6, max(0.6, sensitivity))
        // Kept only while OLX is a source, like the web editor.
        if !sources.contains(.olx) { copy.olxCategory = nil }
        return copy
    }

    // MARK: Title cleanup

    private static let locationTokens: Set<String> = [
        "białystok", "bialystok", "bydgoszcz", "bytom", "częstochowa", "czestochowa",
        "elbląg", "elblag", "gdańsk", "gdansk", "gdynia", "gliwice", "katowice", "kielce",
        "koszalin", "kraków", "krakow", "legnica", "lublin", "łódź", "lodz", "olsztyn",
        "opole", "płock", "plock", "poznań", "poznan", "radom", "rzeszów", "rzeszow",
        "sosnowiec", "szczecin", "słupsk", "slupsk", "sopot", "tarnów", "tarnow",
        "toruń", "torun", "warszawa", "wrocław", "wroclaw", "zabrze", "zielona góra", "zielona gora",
    ]
    private static let stopwords: Set<String> = ["sprzedam", "okazja", "promocja", "tanio", "tania", "tani", "cena"]
    // Built once; the pattern is a constant, so construction cannot fail.
    private static let priceToken = try! NSRegularExpression(
        pattern: #"\b\d{1,3}(?:[  ]\d{3})*(?:[.,]\d{1,2})?\s*(?:zł|zl|pln)\b\.?"#,
        options: [.caseInsensitive]
    )

    /// Drops prices, Polish sale words, and city names from a listing title.
    public static func titleQuery(from title: String) -> String {
        let range = NSRange(title.startIndex..., in: title)
        let withoutPrices = priceToken.stringByReplacingMatches(in: title, range: range, withTemplate: " ")
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "·•|,;"))
        let tokens = withoutPrices.components(separatedBy: separators).filter { token in
            guard token.unicodeScalars.contains(where: { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) }) else { return false }
            var lowered = token.lowercased()
            while lowered.hasSuffix(".") { lowered.removeLast() }
            return !stopwords.contains(lowered) && !locationTokens.contains(lowered)
        }
        return String(tokens.joined(separator: " ").prefix(120)).trimmingCharacters(in: .whitespaces)
    }

    private static func roundTo5(_ value: Double) -> Double {
        (value / 5).rounded() * 5
    }
}

extension WatchDraft: Encodable {
    private enum CodingKeys: String, CodingKey {
        case name, query, terms, excluded, sources, location, condition, interval
        case minPrice, maxPrice, shippingOnly, typoVariants, aiRelevance, sensitivity
        case olxCategory, sellerType, ignorePromoted
    }

    // Prices are always sent, as null when empty, so an edit can clear them.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(query, forKey: .query)
        try container.encode(terms, forKey: .terms)
        try container.encode(excluded, forKey: .excluded)
        try container.encode(sources, forKey: .sources)
        try container.encode(location, forKey: .location)
        try container.encode(condition, forKey: .condition)
        try container.encode(interval, forKey: .interval)
        try container.encode(minPrice, forKey: .minPrice)
        try container.encode(maxPrice, forKey: .maxPrice)
        try container.encode(shippingOnly, forKey: .shippingOnly)
        try container.encode(typoVariants, forKey: .typoVariants)
        try container.encode(aiRelevance, forKey: .aiRelevance)
        try container.encode(sensitivity, forKey: .sensitivity)
        // Sent as null when unset, so an edit can clear them.
        try container.encode(olxCategory, forKey: .olxCategory)
        try container.encode(sellerType, forKey: .sellerType)
        try container.encode(ignorePromoted, forKey: .ignorePromoted)
    }
}

extension WatchDraft: Decodable {
    /// Decodes a create or update body; absent fields keep their defaults.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init()
        name = try container.decodeIfPresent(String.self, forKey: .name) ?? name
        query = try container.decodeIfPresent(String.self, forKey: .query) ?? query
        terms = try container.decodeIfPresent(String.self, forKey: .terms) ?? terms
        excluded = try container.decodeIfPresent(String.self, forKey: .excluded) ?? excluded
        sources = try container.decodeIfPresent([Marketplace].self, forKey: .sources) ?? sources
        location = try container.decodeIfPresent(String.self, forKey: .location) ?? location
        condition = try container.decodeIfPresent(String.self, forKey: .condition) ?? condition
        interval = try container.decodeIfPresent(Int.self, forKey: .interval) ?? interval
        minPrice = try container.decodeIfPresent(Double.self, forKey: .minPrice)
        maxPrice = try container.decodeIfPresent(Double.self, forKey: .maxPrice)
        shippingOnly = try container.decodeIfPresent(Bool.self, forKey: .shippingOnly) ?? shippingOnly
        typoVariants = try container.decodeIfPresent(Bool.self, forKey: .typoVariants) ?? typoVariants
        aiRelevance = try container.decodeIfPresent(Bool.self, forKey: .aiRelevance) ?? aiRelevance
        sensitivity = try container.decodeIfPresent(Double.self, forKey: .sensitivity) ?? sensitivity
        olxCategory = try container.decodeIfPresent(OlxCategory.self, forKey: .olxCategory)
        sellerType = try container.decodeIfPresent(SellerType.self, forKey: .sellerType)
        ignorePromoted = try container.decodeIfPresent(Bool.self, forKey: .ignorePromoted) ?? ignorePromoted
    }
}
