import Foundation

/// The local, per-surface data model a generative-UI surface's inputs read from
/// and write to. Seeded once from the surface's own `dataModel`; nothing leaves
/// the phone until a `Button` reports (PLAN.md Phase 31 D5), and then the
/// whole model goes back as the button's `context`, exactly as the dashboard's
/// `A2UIRenderer.tsx` does, so a form behaves the same on both.
public struct A2UIFormState: Sendable, Equatable {
    public private(set) var data: [String: JSONValue]

    public init(_ surface: A2UISurface) { data = surface.dataModel }
    init(data: [String: JSONValue]) { self.data = data }

    /// What a pressed `Button` reports back.
    public var context: [String: JSONValue] { data }

    // MARK: reading (a literal, or a `{"path": ...}` binding into `data`)

    /// The path an input is bound to; nil for a literal (such an input is read-only).
    public func path(_ value: JSONValue?) -> String? { value?.pathBinding }

    /// A string as the person should read it. A bound number or boolean reads
    /// as its text; a missing or wrongly-typed binding reads as empty, never as
    /// a dump of the JSON.
    public func string(_ value: JSONValue?) -> String {
        guard let value else { return "" }
        if let s = value.string { return s }
        guard let path = value.pathBinding, let bound = data[path] else { return "" }
        switch bound {
        case .string(let s): return s
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return Self.text(of: n)
        default: return ""
        }
    }

    public func number(_ value: JSONValue?, fallback: Double = 0) -> Double {
        if let n = value?.double { return n }
        if let path = value?.pathBinding, let n = data[path]?.double { return n }
        return fallback
    }

    public func bool(_ value: JSONValue?) -> Bool {
        if let b = value?.bool { return b }
        if let path = value?.pathBinding, let b = data[path]?.bool { return b }
        return false
    }

    public func stringList(_ value: JSONValue?) -> [String] {
        if case .array(let items)? = value { return items.compactMap(\.string) }
        if let path = value?.pathBinding, case .array(let items)? = data[path] { return items.compactMap(\.string) }
        return []
    }

    /// An `Icon`'s name, only if it is one of the fixed set.
    public func iconName(_ value: JSONValue?) -> String? {
        let name = string(value)
        return A2UISurface.iconNames.contains(name) ? name : nil
    }

    // MARK: writing (only into a bound path; a literal has nowhere to write)

    public mutating func set(_ path: String?, string: String) { if let path { data[path] = .string(string) } }
    public mutating func set(_ path: String?, bool: Bool) { if let path { data[path] = .bool(bool) } }
    public mutating func set(_ path: String?, number: Double) { if let path { data[path] = .number(number) } }

    /// A `ChoicePicker` choice: multiple selection toggles, mutually exclusive
    /// replaces. Selection is always a list of the options' own `value`s.
    public mutating func choose(_ path: String?, value: String, multiple: Bool) {
        guard let path else { return }
        var selected: [String] = []
        if case .array(let items)? = data[path] { selected = items.compactMap(\.string) }
        if multiple {
            if let index = selected.firstIndex(of: value) { selected.remove(at: index) } else { selected.append(value) }
        } else {
            selected = [value]
        }
        data[path] = .array(selected.map(JSONValue.string))
    }

    public static func text(of n: Double) -> String {
        n.rounded() == n && abs(n) < 9e15 ? String(Int(n)) : String(n)
    }
}

/// An `Image`'s source: a base64 `data:` URI, decoded locally. The phone never
/// fetches a URL a surface names (the parser already rejects them).
public enum A2UIMedia {
    public static func decode(_ uri: String) -> (mimeType: String, data: Data)? {
        guard uri.hasPrefix("data:"), let comma = uri.firstIndex(of: ",") else { return nil }
        let header = uri[uri.index(uri.startIndex, offsetBy: 5)..<comma]
        let parts = header.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        guard parts.last == "base64", let mime = parts.first, mime.contains("/") else { return nil }
        guard let data = Data(base64Encoded: String(uri[uri.index(after: comma)...]), options: .ignoreUnknownCharacters),
              !data.isEmpty else { return nil }
        return (mime, data)
    }
}

/// `DateTimeInput` values. The dashboard's inputs write browser-style strings
/// (`2026-10-21`, `14:30`, `2026-10-21T14:30`), while a surface may arrive with
/// a full ISO 8601 stamp, so reading accepts both and writing uses the
/// browser-style shape that matches what the field shows.
public enum A2UIDateTime {
    public struct Parts: Sendable, Equatable {
        public var date: Bool
        public var time: Bool
        public init(date: Bool, time: Bool) { self.date = date; self.time = time }
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = format
        return f
    }

    public static func parse(_ text: String) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: trimmed) { return d }
        iso.formatOptions = [.withInternetDateTime]
        if let d = iso.date(from: trimmed) { return d }
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd", "HH:mm:ss", "HH:mm"] {
            if let d = formatter(format).date(from: trimmed) { return d }
        }
        return nil
    }

    public static func format(_ date: Date, parts: Parts) -> String {
        switch (parts.date, parts.time) {
        case (true, true): formatter("yyyy-MM-dd'T'HH:mm").string(from: date)
        case (false, true): formatter("HH:mm").string(from: date)
        default: formatter("yyyy-MM-dd").string(from: date)
        }
    }

    /// Which pickers a field shows: both, time only, or (the default) date only.
    public static func parts(enableDate: Bool, enableTime: Bool) -> Parts {
        Parts(date: enableDate || !enableTime, time: enableTime)
    }
}
