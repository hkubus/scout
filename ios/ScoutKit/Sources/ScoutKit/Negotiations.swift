import Foundation

// MARK: - Recorded negotiation outcomes

/// How a group of your recorded negotiations went: how many, how many
/// agreed, and the median final price ÷ asking price over the agreed ones.
public struct OutcomeShare: Codable, Hashable, Sendable {
    public var negotiations: Int
    public var agreed: Int
    /// 0–1, to 2 decimals; nil with none agreed.
    public var shareOfAsking: Double?

    public init(negotiations: Int, agreed: Int, shareOfAsking: Double?) {
        self.negotiations = negotiations
        self.agreed = agreed
        self.shareOfAsking = shareOfAsking
    }

    /// The share, but only once the group has `minAgreed` agreed; below it
    /// the screens show the counts.
    public func shownShare(minAgreed: Int) -> Double? {
        agreed >= minAgreed ? shareOfAsking : nil
    }
}

/// One marketplace's figures, in `Marketplace.all` order.
public struct MarketplaceOutcome: Hashable, Sendable, Identifiable {
    public var marketplace: Marketplace
    public var outcome: OutcomeShare
    public var id: String { marketplace.rawValue }
}

/// Keyed by marketplace name, since `[Marketplace: …]` won't decode from a
/// JSON object. Known marketplaces first, then any others by name.
func marketplaceOutcomes(_ marketplaces: [String: OutcomeShare]) -> [MarketplaceOutcome] {
    let known = Marketplace.all.map(\.rawValue)
    let order = known.filter { marketplaces[$0] != nil } + marketplaces.keys.filter { !known.contains($0) }.sorted()
    return order.compactMap { key in marketplaces[key].map { MarketplaceOutcome(marketplace: Marketplace(rawValue: key), outcome: $0) } }
}

/// One watch's recorded negotiations in a role.
public struct WatchOutcomes: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var negotiations: Int
    public var agreed: Int
    public var shareOfAsking: Double?
    public var marketplaces: [String: OutcomeShare]

    public var total: OutcomeShare { OutcomeShare(negotiations: negotiations, agreed: agreed, shareOfAsking: shareOfAsking) }
    public var marketplaceShares: [MarketplaceOutcome] { marketplaceOutcomes(marketplaces) }
}

/// Your recorded negotiations in one role (buying or selling).
public struct RoleOutcomes: Codable, Hashable, Sendable {
    public var negotiations: Int
    public var agreed: Int
    public var shareOfAsking: Double?
    public var marketplaces: [String: OutcomeShare]
    /// Every watch with outcomes, most agreed first; empty on a watch's own figures.
    public var watches: [WatchOutcomes]

    public var total: OutcomeShare { OutcomeShare(negotiations: negotiations, agreed: agreed, shareOfAsking: shareOfAsking) }
    public var marketplaceShares: [MarketplaceOutcome] { marketplaceOutcomes(marketplaces) }
}

/// Your recorded negotiations on the analytics screens: all time, never part
/// of any asking-price figure. Missing on older servers; nil until one is
/// recorded. A role with none is nil.
public struct NegotiationFigures: Codable, Hashable, Sendable {
    public enum Role: String, Hashable, Sendable, CaseIterable {
        case buy, sell
    }

    /// Agreed negotiations a group needs before its share shows.
    public var minAgreed: Int
    public var buy: RoleOutcomes?
    public var sell: RoleOutcomes?

    public struct Entry: Hashable, Sendable, Identifiable {
        public var role: Role
        public var outcomes: RoleOutcomes
        public var id: Role { role }
    }

    /// The roles with outcomes, buying first.
    public var roles: [Entry] {
        Role.allCases.compactMap { role in (role == .buy ? buy : sell).map { Entry(role: role, outcomes: $0) } }
    }
}
