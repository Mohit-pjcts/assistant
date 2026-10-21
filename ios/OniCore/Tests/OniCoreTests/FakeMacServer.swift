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
    // The board and the pending facts behave like a small real store.
    private(set) var board: [BoardTask] = []
    private(set) var facts: [PendingFact] = []
    private var storeFailure: (any Error)?
    private var nextTask = 100
    func seedBoard(_ tasks: [BoardTask]) { board = tasks }
    func seedFacts(_ pending: [PendingFact]) { facts = pending }
    func failStore(with error: (any Error)?) { storeFailure = error }
    private func checkStore() throws { if let storeFailure { throw storeFailure } }

    private var calendarJSON: JSONValue = ["events": [], "courses": [], "undated": []]
    func seedCalendar(_ json: JSONValue) { calendarJSON = json }
    func calendar() async throws -> MacCalendar { try checkStore(); return try MacCalendar(calendarJSON) }

    func boardTasks() async throws -> [BoardTask] { try checkStore(); return board }
    func createBoardTask(column: BoardColumn, title: String, description: String, priority: String) async throws -> BoardTask {
        try checkStore()
        nextTask += 1
        let task = BoardTask.make(id: "t\(nextTask)", column: column, title: title, description: description, priority: priority)
        board.append(task)
        return task
    }
    func moveBoardTask(id: String, to column: BoardColumn, position: Int?) async throws -> BoardTask {
        try checkStore()
        guard let old = board.first(where: { $0.id == id }) else { throw MacServerError.notFound("no task") }
        let moved = BoardTask.make(id: old.id, column: column, title: old.title, description: old.description, priority: old.priority, ref: old.ref)
        board = board.map { $0.id == id ? moved : $0 }
        return moved
    }
    func updateBoardTask(id: String, title: String?, description: String?, priority: String?) async throws -> BoardTask {
        try checkStore()
        guard let old = board.first(where: { $0.id == id }) else { throw MacServerError.notFound("no task") }
        let edited = BoardTask.make(id: old.id, column: old.column, title: title ?? old.title, description: description ?? old.description,
                                    priority: priority ?? old.priority, ref: old.ref)
        board = board.map { $0.id == id ? edited : $0 }
        return edited
    }
    func deleteBoardTask(id: String) async throws {
        try checkStore()
        guard board.contains(where: { $0.id == id }) else { throw MacServerError.notFound("no task") }
        board.removeAll { $0.id == id }
    }
    func pendingFacts() async throws -> [PendingFact] { try checkStore(); return facts }
    func approvePendingFact(id: Int) async throws {
        try checkStore()
        guard facts.contains(where: { $0.id == id }) else { throw MacServerError.notFound("no fact") }
        facts.removeAll { $0.id == id }
    }
    func declinePendingFact(id: Int) async throws {
        try checkStore()
        guard facts.contains(where: { $0.id == id }) else { throw MacServerError.notFound("no fact") }
        facts.removeAll { $0.id == id }
    }
    /// What `upload` does: succeed (recording each upload) unless told to fail.
    private(set) var uploads: [(filename: String, mimeType: String, size: Int)] = []
    private var uploadFailure: (any Error)?
    func failUploads(with error: any Error) { uploadFailure = error }

    // Voice: scripted transcripts (the last one repeats), and speech that records
    // what it was asked to say.
    private var transcripts: [Result<String, any Error>] = []
    private(set) var transcribed: [(size: Int, filename: String, mimeType: String, wav: Data)] = []
    private(set) var spoken: [String] = []
    private var speakFailure: (any Error)?
    func scriptTranscripts(_ results: [Result<String, any Error>]) { transcripts = results }
    func failSpeech(with error: (any Error)?) { speakFailure = error }

    func transcribe(audio: Data, filename: String, mimeType: String) async throws -> String {
        transcribed.append((audio.count, filename, mimeType, audio))
        let next = transcripts.count > 1 ? transcripts.removeFirst() : (transcripts.first ?? .success(""))
        return try next.get()
    }

    func speak(text: String) async throws -> Data {
        spoken.append(text)
        if let speakFailure { throw speakFailure }
        return Data("mp3:\(text)".utf8)
    }

    func upload(data: Data, filename: String, mimeType: String) async throws -> MacAttachment {
        if let uploadFailure { throw uploadFailure }
        uploads.append((filename, mimeType, data.count))
        return try MacAttachment(["path": .string("uploads/2026-10-21/\(uploads.count)_\(filename)"), "mime_type": .string(mimeType),
                                  "kind": "image", "filename": .string(filename)])
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
    static func make(_ role: String, _ content: String, surfaces: [JSONValue] = []) -> MacMessage {
        try! MacMessage(.object(["role": .string(role), "content": .string(content), "surfaces": .array(surfaces)]))
    }
}

extension BoardTask {
    static func make(id: String, column: BoardColumn = .todo, title: String, description: String = "",
                     priority: String = "medium", ref: String? = nil) -> BoardTask {
        try! BoardTask(["id": .string(id), "column": .string(column.rawValue), "ref": .string(ref ?? "ONI-\(id)"),
                        "priority": .string(priority), "title": .string(title), "description": .string(description), "position": 0])
    }
}

extension PendingFact {
    static func make(_ id: Int, _ content: String, provenance: String? = nil) -> PendingFact {
        var json: [String: JSONValue] = ["id": .number(Double(id)), "content": .string(content), "created_at": "2026-10-21T08:00:00Z"]
        if let provenance { json["provenance"] = .string(provenance) }
        return try! PendingFact(.object(json))
    }
}
