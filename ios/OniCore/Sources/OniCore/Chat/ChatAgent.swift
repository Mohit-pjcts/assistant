import Foundation

public enum AgentEvent: Sendable, Equatable {
    /// A piece of the reply as it streams.
    case textDelta(String)
    /// The model started a tool call (shown as "Oni is searching…").
    case toolStarted(name: String)
    case toolFinished(name: String, isError: Bool, wroteVault: Bool)
    /// Running total for this turn.
    case usage(Usage)
    /// The history up to the last consistent point (every `tool_use` answered).
    /// Persist this; never persist anything else.
    case committed([JSONValue])
    case finished(Finish)
}

public enum Finish: Sendable, Equatable {
    case done
    case stopped
    /// The same tool failed `Limit.sameToolFailures` times running.
    case breaker(tool: String)
    /// Hit the cap on model calls in one turn.
    case callLimit
    case refused
    case truncated
    /// The call failed (no network, bad key, rate limit...); the text is shown to the user.
    case failure(String)
}

/// A turn in flight.
public struct AgentRun: Sendable {
    public let events: AsyncStream<AgentEvent>
    let task: Task<Void, Never>
    public func stop() { task.cancel() }
}

/// One user turn: the tool-use loop around the model. Mirrors the Mac's agents,
/// minus the gates (ADR 0001): the repeated-failure breaker from
/// `assistant/circuit_breaker.py` and a Stop that cancels the in-flight call.
public struct ChatAgent: Sendable {
    public enum Limit {
        /// `RepeatedToolFailureCircuitBreaker`'s default of 3.
        public static let sameToolFailures = 3
        /// A backstop on model calls per turn, so a loop that keeps "succeeding"
        /// without ever finishing still stops costing money. ADR 0003 removed the
        /// per-turn *write* cap; this bounds the loop, not what it writes.
        public static let modelCalls = 25
    }

    private let client: any ModelClient
    private let toolbox: VaultToolbox
    private let system: String

    public init(client: any ModelClient, toolbox: VaultToolbox, system: String = OniPrompt.system) {
        self.client = client
        self.toolbox = toolbox
        self.system = system
    }

    /// Runs one turn on top of `history` (which already ends with the user's
    /// message). `stop()` cancels the in-flight model call at once and still
    /// delivers a final `committed` + `finished(.stopped)`, which is why Stop is
    /// a method on the run and not cancellation of whoever reads the events.
    public func run(history: [JSONValue], model: ClaudeModel) -> AgentRun {
        let (events, continuation) = AsyncStream.makeStream(of: AgentEvent.self)
        let task = Task {
            let finish = await self.loop(history: history, model: model) { continuation.yield($0) }
            continuation.yield(.finished(finish))
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return AgentRun(events: events, task: task)
    }

    private func loop(history: [JSONValue], model: ClaudeModel, emit: @Sendable (AgentEvent) -> Void) async -> Finish {
        var messages = history
        var committed = history
        var total = Usage()
        var streakTool: String?
        var streak = 0

        func commit(_ extra: [JSONValue]) {
            committed = messages + extra
            emit(.committed(committed))
        }

        for _ in 0..<Limit.modelCalls {
            let reply: AssembledMessage
            do {
                reply = try await client.complete(
                    ChatRequest(model: model, system: system, tools: VaultToolbox.definitions, messages: messages)
                ) { output in
                    switch output {
                    case .text(let t): emit(.textDelta(t))
                    case .toolStarted(_, let name): emit(.toolStarted(name: name))
                    }
                }
            } catch is CancellationError {
                return stopped(committed: committed, emit: emit)
            } catch {
                emit(.committed(committed))
                return .failure((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
            total.add(reply.usage)
            emit(.usage(total))
            messages.append(["role": "assistant", "content": .array(reply.content)])

            let toolUses = reply.toolUses
            guard reply.stopReason == "tool_use", !toolUses.isEmpty else {
                commit([])
                switch reply.stopReason {
                case "refusal": return .refused
                case "max_tokens": return .truncated
                default: return .done
                }
            }

            var results: [JSONValue] = []
            var tripped: String?
            for use in toolUses {
                if Task.isCancelled { return stopped(committed: committed, emit: emit) }
                let output: ToolOutput
                if reply.malformedToolUseIDs.contains(use.id) {
                    output = ToolOutput(
                        text: "Error: the arguments for \(use.name) were cut off before they finished, so nothing was run. Try again with shorter content.",
                        isError: true, wroteVault: false)
                } else {
                    output = await toolbox.execute(name: use.name, input: use.input)
                }
                emit(.toolFinished(name: use.name, isError: output.isError, wroteVault: output.wroteVault))
                var result: [String: JSONValue] = [
                    "type": "tool_result", "tool_use_id": .string(use.id), "content": .string(output.text),
                ]
                if output.isError { result["is_error"] = true }
                results.append(.object(result))

                if output.isError {
                    streak = (streakTool == use.name) ? streak + 1 : 1
                    streakTool = use.name
                    if streak >= Limit.sameToolFailures { tripped = use.name }
                } else {
                    streakTool = nil
                    streak = 0
                }
            }
            // All of a turn's tool results go back in ONE user message.
            messages.append(["role": "user", "content": .array(results)])

            if let tripped {
                let note: JSONValue = [
                    "role": "assistant",
                    "content": [["type": "text", "text": .string(
                        "I stopped: \(tripped) failed \(Limit.sameToolFailures) times in a row with the same kind of error, so I'm not retrying.")]],
                ]
                messages.append(note)
                commit([])
                return .breaker(tool: tripped)
            }
            commit([])
        }
        return .callLimit
    }

    /// Stop was pressed. History must still alternate user/assistant, so a turn
    /// with no reply yet gets a one-line assistant note.
    private func stopped(committed: [JSONValue], emit: @Sendable (AgentEvent) -> Void) -> Finish {
        var history = committed
        if history.last?["role"]?.string == "user" {
            history.append(["role": "assistant", "content": [["type": "text", "text": "(Stopped.)"]]])
        }
        emit(.committed(history))
        return .stopped
    }
}
