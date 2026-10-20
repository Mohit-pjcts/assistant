import Foundation

/// Obsidian `[[wikilinks]]`. The Markdown parser doesn't know them, so they
/// are rewritten into ordinary links to an `oni-note:` URL before parsing; the
/// app then recognises that scheme when a link is tapped.
public enum WikiLinks {
    public static let scheme = "oni-note"

    /// `[[Target]]`, `[[Target|Alias]]`, `[[Target#Heading]]`, `![[Embed]]`.
    /// (Inside a table Obsidian writes the alias separator as `\|`.)
    private static let pattern = try! NSRegularExpression(pattern: #"(!?)\[\[([^\[\]\n]+?)\]\]"#)

    public struct Parsed: Equatable, Sendable {
        public var target: String
        public var heading: String?
        public var display: String
    }

    static func parseInner(_ inner: String) -> Parsed {
        var left = inner
        var alias: String?
        for separator in ["\\|", "|"] {
            if let r = left.range(of: separator) {
                alias = String(left[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                left = String(left[..<r.lowerBound])
                break
            }
        }
        var heading: String?
        if let hash = left.firstIndex(of: "#") {
            heading = String(left[left.index(after: hash)...]).trimmingCharacters(in: .whitespaces)
            left = String(left[..<hash])
        }
        let target = left.trimmingCharacters(in: .whitespaces)
        let display = alias.flatMap { $0.isEmpty ? nil : $0 }
            ?? (heading.flatMap { $0.isEmpty ? nil : (target.isEmpty ? $0 : "\(target) › \($0)") } ?? target)
        return Parsed(target: target, heading: heading, display: display)
    }

    public static func url(target: String, heading: String?) -> String {
        var q = "target=" + encode(target)
        if let heading, !heading.isEmpty { q += "&heading=" + encode(heading) }
        return "\(scheme)://open?\(q)"
    }

    /// The Note title (and optional heading) a tapped `oni-note:` link names.
    public static func parse(url: URL) -> (target: String, heading: String?)? {
        guard url.scheme == scheme,
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let target = comps.queryItems?.first(where: { $0.name == "target" })?.value,
              !target.isEmpty else { return nil }
        return (target, comps.queryItems?.first(where: { $0.name == "heading" })?.value)
    }

    private static func encode(_ s: String) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s
    }

    private static func escapeLabel(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    /// Rewrites every wikilink outside code (fenced blocks and inline spans)
    /// into `[Display](oni-note://open?target=…)`. A link to a heading in the
    /// same Note (`[[#Heading]]`) has nowhere to go and becomes plain text.
    public static func rewrite(_ markdown: String) -> String {
        var inFence = false
        var out: [String] = []
        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                out.append(line)
                continue
            }
            if inFence || !line.contains("[[") {
                out.append(line)
                continue
            }
            // Odd-numbered segments between backticks are inline code: leave them.
            let parts = line.components(separatedBy: "`")
            out.append(parts.enumerated().map { index, part in
                index % 2 == 1 ? part : rewriteSegment(part)
            }.joined(separator: "`"))
        }
        return out.joined(separator: "\n")
    }

    private static func rewriteSegment(_ segment: String) -> String {
        let ns = segment as NSString
        var result = ""
        var cursor = 0
        for match in pattern.matches(in: segment, range: NSRange(location: 0, length: ns.length)) {
            result += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            cursor = match.range.location + match.range.length
            let isEmbed = ns.substring(with: match.range(at: 1)) == "!"
            let parsed = parseInner(ns.substring(with: match.range(at: 2)))
            if parsed.target.isEmpty {
                result += escapeLabel(parsed.display)
            } else {
                let label = (isEmbed ? "↪ " : "") + parsed.display
                result += "[\(escapeLabel(label))](\(url(target: parsed.target, heading: parsed.heading)))"
            }
        }
        result += ns.substring(from: cursor)
        return result
    }

    /// Targets of every wikilink outside code, for backlinks and link checks.
    public static func targets(in markdown: String) -> [String] {
        var found: [String] = []
        var inFence = false
        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle(); continue }
            guard !inFence, line.contains("[[") else { continue }
            for (index, part) in line.components(separatedBy: "`").enumerated() where index % 2 == 0 {
                let ns = part as NSString
                for match in pattern.matches(in: part, range: NSRange(location: 0, length: ns.length)) {
                    let target = parseInner(ns.substring(with: match.range(at: 2))).target
                    if !target.isEmpty { found.append(target) }
                }
            }
        }
        return found
    }
}
