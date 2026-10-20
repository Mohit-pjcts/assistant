import Foundation
@testable import OniCore

// Shared fixtures for the chat tests.

func tempReplica() -> (Replica, URL) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oni-chat-\(UUID().uuidString)", isDirectory: true)
    return (Replica(directory: dir), dir)
}

func toolbox(_ replica: Replica, semantic: VaultToolbox.Semantic? = nil) -> VaultToolbox {
    VaultToolbox(replica: replica, semantic: semantic, today: { "2026-10-20" })
}

func assembled(
    content: [JSONValue], stop: String, malformed: Set<String> = [], usage: Usage = Usage(inputTokens: 100, outputTokens: 10)
) -> AssembledMessage {
    AssembledMessage(content: content, stopReason: stop, usage: usage, malformedToolUseIDs: malformed)
}

func text(_ s: String) -> JSONValue { ["type": "text", "text": .string(s)] }

func toolUse(_ id: String, _ name: String, _ input: JSONValue) -> JSONValue {
    ["type": "tool_use", "id": .string(id), "name": .string(name), "input": input]
}

/// Plays back scripted replies and records every request it was sent.
actor Script {
    var replies: [Result<AssembledMessage, Error>]
    private(set) var requests: [ChatRequest] = []
    init(_ replies: [Result<AssembledMessage, Error>]) { self.replies = replies }
    func next(_ r: ChatRequest) -> Result<AssembledMessage, Error> {
        requests.append(r)
        return replies.isEmpty ? .failure(ClaudeError.stream("script exhausted")) : replies.removeFirst()
    }
}

struct ScriptedClient: ModelClient {
    let script: Script
    /// Waits until cancelled, to exercise Stop.
    var hang = false
    func complete(_ request: ChatRequest, onOutput: @Sendable (StreamAssembler.Output) -> Void) async throws -> AssembledMessage {
        if hang { try await Task.sleep(for: .seconds(60)); throw ClaudeError.stream("hang ended") }
        let reply = try await script.next(request).get()
        if !reply.text.isEmpty { onOutput(.text(reply.text)) }
        for use in reply.toolUses { onOutput(.toolStarted(id: use.id, name: use.name)) }
        return reply
    }
}

func collect(_ run: AgentRun) async -> [AgentEvent] {
    var out: [AgentEvent] = []
    for await e in run.events { out.append(e) }
    return out
}

func committedHistory(_ events: [AgentEvent]) -> [JSONValue] {
    for case .committed(let m) in events.reversed() { return m }
    return []
}

func finish(_ events: [AgentEvent]) -> Finish? {
    for case .finished(let f) in events { return f }
    return nil
}
