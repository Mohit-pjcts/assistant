import Foundation
import Observation

/// The Mac's kanban board, as the phone's Board screen sees it. The board is
/// the same data the dashboard shows and Oni edits (PLAN.md Phase 31 D9); the
/// phone changes it only by asking the Mac, and shows what the Mac answers.
@MainActor @Observable
public final class MacBoard {
    private let server: any MacServer

    public private(set) var tasks: [BoardTask] = []
    public private(set) var isLoaded = false
    public private(set) var isWorking = false
    public private(set) var errorMessage: String?

    public init(server: any MacServer) { self.server = server }

    /// A column's tasks in the order the Mac keeps them.
    public func tasks(in column: BoardColumn) -> [BoardTask] {
        tasks.filter { $0.column == column }.sorted { ($0.position, $0.ref) < ($1.position, $1.ref) }
    }

    public func load() async {
        do {
            tasks = try await server.boardTasks()
            isLoaded = true
            errorMessage = nil
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    @discardableResult
    public func add(title: String, description: String = "", priority: String = "medium", column: BoardColumn = .todo) async -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return await change { tasks in
            tasks.append(try await self.server.createBoardTask(column: column, title: trimmed, description: description, priority: priority))
        }
    }

    @discardableResult
    public func move(_ task: BoardTask, to column: BoardColumn) async -> Bool {
        guard task.column != column else { return true }
        return await change { tasks in
            let moved = try await self.server.moveBoardTask(id: task.id, to: column, position: nil)
            tasks = tasks.map { $0.id == moved.id ? moved : $0 }
        }
    }

    @discardableResult
    public func edit(_ task: BoardTask, title: String, description: String, priority: String) async -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return await change { tasks in
            let edited = try await self.server.updateBoardTask(id: task.id, title: trimmed, description: description, priority: priority)
            tasks = tasks.map { $0.id == edited.id ? edited : $0 }
        }
    }

    @discardableResult
    public func delete(_ task: BoardTask) async -> Bool {
        await change { tasks in
            try await self.server.deleteBoardTask(id: task.id)
            tasks.removeAll { $0.id == task.id }
        }
    }

    public func dismissError() { errorMessage = nil }

    /// One change at a time, applied to the local list only after the Mac
    /// accepted it, so the screen never shows something the Mac does not have.
    private func change(_ work: (inout [BoardTask]) async throws -> Void) async -> Bool {
        guard !isWorking else { return false }
        isWorking = true
        defer { isWorking = false }
        var next = tasks
        do {
            try await work(&next)
            tasks = next
            errorMessage = nil
            return true
        } catch {
            errorMessage = Self.describe(error)
            return false
        }
    }

    static func describe(_ error: Error) -> String { (error as? MacServerError)?.description ?? error.localizedDescription }
}

/// Facts Oni's nightly review proposed remembering. Nothing becomes a memory
/// until it is approved here or on the dashboard (CLAUDE.md, Confirmation rule).
@MainActor @Observable
public final class MacMemoryReview {
    private let server: any MacServer

    public private(set) var pending: [PendingFact] = []
    public private(set) var isLoaded = false
    /// Facts with an answer on its way: a second tap on the same card is ignored.
    public private(set) var answering: Set<Int> = []
    public private(set) var errorMessage: String?

    public init(server: any MacServer) { self.server = server }

    public func load() async {
        do {
            pending = try await server.pendingFacts()
            isLoaded = true
            errorMessage = nil
        } catch {
            errorMessage = MacBoard.describe(error)
        }
    }

    @discardableResult public func approve(_ fact: PendingFact) async -> Bool { await answer(fact, approve: true) }
    @discardableResult public func decline(_ fact: PendingFact) async -> Bool { await answer(fact, approve: false) }

    public func dismissError() { errorMessage = nil }

    private func answer(_ fact: PendingFact, approve: Bool) async -> Bool {
        guard answering.insert(fact.id).inserted else { return false }
        defer { answering.remove(fact.id) }
        do {
            if approve { try await server.approvePendingFact(id: fact.id) } else { try await server.declinePendingFact(id: fact.id) }
            pending.removeAll { $0.id == fact.id }
            errorMessage = nil
            return true
        } catch MacServerError.notFound {
            // Already answered somewhere else: it is gone from the Mac's queue too.
            pending.removeAll { $0.id == fact.id }
            errorMessage = "That fact was already answered somewhere else."
            return false
        } catch {
            errorMessage = MacBoard.describe(error)
            return false
        }
    }
}
