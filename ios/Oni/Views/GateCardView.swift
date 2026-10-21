import OniCore
import SwiftUI

/// A confirmation, drawn from `Gate`'s rows and nothing else: whatever the Mac
/// asked to do is on this card exactly as sent (CLAUDE.md, Security model;
/// PLAN.md Phase 31 D3/D4). Free text is shown whole, selectable, never
/// shortened. Decline sits first and is as easy to hit as Approve.
struct GateCardView: View {
    let gate: Gate
    let onAnswer: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                if let source = gate.source {
                    Text(source.uppercased()).font(.caption2).fontWeight(.semibold).foregroundStyle(.secondary)
                }
                Text(gate.heading).font(.headline)
            }
            ForEach(Array(gate.rows.enumerated()), id: \.offset) { _, row in
                GateRowView(row: row)
            }
            if !gate.otherDetails.isEmpty {
                Text("Other details").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                ForEach(Array(gate.otherDetails.enumerated()), id: \.offset) { _, row in
                    GateRowView(row: row)
                }
            }
            HStack(spacing: 12) {
                Button(role: .cancel) { onAnswer(false) } label: { Text("Decline").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("gate-decline")
                Button { onAnswer(true) } label: { Text("Approve").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("gate-approve")
            }
            .controlSize(.large)
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.orange.opacity(0.6), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gate-card")
    }
}

private struct GateRowView: View {
    let row: GateRow

    var body: some View {
        switch row {
        case .field(let label, let value):
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        case .block(_, let label, let text):
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.background.tertiary, in: RoundedRectangle(cornerRadius: 8))
            }
        case .section(let title):
            Text(title).font(.caption).fontWeight(.semibold).foregroundStyle(.secondary).padding(.top, 4)
        case .warning(_, let text):
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline).foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
        case .step(let index, let action, let specialist, let summary, let extras):
            VStack(alignment: .leading, spacing: 6) {
                Text("Step \(index + 1) · \(action)" + (specialist.map { " · \($0)" } ?? ""))
                    .font(.subheadline).fontWeight(.semibold)
                Text(summary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                ForEach(Array(extras.enumerated()), id: \.offset) { _, extra in GateRowView(row: extra) }
            }
            .padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(.secondary.opacity(0.4)).frame(width: 2) }
        }
    }
}
