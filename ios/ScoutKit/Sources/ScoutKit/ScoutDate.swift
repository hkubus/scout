import Foundation

/// Parses the timestamp shapes the server emits: ISO 8601 with or without
/// fractional seconds, SQLite `YYYY-MM-DD HH:MM:SS` (UTC), and analytics
/// calendar days (`YYYY-MM-DD`, interpreted in the device's time zone).
public enum ScoutDate {
    // Format styles are Sendable value types, so one shared copy of each is
    // safe from any thread and saves building a formatter on every parse.
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    public static func parse(_ value: String?) -> Date? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if value.count == 10 { return day(value) }
        if let date = (try? fractional.parse(value)) ?? (try? plain.parse(value)) { return date }
        if value.count == 19, value.dropFirst(10).first == " " {
            return try? plain.parse(value.replacingOccurrences(of: " ", with: "T") + "Z")
        }
        return nil
    }

    private static func day(_ value: String) -> Date? {
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
