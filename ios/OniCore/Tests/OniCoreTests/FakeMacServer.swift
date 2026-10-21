import Foundation
@testable import OniCore

/// A scripted `MacServer` for tests of the turn driver and the screens' logic.
/// Only what a test sets is answered; everything else fails loudly.
actor FakeMacServer: MacServer {
    /// What one `stream(_:)` call does: yield frames, then either end quietly
    /// (a dropped link) or throw.
    struct Script {
        var frames: [ChatFrame] = []
        var thenThrow: (any Error)?
    }

    private var streams: [Script]
    private var states: [Result<TurnState, any Error>]
    private var histories: [Result<[MacMessage], any Error>]
    private(set) var requests: [TurnRequest] = []
    private(set) var turnStateCalls = 0
    private(set) var stopCalls = 0

    init(
        streams: [Script] = [], states: [Result<TurnState, any Error>] = [],
        histories: [Result<[MacMessage], any Error>] = []
    ) {
        self.streams = streams
        self.states = states
        self.histories = histories
    }

    nonisolated func stream(_ request: TurnRequest) -> AsyncThrowingStream<ChatFrame, Error> {
        AsyncThrowingStream { continuation in
            Task {
                let script = await self.nextStream(for: request)
                for frame in script.frames { continuation.yield(frame) }
                continuation.finish(throwing: script.thenThrow)
            }
        }
    }

    private func nextStream(for request: TurnRequest) -> Script {
        requests.append(request)
        return streams.isEmpty ? Script() : streams.removeFirst()
    }

    func turnState(threadId: String) async throws -> TurnState {
        turnStateCalls += 1
        // The last scripted answer repeats, like a server that has settled.
        let next = states.count > 1 ? states.removeFirst() : (states.first ?? .failure(MacServerError.unreachable("no script")))
        return try next.get()
    }

    func stop(threadId: String) async throws -> Bool { stopCalls += 1; return true }
    func history(threadId: String) async throws -> [MacMessage] {
        // Like turn state: the last scripted answer repeats.
        let next = histories.count > 1 ? histories.removeFirst() : (histories.first ?? .success([]))
        return try next.get()
    }
    func threads() async throws -> ThreadList { ThreadList(threads: [], activeThreadId: nil) }
    func createThread(title: String?) async throws -> MacThread { throw MacServerError.notFound("not scripted") }
    func renameThread(id: String, title: String) async throws -> MacThread { throw MacServerError.notFound("not scripted") }
    func deleteThread(id: String) async throws {}
    func projects() async throws -> [MacProject] { [] }
    func boardTasks() async throws -> [BoardTask] { [] }
    func createBoardTask(column: BoardColumn, title: String, description: String, priority: String) async throws -> BoardTask {
        throw MacServerError.notFound("not scripted")
    }
    func moveBoardTask(id: String, to column: BoardColumn, position: Int?) async throws -> BoardTask {
        throw MacServerError.notFound("not scripted")
    }
    func updateBoardTask(id: String, title: String?, description: String?, priority: String?) async throws -> BoardTask {
        throw MacServerError.notFound("not scripted")
    }
    func deleteBoardTask(id: String) async throws {}
    func pendingFacts() async throws -> [PendingFact] { [] }
    func approvePendingFact(id: Int) async throws {}
    func declinePendingFact(id: Int) async throws {}
    func upload(data: Data, filename: String, mimeType: String) async throws -> MacAttachment {
        throw MacServerError.notFound("not scripted")
    }
}

extension TurnState {
    /// A state as the Mac would report it.
    static func make(_ json: JSONValue) -> TurnState { try! TurnState(json) }
    static var running: TurnState { make(["status": "running"]) }
    static func idle(_ outcome: String? = nil, detail: String? = nil) -> TurnState {
        var json: [String: JSONValue] = ["status": "idle"]
        if let outcome {
            var last: [String: JSONValue] = ["outcome": .string(outcome)]
            if let detail { last["detail"] = .string(detail) }
            json["last"] = .object(last)
        }
        return make(.object(json))
    }
    static func waiting(_ gate: JSONValue) -> TurnState { make(["status": "waiting_for_approval", "gate": gate]) }
}

extension MacMessage {
    static func make(_ role: String, _ content: String) -> MacMessage {
        try! MacMessage(.object(["role": .string(role), "content": .string(content)]))
    }
}
