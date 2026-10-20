import OniCore
import SwiftUI

/// Renders OniCore's `MDBlock`s. Math is left as readable text, not typeset.
struct MarkdownView: View {
    let blocks: [MDBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MDBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(text)
                .font(Self.headingFont(level))
                .fontWeight(.semibold)
                .padding(.top, level <= 2 ? 6 : 2)
        case .paragraph(let text):
            Text(text)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { offset, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(ordered: ordered, number: start + offset, checked: item.checked)
                        MarkdownView(blocks: item.blocks)
                    }
                }
            }
        case .quote(let inner):
            HStack(alignment: .top, spacing: 10) {
                Rectangle().fill(.secondary.opacity(0.5)).frame(width: 3)
                MarkdownView(blocks: inner).foregroundStyle(.secondary)
            }
        case .callout(let kind, let title, let body):
            let style = CalloutStyle(kind: kind)
            VStack(alignment: .leading, spacing: 6) {
                Label { Text(title).fontWeight(.semibold) } icon: { Image(systemName: style.icon) }
                    .foregroundStyle(style.color)
                if !body.isEmpty { MarkdownView(blocks: body) }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(style.color.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .padding(12)
            }
            .background(.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        case .rule:
            Divider()
        case .table(let header, let alignments, let rows):
            ScrollView(.horizontal, showsIndicators: true) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { column, cell in
                            Text(cell).fontWeight(.semibold)
                                .gridColumnAlignment(Self.alignment(alignments, column))
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in Text(cell) }
                        }
                    }
                }
                .padding(12)
            }
            .background(.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    @ViewBuilder
    private func marker(ordered: Bool, number: Int, checked: Bool?) -> some View {
        if let checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checked ? Color.accentColor : .secondary)
        } else if ordered {
            Text("\(number).").monospacedDigit().foregroundStyle(.secondary)
        } else {
            Text("•").foregroundStyle(.secondary)
        }
    }

    private static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title
        case 2: .title2
        case 3: .title3
        default: .headline
        }
    }

    private static func alignment(_ all: [MDAlignment], _ column: Int) -> HorizontalAlignment {
        guard column < all.count else { return .leading }
        switch all[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

private struct CalloutStyle {
    let icon: String
    let color: Color

    init(kind: String) {
        switch kind {
        case "tip", "hint", "important": (icon, color) = ("flame", .teal)
        case "success", "check", "done": (icon, color) = ("checkmark.circle", .green)
        case "warning", "caution", "attention": (icon, color) = ("exclamationmark.triangle", .orange)
        case "danger", "error", "failure", "fail", "missing", "bug": (icon, color) = ("xmark.octagon", .red)
        case "question", "help", "faq": (icon, color) = ("questionmark.circle", .purple)
        case "quote", "cite": (icon, color) = ("quote.opening", .gray)
        case "example": (icon, color) = ("list.bullet", .indigo)
        case "abstract", "summary", "tldr": (icon, color) = ("doc.text", .cyan)
        case "todo": (icon, color) = ("checklist", .blue)
        default: (icon, color) = ("info.circle", .blue)
        }
    }
}
