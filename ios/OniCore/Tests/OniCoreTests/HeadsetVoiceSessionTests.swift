import Foundation
import Testing
@testable import OniCore

/// A microphone that hands back whatever the test says it heard.
@MainActor final class FakeRecorder: VoiceRecorder {
    var canStart = true
    var heard: RecordedAudio? = RecordedAudio(samples: (0..<48_000).map { Float(sin(Double($0) * 0.05)) * 0.05 }, sampleRate: 48_000)
    private(set) var began = 0
    private(set) var ended = 0
    func beginCapture() -> Bool { began += 1; return canStart }
    func endCapture() -> RecordedAudio? { ended += 1; return heard }
}

/// Earbuds that record what they were asked to play. `play` waits until the
/// test releases it, so "the reply is being spoken" is a state a test can hold.
@MainActor final class FakeOutput: VoiceOutput {
    var canSpeakPrivately = true
    var holdPlayback = false
    private(set) var earcons: [Earcon] = []
    private(set) var played: [String] = []
    private(set) var said: [String] = []
    private(set) var stopped = 0
    private var release: CheckedContinuation<Void, Never>?

    func earcon(_ earcon: Earcon) { earcons.append(earcon) }
    func play(mp3: Data) async {
        played.append(String(decoding: mp3, as: UTF8.self))
        if holdPlayback { await withCheckedContinuation { release = $0 } }
    }
    func say(_ text: String) async { said.append(text) }
    func stop() { stopped += 1; release?.resume(); release = nil }
    func finishPlayback() { release?.resume(); release = nil }
}

@MainActor @Suite struct HeadsetVoiceSessionTests {
    private let user = MacMessage.make("user", "what is next")
    private func reply(_ text: String) -> MacMessage { MacMessage.make("assistant", text) }

    private struct Rig {
        let voice: HeadsetVoiceSession
        let chat: MacChatSession
        let server: FakeMacServer
        let recorder: FakeRecorder
        let output: FakeOutput
    }

    private func rig(
        streams: [FakeMacServer.Script] = [.init(frames: [.message("It is at three.")])],
        histories: [Result<[MacMessage], any Error>]? = nil,
        transcripts: [Result<String, any Error>] = [.success("what is next")],
        maxRecording: Duration = .seconds(60)
    ) async -> Rig {
        let server = FakeMacServer(
            streams: streams,
            states: [.success(.idle())],
            histories: histories ?? [.success([user, reply("It is at three.")])])
        await server.scriptTranscripts(transcripts)
        let driver = MacTurnDriver(server: server, pollInterval: .milliseconds(1), maxMisses: 3, sleep: { _ in await Task.yield() })
        let chat = MacChatSession(threadId: "voice", server: server, driver: driver)
        let recorder = FakeRecorder()
        let output = FakeOutput()
        let voice = HeadsetVoiceSession(server: server, chat: chat, recorder: recorder, output: output, maxRecording: maxRecording)
        voice.arm()
        return Rig(voice: voice, chat: chat, server: server, recorder: recorder, output: output)
    }

    private func wait(for phase: HeadsetVoiceSession.Phase, in voice: HeadsetVoiceSession) async {
        for _ in 0..<2000 where voice.phase != phase { try? await Task.sleep(for: .milliseconds(2)) }
    }

    private func settle(_ voice: HeadsetVoiceSession) async { await wait(for: .idle, in: voice) }

    @Test func aWholeRoundTripFromTwoPresses() async {
        let r = await rig()
        r.voice.press()
        #expect(r.voice.phase == .recording)
        r.voice.press()
        #expect(r.voice.phase == .transcribing)
        await settle(r.voice)

        #expect(r.output.earcons == [.started, .stopped])
        let sent = await r.server.transcribed
        #expect(sent.count == 1 && sent[0].filename == "voice.wav" && sent[0].mimeType == "audio/wav")
        #expect(sent[0].wav.prefix(4) == Data("RIFF".utf8))
        #expect(await r.server.requests == [.headsetChat(message: "what is next", threadId: "voice")])
        #expect(await r.server.spoken == ["It is at three."])
        #expect(r.output.played == ["mp3:It is at three."])
        #expect(r.voice.heard == "what is next" && r.voice.reply == "It is at three.")
        #expect(r.voice.phase == .idle)
    }

    @Test func theAppIsToldWhenATurnEndsSoPausedMusicCanComeBack() async {
        let r = await rig()
        var idles = 0
        r.voice.onIdle = { idles += 1 }
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        #expect(idles == 1)
        // A cancelled recording-to-thinking turn ends it too, and so does disarming.
        r.voice.press()          // recording
        r.voice.disarm()
        #expect(idles == 2)
    }

    @Test func pressesDoNothingUntilArmedOrAfterItIsDisarmed() async {
        let r = await rig()
        r.voice.disarm()
        r.voice.press()
        #expect(r.voice.phase == .off && r.recorder.began == 0)
        r.voice.arm()
        r.voice.press()
        #expect(r.voice.phase == .recording)
        r.voice.disarm()
        #expect(r.voice.phase == .off && r.recorder.ended == 1)
    }

    @Test func aMicrophoneThatIsNotRunningIsAnErrorBeepNotARecording() async {
        let r = await rig()
        r.recorder.canStart = false
        r.voice.press()
        #expect(r.voice.phase == .idle && r.output.earcons == [.error])
        #expect(r.voice.notice?.contains("arm it again") == true)
    }

    @Test func silenceIsNeverSentToTheMac() async {
        let r = await rig()
        r.recorder.heard = RecordedAudio(samples: Array(repeating: 0, count: 48_000), sampleRate: 48_000)
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        let transcribed = await r.server.transcribed
        let requests = await r.server.requests
        #expect(transcribed.isEmpty && requests.isEmpty)
        #expect(await r.server.spoken == ["I didn't catch that."])
    }

    @Test func aTranscriptThatComesBackEmptyStartsNoTurn() async {
        let r = await rig(transcripts: [.success("   ")])
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        let requests = await r.server.requests
        #expect(requests.isEmpty)
        #expect(await r.server.spoken == ["I didn't catch that."])
    }

    @Test func aTranscriptionFailureIsAnErrorBeepAndTheNextPressStartsOver() async {
        let r = await rig(transcripts: [.failure(MacServerError.unreachable("offline"))])
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        #expect(r.output.earcons == [.started, .stopped, .error])
        #expect(r.voice.notice?.contains("Can't reach your Mac") == true)
        r.voice.press()
        #expect(r.voice.phase == .recording)
    }

    @Test func aPressWhileThinkingCancelsAndStopsTheTurnOnTheMac() async {
        // A stream that never produces a message keeps the turn running.
        let r = await rig(streams: [.init(frames: [.token("Let me")], thenThrow: nil)], histories: [.success([user])])
        r.voice.press(); r.voice.press()
        await wait(for: .thinking, in: r.voice)
        #expect(r.voice.phase == .thinking)
        r.voice.press()
        #expect(r.voice.phase == .idle && r.output.earcons.last == .cancelled)
        for _ in 0..<500 { if await r.server.stopCalls == 0 { try? await Task.sleep(for: .milliseconds(2)) } else { break } }
        #expect(await r.server.stopCalls == 1)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(r.output.played.isEmpty && r.output.said.isEmpty)
    }

    @Test func aPressWhileOniIsSpeakingInterruptsAndStartsListening() async {
        let r = await rig()
        r.output.holdPlayback = true
        r.voice.press(); r.voice.press()
        await wait(for: .speaking, in: r.voice)
        for _ in 0..<500 where r.output.played.isEmpty { try? await Task.sleep(for: .milliseconds(2)) }
        #expect(r.voice.phase == .speaking)
        r.voice.press()
        #expect(r.output.stopped == 1)
        #expect(r.voice.phase == .recording && r.recorder.began == 2)
    }

    @Test func aConfirmationIsNeverAnsweredByVoiceOnlyAnnounced() async throws {
        let gate = try #require(Gate.parse(["action": "send_imessage", "recipient": "+1555", "message": "hi"]))
        let r = await rig(streams: [.init(frames: [.interrupt(gate)])], histories: [.success([user])])
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        #expect(await r.server.spoken == ["That needs your approval. It's waiting on your phone screen."])
        // A press must not approve it: no /resume was ever sent.
        let sentRequests = await r.server.requests
        #expect(sentRequests.allSatisfy { if case .resume = $0 { false } else { true } })
        if case .awaitingApproval = r.chat.phase {} else { Issue.record("the gate should still be waiting on the screen") }
        // And a second spoken request is refused, out loud, while it waits.
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        #expect(await r.server.spoken.last == "There's an approval waiting on your phone screen first.")
        let afterwards = await r.server.requests
        #expect(afterwards.count == 1)
    }

    @Test func ifTheMacCannotMakeTheVoiceThePhonesOwnVoiceReadsTheReply() async {
        let r = await rig()
        await r.server.failSpeech(with: MacServerError.server(status: 503, message: "no key"))
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        #expect(r.output.played.isEmpty)
        #expect(r.output.said == ["It is at three."])
    }

    @Test func withTheEarbudsOutTheReplyIsNotReadAloudToTheRoom() async {
        let r = await rig()
        r.output.canSpeakPrivately = false
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        let spokenByTheMac = await r.server.spoken
        #expect(spokenByTheMac.isEmpty && r.output.played.isEmpty && r.output.said.isEmpty)
        #expect(r.voice.notice?.contains("on your screen") == true)
        #expect(r.voice.reply == "It is at three.")
    }

    @Test func aReplyThatIsOnlyACardIsAnnouncedNotReadOut() async {
        let card = MacMessage.make("assistant", "", surfaces: [[
            "surfaceId": "s1",
            "components": [["id": "root", "component": "Text", "text": "Hello"]],
        ]])
        let r = await rig(histories: [.success([user, card])])
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        #expect(await r.server.spoken == ["I put that on your screen."])
    }

    @Test func aLongReplyIsSpokenInOrderPieceByPiece() async {
        let long = Array(repeating: "This is one fairly ordinary sentence of about this length.", count: 8).joined(separator: " ")
        let r = await rig(histories: [.success([user, reply(long)])])
        r.voice.press(); r.voice.press()
        await settle(r.voice)
        let spoken = await r.server.spoken
        #expect(spoken.count >= 2)
        #expect(r.output.played == spoken.map { "mp3:\($0)" })
        #expect(spoken.joined(separator: " ") == long)
    }

    @Test func aTurnAlreadyRunningElsewhereIsSaidOutLoudNotQueued() async {
        let r = await rig()
        r.chat.send("typed on the phone")                  // a turn is running
        r.voice.press(); r.voice.press()
        await wait(for: .idle, in: r.voice)
        #expect(await r.server.spoken.contains("Oni is still working on the last request."))
    }

    @Test func aRecordingThatRunsTooLongIsCutOffAndStillSent() async {
        let r = await rig(maxRecording: .milliseconds(20))
        r.voice.press()
        await settle(r.voice)
        for _ in 0..<500 { if await r.server.transcribed.isEmpty { try? await Task.sleep(for: .milliseconds(2)) } else { break } }
        #expect(r.output.earcons.starts(with: [.started, .stopped]))
        #expect(r.voice.notice?.contains("long one") == true || r.voice.heard == "what is next")
        #expect(await r.server.transcribed.count == 1)
    }
}
