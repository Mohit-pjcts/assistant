import Foundation

/// A finished assistant message, rebuilt from the stream.
public struct AssembledMessage: Sendable, Equatable {
    /// The content blocks exactly as they must be sent back next turn.
    public var content: [JSONValue]
    public var stopReason: String?
    public var usage: Usage
    /// `tool_use` blocks whose JSON arguments never closed (cut off by
    /// `max_tokens` or a dropped connection). Never run these.
    public var malformedToolUseIDs: Set<String>

    public var text: String {
        content.compactMap { $0["type"]?.string == "text" ? $0["text"]?.string : nil }.joined()
    }

    public var toolUses: [(id: String, name: String, input: JSONValue)] {
        content.compactMap { block in
            guard block["type"]?.string == "tool_use", let id = block["id"]?.string, let name = block["name"]?.string
            else { return nil }
            return (id, name, block["input"] ?? [:])
        }
    }
}

/// Turns the Messages API's server-sent events into live text plus the final
/// message. Fed one `data:` payload at a time: the API puts each event's JSON
/// on a single line, so the `event:` lines and blank separators carry nothing
/// extra and are ignored by the caller.
public struct StreamAssembler: Sendable {
    public enum Output: Sendable, Equatable {
        case text(String)
        case toolStarted(id: String, name: String)
    }

    private struct Block {
        var start: JSONValue
        var text = ""
        var partialJSON = ""
        var signature = ""
    }

    private var blocks: [Int: Block] = [:]
    private var finished: [Int: JSONValue] = [:]
    private var malformed: Set<String> = []
    private var stopReason: String?
    private var usage = Usage()
    public private(set) var isComplete = false

    public init() {}

    public mutating func consume(data: String) throws -> [Output] {
        guard let event = JSONValue.parse(data), let type = event["type"]?.string else { return [] }
        switch type {
        case "message_start":
            if let u = event["message"]?["usage"] { absorb(u, replacingOutput: true) }
        case "content_block_start":
            guard let index = event["index"]?.int, let block = event["content_block"] else { return [] }
            blocks[index] = Block(start: block)
            if block["type"]?.string == "tool_use", let id = block["id"]?.string, let name = block["name"]?.string {
                return [.toolStarted(id: id, name: name)]
            }
        case "content_block_delta":
            guard let index = event["index"]?.int, let delta = event["delta"], var block = blocks[index] else { return [] }
            var out: [Output] = []
            switch delta["type"]?.string {
            case "text_delta":
                let t = delta["text"]?.string ?? ""
                block.text += t
                if !t.isEmpty { out.append(.text(t)) }
            case "input_json_delta": block.partialJSON += delta["partial_json"]?.string ?? ""
            case "thinking_delta": block.text += delta["thinking"]?.string ?? ""
            case "signature_delta": block.signature += delta["signature"]?.string ?? ""
            default: break
            }
            blocks[index] = block
            return out
        case "content_block_stop":
            guard let index = event["index"]?.int, let block = blocks.removeValue(forKey: index) else { return [] }
            finished[index] = finalize(block)
        case "message_delta":
            if let reason = event["delta"]?["stop_reason"]?.string { stopReason = reason }
            if let u = event["usage"] { absorb(u, replacingOutput: true) }
        case "message_stop":
            isComplete = true
        case "error":
            let message = event["error"]?["message"]?.string ?? "unknown error"
            let kind = event["error"]?["type"]?.string
            if kind == "overloaded_error" { throw ClaudeError.overloaded }
            throw ClaudeError.stream(message)
        default:
            break  // ping, and event types added later
        }
        return []
    }

    /// The finished message. Throws if the stream ended before `message_stop`:
    /// a half-received reply must never be treated as a complete turn.
    public func message() throws -> AssembledMessage {
        guard isComplete else { throw ClaudeError.stream("the connection closed before the reply finished") }
        return AssembledMessage(
            content: finished.keys.sorted().compactMap { finished[$0] },
            stopReason: stopReason, usage: usage, malformedToolUseIDs: malformed)
    }

    private mutating func finalize(_ block: Block) -> JSONValue {
        var out = block.start.object ?? [:]
        switch block.start["type"]?.string {
        case "text":
            out["text"] = .string(block.text)
        case "thinking":
            out["thinking"] = .string(block.text)
            if !block.signature.isEmpty { out["signature"] = .string(block.signature) }
        case "tool_use":
            let raw = block.partialJSON.trimmingCharacters(in: .whitespacesAndNewlines)
            if raw.isEmpty {
                out["input"] = [:]
            } else if let parsed = JSONValue.parse(raw), parsed.object != nil {
                out["input"] = parsed
            } else {
                out["input"] = [:]
                if let id = block.start["id"]?.string { malformed.insert(id) }
            }
        default:
            break
        }
        return .object(out)
    }

    private mutating func absorb(_ u: JSONValue, replacingOutput: Bool) {
        if let n = u["input_tokens"]?.int { usage.inputTokens = n }
        if let n = u["cache_creation_input_tokens"]?.int { usage.cacheCreationTokens = n }
        if let n = u["cache_read_input_tokens"]?.int { usage.cacheReadTokens = n }
        if let n = u["output_tokens"]?.int { usage.outputTokens = n }
    }
}
