import Foundation
import Testing
@testable import OniCore

/// The Board and Memory screens' logic against a scripted Mac.
@MainActor @Suite struct MacBoardTests {
    private func board(_ tasks: [BoardTask] = []) async -> (MacBoard, FakeMacServer) {
        let server = FakeMacServer()
        await server.seedBoard(tasks)
        return (MacBoard(server: server), server)
    }

    @Test func loadingShowsEachColumnInTheMacsOrder() async {
        let (b, _) = await board([.make(id: "a", column: .todo, title: "A"), .make(id: "b", column: .done, title: "B"),
                                  .make(id: "c", column: .todo, title: "C")])
        await b.load()
        #expect(b.isLoaded && b.tasks(in: .todo).map(\.title) == ["A", "C"] && b.tasks(in: .done).map(\.title) == ["B"])
        #expect(b.tasks(in: .inReview).isEmpty)
    }

    @Test func addingATaskTrimsTheTitleAndRefusesAnEmptyOne() async {
        let (b, server) = await board()
        #expect(await b.add(title: "   ") == false)
        #expect(await b.add(title: "  Book flights  ", description: "HKG-LHR", priority: "high", column: .inProgress))
        #expect(b.tasks(in: .inProgress).map(\.title) == ["Book flights"] && b.tasks.first?.priority == "high")
        #expect(await server.board.count == 1)
    }

    @Test func movingATaskChangesItsColumnOnTheMacFirst() async {
        let (b, server) = await board([.make(id: "a", column: .todo, title: "A")])
        await b.load()
        let task = b.tasks[0]
        #expect(await b.move(task, to: .inReview))
        #expect(b.tasks(in: .inReview).map(\.id) == ["a"] && b.tasks(in: .todo).isEmpty)
        #expect(await server.board.first?.column == .inReview)
        #expect(await b.move(b.tasks[0], to: .inReview))                // already there: nothing to do
    }

    @Test func editingChangesTheTextAndKeepsTheRef() async {
        let (b, _) = await board([.make(id: "a", title: "Old", description: "x", ref: "ONI-7")])
        await b.load()
        #expect(await b.edit(b.tasks[0], title: "New", description: "y", priority: "low"))
        #expect(b.tasks[0].title == "New" && b.tasks[0].description == "y" && b.tasks[0].priority == "low" && b.tasks[0].ref == "ONI-7")
        #expect(await b.edit(b.tasks[0], title: " ", description: "", priority: "low") == false)
    }

    @Test func deletingRemovesItFromTheMacAndTheScreen() async {
        let (b, server) = await board([.make(id: "a", title: "A"), .make(id: "b", title: "B")])
        await b.load()
        #expect(await b.delete(b.tasks[0]))
        let remaining = await server.board.map(\.id)
        #expect(b.tasks.map(\.id) == ["b"] && remaining == ["b"])
    }

    @Test func aFailedChangeLeavesTheScreenAsItWasAndSaysWhy() async {
        let (b, server) = await board([.make(id: "a", title: "A")])
        await b.load()
        await server.failStore(with: MacServerError.unreachable("offline"))
        #expect(await b.move(b.tasks[0], to: .done) == false)
        #expect(b.tasks[0].column == .todo)                             // not moved on screen
        #expect(b.errorMessage?.contains("Can't reach your Mac") == true)
        b.dismissError()
        #expect(b.errorMessage == nil)
    }

    @Test func aTaskDeletedElsewhereIsReportedNotSilentlyKept() async {
        let (b, server) = await board([.make(id: "a", title: "A")])
        await b.load()
        try? await server.deleteBoardTask(id: "a")                      // the dashboard did it
        #expect(await b.move(b.tasks[0], to: .done) == false)
        #expect(b.errorMessage != nil)
        await b.load()
        #expect(b.tasks.isEmpty)
    }
}

@MainActor @Suite struct MacMemoryReviewTests {
    private func review(_ facts: [PendingFact]) async -> (MacMemoryReview, FakeMacServer) {
        let server = FakeMacServer()
        await server.seedFacts(facts)
        return (MacMemoryReview(server: server), server)
    }

    @Test func approvingOrDecliningRemovesTheCardAfterTheMacAccepts() async {
        let (r, server) = await review([.make(1, "Prefers tea", provenance: "chat on 2026-10-20"), .make(2, "Lives in Hong Kong")])
        await r.load()
        #expect(r.pending.map(\.id) == [1, 2] && r.pending[0].provenance == "chat on 2026-10-20")
        #expect(await r.approve(r.pending[0]))
        #expect(await r.decline(r.pending[0]))
        let left = await server.facts
        #expect(r.pending.isEmpty && left.isEmpty)
    }

    @Test func aFailedAnswerKeepsTheCardAndExplains() async {
        let (r, server) = await review([.make(1, "Prefers tea")])
        await r.load()
        await server.failStore(with: MacServerError.unreachable("offline"))
        #expect(await r.approve(r.pending[0]) == false)
        #expect(r.pending.count == 1 && r.errorMessage != nil)
        #expect(r.answering.isEmpty)                                    // can be tried again
    }

    @Test func aFactAnsweredOnTheDashboardFirstDropsOutWithAnExplanation() async {
        let (r, server) = await review([.make(1, "Prefers tea")])
        await r.load()
        try? await server.approvePendingFact(id: 1)
        #expect(await r.decline(r.pending[0]) == false)
        #expect(r.pending.isEmpty && r.errorMessage?.contains("already answered") == true)
    }
}

/// A fact is approved on what the card says, so the card must show all of it.
@Suite struct MemoryViewSourceTests {
    private static let memorySection: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Oni/Views/MacBoardViews.swift")
        let source = try! String(contentsOf: url, encoding: .utf8)
        return String(source[source.range(of: "// MARK: - Memory approvals")!.upperBound...])
    }()

    @Test(arguments: ["lineLimit", "truncationMode", "minimumScaleFactor", ".prefix(", ".hidden()", ".frame(height", ".frame(maxHeight"])
    func theFactIsNeverShortenedOrHidden(_ forbidden: String) {
        #expect(!Self.memorySection.contains(forbidden), "the memory screen uses \(forbidden)")
    }

    @Test func declineComesBeforeApprove() {
        let decline = Self.memorySection.range(of: "\"Decline\"")!.lowerBound
        let approve = Self.memorySection.range(of: "\"Approve\"")!.lowerBound
        #expect(decline < approve)
    }
}
