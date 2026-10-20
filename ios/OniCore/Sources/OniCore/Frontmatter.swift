import Foundation

public struct NoteProperty: Equatable, Sendable {
    public var key: String
    public var value: String
}

/// A Note's leading `---` block. Mirrors `assistant/obsidian_tools.py`'s
/// `_read_frontmatter_field` / `_strip_frontmatter` on purpose, so what the
/// phone treats as "written by Oni" (`oni: true`) is exactly what the Mac does.
public enum Frontmatter {
    /// Splits a Note into its frontmatter text (without the `---` fences) and
    /// body. No closing fence means no frontmatter, as on the Mac.
    public static func split(_ text: String) -> (frontmatter: String?, body: String) {
        guard text.hasPrefix("---") else { return (nil, text) }
        let afterOpen = text.index(text.startIndex, offsetBy: 3)
        // .literal: a "\r\n" must not hide the "\n---" inside it.
        guard let close = text.range(of: "\n---", options: .literal, range: afterOpen..<text.endIndex)
        else { return (nil, text) }
        let frontmatter = String(text[afterOpen..<close.lowerBound])
        var body = Substring(text[close.upperBound...])
        // Python: content[end + 4:].lstrip("\n") — skip the rest of the fence line too.
        if let newline = body.firstIndex(where: \.isNewline) {
            body = body[newline...]
        } else {
            body = ""
        }
        return (frontmatter, String(body.drop(while: { $0 == "\n" || $0 == "\r\n" })))
    }

    /// A single unindented scalar field, e.g. `oni: true`.
    public static func field(_ name: String, in text: String) -> String? {
        guard let block = split(text).frontmatter else { return nil }
        for line in block.split(whereSeparator: \.isNewline) where line.hasPrefix(name + ":") {
            let value = line.dropFirst(name.count + 1).trimmingCharacters(in: .whitespaces)
            if !value.isEmpty { return value }
        }
        return nil
    }

    public static func isOniAuthored(_ text: String) -> Bool {
        field("oni", in: text)?.lowercased() == "true"
    }

    /// Scalar `key: value` lines, for showing a Note's properties.
    public static func properties(in text: String) -> [NoteProperty] {
        guard let block = split(text).frontmatter else { return [] }
        var out: [NoteProperty] = []
        for line in block.split(whereSeparator: \.isNewline) {
            guard let first = line.first, first.isLetter || first.isNumber || first == "_",
                  let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon])
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if !value.isEmpty { out.append(NoteProperty(key: key, value: value)) }
        }
        return out
    }
}
