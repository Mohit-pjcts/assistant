import Foundation
import Testing
@testable import OniCore

/// The screen's state machine, against a scripted Mac: what the person sees
/// when a turn finishes, pauses at a confirmation, drops, or is picked up again.
@MainActor @Suite struct MacChatSessionTests {
    private let gatePayload: JSONValue = ["action": "send_imessage", "recipient": "+1555", "message": "hello"]
    private let user = MacMessage.make("user", "hi")
    private let reply = MacMessage.make("assistant", "Hello!")

    private func session(_ server: FakeMacServer) -> MacChatSession {
        let driver = MacTurnDriver(server: server, pollInterval: .milliseconds(1), maxMisses: 3, sleep: { _ in await Task.yield() })
        return MacChatSession(threadId: "t1", server: server, driver: driver)
    }

    /// Waits for the session to leave the busy phases.
    private func settle(_ s: MacChatSession) async {
        for _ in 0..<2000 where s.isBusy { try? await Task.sleep(for: .milliseconds(2)) }
    }

    @Test func aFinishedTurnShowsTheMacsHistoryAndClearsTheLiveState() async {
        let server = FakeMacServer(
            streams: [.init(frames: [.activity(AgentActivity(phase: .toolStart, agent: "research_agent", tool: "web_search")),
                                     .token("Hel"), .message("Hello!")])],
            histories: [.success([user, reply])])
        let s = session(server)
        s.send("hi")
        #expect(s.phase == .running && s.pendingUser == "hi")
        await settle(s)
        #expect(s.phase == .idle && s.pendingUser == nil && s.liveText == "" && s.activity == nil)
        #expect(s.items == [.user(id: 0, text: "hi"), .assistant(id: 1, text: "Hello!", surfaces: [], skippedSurfaces: 0)])
        #expect(await server.requests == [.chat(message: "hi", threadId: "t1", attachments: [])])
    }

    @Test func emptyOrWhitespaceMessagesAreNotSentAndNeitherIsASecondWhileBusy() async {
        let server = FakeMacServer(streams: [.init(frames: [.message("ok")])], histories: [.success([user, reply])])
        let s = session(server)
        s.send("   \n")
        #expect(s.phase == .idle)
        s.send("first")
        s.send("second")                                   // ignored: a turn is running
        await settle(s)
        #expect(await server.requests.count == 1)
    }

    @Test func aConfirmationPausesTheTurnAndOneAnswerGoesOutOnce() async throws {
        let gate = try #require(Gate.parse(gatePayload))
        let server = FakeMacServer(
            streams: [.init(frames: [.interrupt(gate)]), .init(frames: [.message("Sent.")])],
            histories: [.success([user]), .success([user, MacMessage.make("assistant", "Sent.")])])
        let s = session(server)
        s.send("text her")
        await settle(s)
        #expect(s.phase == .awaitingApproval(gate))

        s.send("meanwhile")                                // cannot talk past a pending card
        s.answer(approved: true)
        s.answer(approved: true)                           // a second tap changes nothing
        await settle(s)
        #expect(s.phase == .idle)
        #expect(await server.requests == [
            .chat(message: "text her", threadId: "t1", attachments: []),
            .resume(approved: true, threadId: "t1"),
        ])
    }

    @Test func decliningSendsADecline() async throws {
        let gate = try #require(Gate.parse(gatePayload))
        let server = FakeMacServer(streams: [.init(frames: [.interrupt(gate)]), .init(frames: [.message("Okay.")])])
        let s = session(server)
        s.send("x")
        await settle(s)
        s.answer(approved: false)
        await settle(s)
        #expect(await server.requests.last == .resume(approved: false, threadId: "t1"))
    }

    @Test func aConfirmationThePhoneCannotReadIsDeclinedNotApproved() async {
        let server = FakeMacServer(streams: [.init(frames: [.unreadableInterrupt]), .init(frames: [.message("Okay.")])])
        let s = session(server)
        s.send("x")
        await settle(s)
        #expect(await server.requests.last == .resume(approved: false, threadId: "t1"))
        #expect(s.notice?.contains("declined") == true)
        #expect(await server.requests.contains(.resume(approved: true, threadId: "t1")) == false)
    }

    @Test func aDroppedLinkIsFollowedToTheEndAndTheAnswerAppears() async {
        let server = FakeMacServer(
            streams: [.init(frames: [.token("Wor")])],
            states: [.success(.running), .success(.idle("completed"))],
            histories: [.success([user, reply])])
        let s = session(server)
        s.send("hi")
        await settle(s)
        #expect(s.phase == .idle)
        #expect(s.items.count == 2)
        #expect(s.errorMessage == nil)
    }

    @Test func aFailureOnTheMacIsShownInItsOwnWords() async {
        let server = FakeMacServer(streams: [.init(frames: [.error("RateLimitError: slow down")])])
        let s = session(server)
        s.send("hi")
        await settle(s)
        #expect(s.phase == .idle && s.errorMessage == "RateLimitError: slow down")
    }

    @Test func stoppingShowsAStopNotAnError() async {
        let server = FakeMacServer(streams: [.init()], states: [.success(.idle("cancelled"))])
        let s = session(server)
        s.send("hi")
        await s.stop()
        await settle(s)
        #expect(await server.stopCalls == 1)
        #expect(s.phase == .idle && s.notice == "Stopped." && s.errorMessage == nil)
    }

    @Test func losingTheMacKeepsTheMessageAndReopeningFindsTheFinishedAnswer() async {
        let down: Result<TurnState, any Error> = .failure(MacServerError.unreachable("offline"))
        let server = FakeMacServer(
            streams: [.init(frames: [.token("x")])],
            states: [down, down, down, .success(.idle("completed"))],
            histories: [.success([user, reply])])
        let s = session(server)
        s.send("hi")
        await settle(s)
        #expect(s.phase == .lostContact && s.pendingUser == "hi")

        await s.reattach()                                  // the app returned to the foreground
        await settle(s)
        #expect(s.phase == .idle && s.pendingUser == nil && s.items.count == 2)
    }

    @Test func reopeningAThreadThatIsWaitingForApprovalShowsTheCard() async throws {
        let gate = try #require(Gate.parse(gatePayload))
        let server = FakeMacServer(states: [.success(.waiting(gatePayload))], histories: [.success([user])])
        let s = session(server)
        await s.open()
        #expect(s.phase == .awaitingApproval(gate) && s.items.count == 1)
    }

    @Test func reopeningAThreadWithAnUnreadableWaitingGateDeclinesIt() async {
        let server = FakeMacServer(streams: [.init(frames: [.message("Okay.")])], states: [.success(.waiting("just text"))])
        let s = session(server)
        await s.open()
        await settle(s)
        #expect(await server.requests == [.resume(approved: false, threadId: "t1")])
    }

    @Test func reopeningAThreadStillRunningFollowsItToTheEnd() async {
        let server = FakeMacServer(
            states: [.success(.running), .success(.running), .success(.idle("completed"))],
            histories: [.success([user]), .success([user, reply])])
        let s = session(server)
        await s.open()
        #expect(s.isBusy)
        await settle(s)
        #expect(s.phase == .idle && s.items.count == 2)
    }

    @Test func aMessageSentToAThreadBusyElsewhereIsNotPretendedToBeSent() async {
        let server = FakeMacServer(
            streams: [.init(thenThrow: MacServerError.busy)],
            states: [.success(.running), .success(.idle("completed"))],
            histories: [.success([user, reply])])
        let s = session(server)
        s.send("also this")
        await settle(s)
        #expect(s.pendingUser == nil)
        #expect(s.notice?.contains("not sent") == true)
    }

    @Test func buttonPressesGoOutAsAnA2UIActionTurn() async {
        let server = FakeMacServer(streams: [.init(frames: [.message("Done.")])])
        let s = session(server)
        s.pressButton(surfaceId: "s1", name: "go", context: ["x": "1"])
        await settle(s)
        #expect(await server.requests == [.a2uiAction(surfaceId: "s1", name: "go", context: ["x": "1"], threadId: "t1")])
    }

    @Test func openingWhileAlreadyFollowingATurnDoesNotStartASecondWatcher() async {
        let server = FakeMacServer(
            states: [.success(.running), .success(.running), .success(.running), .success(.idle("completed"))],
            histories: [.success([user, reply])])
        let s = session(server)
        await s.open()
        await s.open()
        await s.open()
        await settle(s)
        #expect(s.phase == .idle)
    }
}
