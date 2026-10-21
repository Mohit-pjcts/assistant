import Foundation

/// One thing to show in a Mac conversation.
public enum MacTranscriptItem: Sendable, Equatable, Identifiable {
    case user(id: Int, text: String)
    /// Oni's reply, with the generative-UI surfaces its tools produced during
    /// the turn. `skippedSurfaces` counts ones that failed validation: they are
    /// never drawn, and the view says so rather than hiding it.
    case assistant(id: Int, text: String, surfaces: [A2UISurface], skippedSurfaces: Int)

    public var id: Int {
        switch self {
        case .user(let id, _), .assistant(let id, _, _, _): id
        }
    }
}

/// Turns a thread's `/history` into what the dashboard's chat shows
/// (`visibleMessages` + `attachPersistedSurfaces` in ChatPanel.tsx): only real
/// dialogue, with every surface produced during a turn riding on the reply that
/// closes it. Tool rows and graph-inserted "user" messages (recalled facts, the
/// compaction summary) are real state but not dialogue.
public enum MacTranscript {
    public static func items(from messages: [MacMessage]) -> [MacTranscriptItem] {
        var items: [MacTranscriptItem] = []
        var pending: [A2UISurface] = []
        var skipped = 0
        for (index, message) in messages.enumerated() {
            for raw in message.surfaces {
                if let surface = try? A2UISurface.parse(raw) { pending.append(surface) } else { skipped += 1 }
            }
            let hasText = !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            switch message.role {
            case "assistant":
                if hasText || !pending.isEmpty || skipped > 0 {
                    items.append(.assistant(id: index, text: message.content, surfaces: pending, skippedSurfaces: skipped))
                }
                pending = []
                skipped = 0
            case "user":
                if hasText, !message.synthetic { items.append(.user(id: index, text: message.content)) }
            default:
                break
            }
        }
        return items
    }
}

/// How a tool call is described in the "Oni is working" line.
public enum MacActivityLabel {
    /// "Research: web search", or nil when a tool just finished (back to thinking).
    public static func text(for activity: AgentActivity) -> String? {
        guard activity.phase == .toolStart else { return nil }
        let tool = activity.tool.replacingOccurrences(of: "_", with: " ")
        let agent = activity.agent == "supervisor" ? "" : agentName(activity.agent) + ": "
        return agent + tool
    }

    private static func agentName(_ raw: String) -> String {
        let base = raw.hasSuffix("_agent") ? String(raw.dropLast(6)) : raw
        let spaced = base.replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}
