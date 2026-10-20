import Foundation
import Markdown

public enum MDAlignment: Sendable, Equatable { case leading, center, trailing }

public struct MDListItem: Sendable, Equatable {
    /// `nil` for a plain item, otherwise a task-list item and whether it is ticked.
    public var checked: Bool?
    public var blocks: [MDBlock]
}

/// A Note's body as blocks a screen can lay out. Inline styling (bold, italic,
/// code, links, strikethrough) is carried in each block's `AttributedString`.
public indirect enum MDBlock: Sendable, Equatable {
    case heading(level: Int, text: AttributedString)
    case paragraph(AttributedString)
    case list(ordered: Bool, start: Int, items: [MDListItem])
    case quote([MDBlock])
    /// Obsidian `> [!note] Title` — `kind` is lower-cased (`note`, `warning`, …).
    case callout(kind: String, title: AttributedString, body: [MDBlock])
    case code(language: String?, text: String)
    case rule
    case table(header: [AttributedString], alignments: [MDAlignment], rows: [[AttributedString]])
}

public enum MarkdownBlocks {
    /// Parses a whole Note (frontmatter is dropped, wikilinks become links).
    public static func parse(note text: String) -> [MDBlock] {
        parse(markdown: Frontmatter.split(text).body)
    }

    public static func parse(markdown: String) -> [MDBlock] {
        let document = Document(parsing: WikiLinks.rewrite(markdown))
        return blocks(from: Array(document.children))
    }

    // MARK: Blocks

    private static func blocks(from children: [Markup]) -> [MDBlock] {
        children.compactMap(block(from:))
    }

    private static func block(from markup: Markup) -> MDBlock? {
        switch markup {
        case let h as Heading:
            return .heading(level: h.level, text: inlines(Array(h.children)))
        case let p as Paragraph:
            return .paragraph(inlines(Array(p.children)))
        case let c as CodeBlock:
            let language = c.language.flatMap { $0.isEmpty ? nil : $0 }
            return .code(language: language, text: c.code.trimmingCharacters(in: CharacterSet(charactersIn: "\n")))
        case is ThematicBreak:
            return .rule
        case let q as BlockQuote:
            return quoteOrCallout(q)
        case let l as UnorderedList:
            return .list(ordered: false, start: 1, items: l.listItems.map(item(from:)))
        case let l as OrderedList:
            return .list(ordered: true, start: Int(l.startIndex), items: l.listItems.map(item(from:)))
        case let t as Markdown.Table:
            return table(from: t)
        case let html as HTMLBlock:
            let text = stripHTML(html.rawHTML)
            return text.isEmpty ? nil : .paragraph(AttributedString(text))
        default:
            return nil
        }
    }

    private static func item(from li: ListItem) -> MDListItem {
        let checked: Bool? = switch li.checkbox {
        case .checked: true
        case .unchecked: false
        case nil: nil
        }
        return MDListItem(checked: checked, blocks: blocks(from: Array(li.children)))
    }

    private static func table(from t: Markdown.Table) -> MDBlock {
        let header = Array(t.head.cells).map { inlines(Array($0.children)) }
        let alignments: [MDAlignment] = t.columnAlignments.map {
            switch $0 {
            case .center: .center
            case .right: .trailing
            default: .leading
            }
        }
        let rows = Array(t.body.rows).map { row in Array(row.cells).map { inlines(Array($0.children)) } }
        return .table(header: header, alignments: alignments, rows: rows)
    }

    private static let calloutHeader = try! NSRegularExpression(pattern: #"^\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*(.*)$"#)

    /// A quote whose first line is `[!kind] Title` is an Obsidian callout.
    private static func quoteOrCallout(_ quote: BlockQuote) -> MDBlock {
        let children = Array(quote.children)
        if let first = children.first as? Paragraph {
            let inline = Array(first.children)
            let splitAt = inline.firstIndex { $0 is SoftBreak || $0 is LineBreak }
            let headerNodes = splitAt.map { Array(inline[..<$0]) } ?? inline
            let headerText = headerNodes.map(\.plainTextForCallout).joined()
            let ns = headerText as NSString
            if let m = calloutHeader.firstMatch(in: headerText, range: NSRange(location: 0, length: ns.length)) {
                let kind = ns.substring(with: m.range(at: 1)).lowercased()
                let rest = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
                let title = rest.isEmpty ? AttributedString(kind.prefix(1).uppercased() + kind.dropFirst()) : AttributedString(rest)
                var body: [MDBlock] = []
                if let splitAt {
                    let remaining = Array(inline[(splitAt + 1)...])
                    if !remaining.isEmpty { body.append(.paragraph(inlines(remaining))) }
                }
                body += blocks(from: Array(children.dropFirst()))
                return .callout(kind: kind, title: title, body: body)
            }
        }
        return .quote(blocks(from: children))
    }

    // MARK: Inlines

    private static func inlines(_ nodes: [Markup]) -> AttributedString {
        var out = AttributedString()
        for node in nodes { out.append(inline(node, intent: [])) }
        return out
    }

    private static func inline(_ node: Markup, intent: InlinePresentationIntent) -> AttributedString {
        func styled(_ text: String, _ extra: InlinePresentationIntent = []) -> AttributedString {
            var s = AttributedString(text)
            let all = intent.union(extra)
            if !all.isEmpty { s.inlinePresentationIntent = all }
            return s
        }
        func children(_ intent: InlinePresentationIntent) -> AttributedString {
            var out = AttributedString()
            for child in node.children { out.append(inline(child, intent: intent)) }
            return out
        }
        switch node {
        case let t as Markdown.Text: return styled(t.string)
        case is SoftBreak: return styled("\n")
        case is LineBreak: return styled("\n")
        case let c as InlineCode: return styled(c.code, .code)
        case is Strong: return children(intent.union(.stronglyEmphasized))
        case is Emphasis: return children(intent.union(.emphasized))
        case is Strikethrough: return children(intent.union(.strikethrough))
        case let l as Markdown.Link:
            var s = children(intent)
            if let destination = l.destination, let url = URL(string: destination) { s.link = url }
            return s
        case let i as Markdown.Image:
            let alt = i.plainText.isEmpty ? "image" : i.plainText
            var s = styled("🖼 " + alt)
            if let source = i.source, let url = URL(string: source), url.scheme?.hasPrefix("http") == true { s.link = url }
            return s
        case let html as InlineHTML:
            let tag = html.rawHTML.lowercased()
            return tag.hasPrefix("<br") ? styled("\n") : AttributedString()
        default: return children(intent)
        }
    }

    private static func stripHTML(_ html: String) -> String {
        let withBreaks = html.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        return withBreaks.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private extension Markup {
    /// Plain text of an inline node, used only to read a callout's first line.
    var plainTextForCallout: String {
        switch self {
        case let t as Markdown.Text: t.string
        case let c as InlineCode: c.code
        default: children.map(\.plainTextForCallout).joined()
        }
    }
}
