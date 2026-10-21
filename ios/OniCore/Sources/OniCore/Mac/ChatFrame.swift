import Foundation

/// One tool starting or finishing, for the "Oni is working" indicator.
public struct AgentActivity: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case toolStart, toolEnd }
    public let phase: Phase
    /// "supervisor" or the specialist doing the work.
    public let agent: String
    public let tool: String
}

/// One server-sent frame of a `/chat`, `/resume` or `/a2ui/action` stream
/// (`_stream_turn` in assistant/server.py). A turn is zero or more live frames
/// and then exactly one terminal frame: `message`, `interrupt` (or its
/// unreadable twin) or `error`.
public enum ChatFrame: Sendable, Equatable {
    /// A piece of the reply as it is written.
    case token(String)
    /// A generative-UI surface, already validated.
    case a2ui(A2UISurface)
    case activity(AgentActivity)

    /// Terminal: the finished reply.
    case message(String)
    /// Terminal: the turn is paused at a confirmation.
    case interrupt(Gate)
    /// Terminal: a confirmation whose payload cannot be shown. It must not be
    /// approved blind; the caller sends a decline (PLAN.md Phase 31 D4).
    case unreadableInterrupt
    /// Terminal: the Mac reported a failure.
    case error(String)

    /// A surface that failed validation. Not drawn; the reason is kept so it
    /// can be shown as a note.
    case rejectedSurface(String)
    /// A frame type this version does not know. Ignored.
    case unknown(String)

    public var isTerminal: Bool {
        switch self {
        case .message, .interrupt, .unreadableInterrupt, .error: return true
        default: return false
        }
    }

    /// Parses one line of the stream. Returns nil for anything that is not a
    /// `data:` line (blank separators, comments).
    public static func parse(line: String) -> ChatFrame? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard let json = JSONValue.parse(payload), let type = json["type"]?.string else {
            return .error("The Mac sent a frame the app could not read.")
        }
        switch type {
        case "token":
            return .token(json["text"]?.string ?? "")
        case "message":
            return .message(json["content"]?.string ?? "")
        case "error":
            return .error(json["detail"]?.string ?? "The Mac reported an error.")
        case "interrupt":
            guard let payload = json["payload"], let gate = Gate.parse(payload) else { return .unreadableInterrupt }
            return .interrupt(gate)
        case "a2ui":
            guard let surface = json["surface"] else { return .rejectedSurface("the frame carried no surface") }
            do { return .a2ui(try A2UISurface.parse(surface)) } catch { return .rejectedSurface(String(describing: error)) }
        case "activity":
            guard let agent = json["agent"]?.string, let tool = json["tool"]?.string else { return .unknown(type) }
            switch json["phase"]?.string {
            case "tool_start": return .activity(AgentActivity(phase: .toolStart, agent: agent, tool: tool))
            case "tool_end": return .activity(AgentActivity(phase: .toolEnd, agent: agent, tool: tool))
            default: return .unknown(type)
            }
        default:
            return .unknown(type)
        }
    }
}
