import Foundation
import Testing
@testable import OniCore

/// The reconnect logic: a turn survives the phone's connection dropping,
/// because the Mac keeps running it (PLAN.md Phase 31 D7).
@Suite struct MacTurnDriverTests {
    private let chat = TurnRequest.chat(message: "hi", threadId: "t1", attachments: [])
    private let gate: JSONValue = ["action": "send_imessage", "recipient": "+1555", "message": "hello"]

    private func driver(_ server: FakeMacServer, maxMisses: Int = 3) -> MacTurnDriver {
        MacTurnDriver(server: server, pollInterval: .milliseconds(1), maxMisses: maxMisses, sleep: { _ in await Task.yield() })
    }

    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [TurnProgress] = []
        func add(_ p: TurnProgress) { lock.lock(); items.append(p); lock.unlock() }
        var all: [TurnProgress] { lock.lock(); defer { lock.unlock() }; return items }
    }

    private func run(_ driver: MacTurnDriver, _ request: TurnRequest) async -> (TurnOutcome, [TurnProgress]) {
        let seen = Seen()
        let outcome = await driver.run(request, progress: { seen.add($0) })
        return (outcome, seen.all)
    }

    @Test func aTurnThatFinishesOnItsOwnStreamIsAReply() async {
        let server = FakeMacServer(streams: [.init(frames: [.token("Hi"), .message("Hi there")])])
        let (outcome, progress) = await run(driver(server), chat)
        #expect(outcome == .replied)
        #expect(progress == [.frame(.token("Hi")), .frame(.message("Hi there"))])
        #expect(await server.turnStateCalls == 0)
    }

    @Test func anErrorFrameIsAFailureWithTheMacsWords() async {
        let server = FakeMacServer(streams: [.init(frames: [.error("RateLimitError: slow down")])])
        #expect(await run(driver(server), chat).0 == .failed("RateLimitError: slow down"))
    }

    @Test func aGateFrameStopsTheTurnAtTheCard() async throws {
        let parsed = try #require(Gate.parse(gate))
        let server = FakeMacServer(streams: [.init(frames: [.interrupt(parsed)])])
        #expect(await run(driver(server), chat).0 == .needsApproval(parsed))
    }

    @Test func aGateTheAppCannotReadIsReportedSoItCanBeDeclined() async {
        let server = FakeMacServer(streams: [.init(frames: [.unreadableInterrupt])])
        #expect(await run(driver(server), chat).0 == .unreadableApproval)
    }

    @Test func aDroppedLinkKeepsWatchingUntilTheMacFinishes() async {
        let server = FakeMacServer(
            streams: [.init(frames: [.token("Working")])],            // ends with no terminal frame
            states: [.success(.running), .success(.running), .success(.idle("completed"))])
        let (outcome, progress) = await run(driver(server), chat)
        #expect(outcome == .replied)
        #expect(progress.contains(.reconnecting))
        #expect(await server.turnStateCalls == 3)
    }

    @Test func aDroppedLinkThenAnErrorOnTheMacIsAFailureNotASilence() async {
        let server = FakeMacServer(
            streams: [.init()], states: [.success(.idle("error", detail: "ToolError: boom"))])
        #expect(await run(driver(server), chat).0 == .failed("ToolError: boom"))
    }

    @Test func aDroppedLinkThenAStopIsAStop() async {
        let server = FakeMacServer(streams: [.init()], states: [.success(.idle("cancelled"))])
        #expect(await run(driver(server), chat).0 == .stopped)
    }

    @Test func aTurnThatPausedAtAGateWhileTheLinkWasDownShowsTheSameCard() async throws {
        let parsed = try #require(Gate.parse(gate))
        let server = FakeMacServer(streams: [.init()], states: [.success(.running), .success(.waiting(gate))])
        #expect(await run(driver(server), chat).0 == .needsApproval(parsed))
    }

    @Test func aWaitingGateTheAppCannotReadIsNeverShownBlind() async {
        let server = FakeMacServer(streams: [.init()], states: [.success(.waiting("just text"))])
        #expect(await run(driver(server), chat).0 == .unreadableApproval)
    }

    @Test func theMacGoingQuietForTooLongIsLostContactNotAFailure() async {
        let server = FakeMacServer(
            streams: [.init(frames: [.token("x")])],
            states: [.failure(MacServerError.unreachable("offline"))])
        let (outcome, _) = await run(driver(server, maxMisses: 3), chat)
        #expect(outcome == .lostContact)
        #expect(await server.turnStateCalls == 3)
    }

    @Test func aBlipWhilePollingIsToleratedAndTheMissCountResets() async {
        let blip: Result<TurnState, any Error> = .failure(MacServerError.unreachable("blip"))
        let server = FakeMacServer(
            streams: [.init()],
            states: [blip, blip, .success(.running), blip, blip, .success(.idle("completed"))])
        #expect(await run(driver(server, maxMisses: 3), chat).0 == .replied)
    }

    @Test func startingOnABusyThreadWatchesTheTurnAlreadyRunning() async {
        let server = FakeMacServer(
            streams: [.init(thenThrow: MacServerError.busy)],
            states: [.success(.running), .success(.idle("completed"))])
        #expect(await run(driver(server), chat).0 == .replied)
    }

    @Test func aMacThatIsUnreachableAtTheStartIsLostContact() async {
        let server = FakeMacServer(streams: [.init(thenThrow: MacServerError.unreachable("offline"))])
        #expect(await run(driver(server), chat).0 == .lostContact)
    }

    @Test func aThreadThatNoLongerExistsIsAFailure() async {
        let server = FakeMacServer(
            streams: [.init(thenThrow: MacServerError.notFound("gone"))])
        guard case .failed = await run(driver(server), chat).0 else { Issue.record("expected a failure"); return }
    }

    @Test func reopeningAThreadFindsAFinishedTurnAndAWaitingCard() async throws {
        let done = FakeMacServer(states: [.success(.idle("completed"))])
        #expect(await driver(done).watch(threadId: "t1", progress: { _ in }) == .replied)

        let parsed = try #require(Gate.parse(gate))
        let waiting = FakeMacServer(states: [.success(.waiting(gate))])
        #expect(await driver(waiting).watch(threadId: "t1", progress: { _ in }) == .needsApproval(parsed))
    }

    @Test func anAnswerIsSentOnlyWhileTheMacIsStillWaitingOnThatExactCard() async throws {
        let parsed = try #require(Gate.parse(gate))
        let still = FakeMacServer(streams: [.init(frames: [.message("Sent.")])], states: [.success(.waiting(gate))])
        #expect(await driver(still).answer(approved: true, expecting: parsed, threadId: "t1", progress: { _ in }) == .replied)
        #expect(await still.requests == [.resume(approved: true, threadId: "t1")])

        for state in [TurnState.idle("completed"), .running, .waiting(["action": "send_imessage", "recipient": "+1999", "message": "x"])] {
            let moved = FakeMacServer(states: [.success(state)])
            #expect(await driver(moved).answer(approved: true, expecting: parsed, threadId: "t1", progress: { _ in }) == .staleApproval)
            #expect(await moved.requests.isEmpty)
        }

        let silent = FakeMacServer(states: [.failure(MacServerError.unreachable("offline"))])
        #expect(await driver(silent).answer(approved: true, expecting: parsed, threadId: "t1", progress: { _ in }) == .lostContact)
        #expect(await silent.requests.isEmpty)
    }

    @Test func theApprovalGoesOutAsAResumeForTheSameThread() async {
        let server = FakeMacServer(streams: [.init(frames: [.message("Sent.")])])
        let (outcome, _) = await run(driver(server), .resume(approved: true, threadId: "t9"))
        #expect(outcome == .replied)
        #expect(await server.requests == [.resume(approved: true, threadId: "t9")])
    }
}

@Suite struct MacTranscriptTests {
    private func message(_ role: String, _ content: String, synthetic: Bool = false, surfaces: [JSONValue] = []) -> MacMessage {
        try! MacMessage(.object([
            "role": .string(role), "content": .string(content), "synthetic": .bool(synthetic), "surfaces": .array(surfaces),
        ]))
    }

    private let surface: JSONValue = ["surfaceId": "s1", "components": [["id": "root", "component": "Text", "text": "hi"]]]

    @Test func onlyRealDialogueIsShown() {
        let items = MacTranscript.items(from: [
            message("user", "Known facts: …", synthetic: true),
            message("user", "Hello"),
            message("assistant", ""),                        // a tool-call-only turn
            message("tool", "result text"),
            message("assistant", "Hi there"),
        ])
        #expect(items == [.user(id: 1, text: "Hello"), .assistant(id: 4, text: "Hi there", surfaces: [], skippedSurfaces: 0)])
    }

    @Test func surfacesFromToolRowsRideOnTheReplyThatClosesTheTurn() throws {
        let items = MacTranscript.items(from: [
            message("user", "show me"),
            message("tool", "rendered", surfaces: [surface]),
            message("assistant", "Here you go"),
        ])
        guard case .assistant(_, "Here you go", let surfaces, 0) = items.last else { Issue.record("got \(items)"); return }
        #expect(surfaces.map(\.surfaceId) == ["s1"])
    }

    @Test func aReplyWithOnlyASurfaceStaysVisible() {
        let items = MacTranscript.items(from: [message("user", "x"), message("tool", "", surfaces: [surface]), message("assistant", "")])
        #expect(items.count == 2)
    }

    @Test func anInvalidSurfaceIsNeverDrawnButIsCounted() {
        let bad: JSONValue = ["surfaceId": "s", "components": [["id": "root", "component": "Button", "child": "root", "action": ["name": "x", "functionCall": [:]]]]]
        let items = MacTranscript.items(from: [message("tool", "", surfaces: [bad]), message("assistant", "Done")])
        #expect(items == [.assistant(id: 1, text: "Done", surfaces: [], skippedSurfaces: 1)])
    }

    @Test func surfacesDoNotLeakIntoTheNextTurn() {
        let items = MacTranscript.items(from: [
            message("tool", "", surfaces: [surface]), message("assistant", "first"),
            message("user", "again"), message("assistant", "second"),
        ])
        guard case .assistant(_, "second", let later, 0) = items.last else { Issue.record("got \(items)"); return }
        #expect(later.isEmpty)
    }

    @Test func activityLabelsNameTheAgentAndTheTool() {
        func label(_ phase: AgentActivity.Phase, _ agent: String, _ tool: String) -> String? {
            MacActivityLabel.text(for: AgentActivity(phase: phase, agent: agent, tool: tool))
        }
        #expect(label(.toolStart, "research_agent", "web_search") == "Research: web search")
        #expect(label(.toolStart, "supervisor", "request_gated_action_confirmation") == "request gated action confirmation")
        #expect(label(.toolStart, "mac_control_agent", "open_url_in_brave") == "Mac control: open url in brave")
        #expect(label(.toolEnd, "research_agent", "web_search") == nil)
    }
}
