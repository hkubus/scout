import Foundation

/// Parses the timestamp shapes the server emits: ISO 8601 with or without
/// fractional seconds, SQLite `YYYY-MM-DD HH:MM:SS` (UTC), and analytics
/// calendar days (`YYYY-MM-DD`, interpreted in the device's time zone).
public enum ScoutDate {
    public static func parse(_ value: String?) -> Date? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if value.count == 10 { return day(value) }
        if let date = fractional().date(from: value) ?? plain().date(from: value) { return date }
        if value.count == 19, value.dropFirst(10).first == " " {
            return plain().date(from: value.replacingOccurrences(of: " ", with: "T") + "Z")
        }
        return nil
    }

    private static func fractional() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }

    private static func plain() -> ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }

    private static func day(_ value: String) -> Date? {
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
