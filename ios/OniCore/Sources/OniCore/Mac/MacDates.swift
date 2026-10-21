import Foundation

/// The Mac stamps threads with Python's `datetime.isoformat()`:
/// `2026-10-21T06:43:50.038181+00:00` (microseconds, numeric offset), with the
/// fraction missing when it happens to be zero.
public enum MacDates {
    public static func parse(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: text) { return date }
        // Six fractional digits are more than the formatter takes on some OS versions.
        if let dot = text.firstIndex(of: "."), let end = text[dot...].firstIndex(where: { "+-Z".contains($0) }) {
            let trimmed = String(text[..<dot]) + String(text[end...])
            return plain.date(from: trimmed)
        }
        return nil
    }
}
