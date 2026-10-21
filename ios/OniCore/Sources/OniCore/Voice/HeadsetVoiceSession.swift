import Foundation
import Observation

/// A short sound that says what just happened, for a phone nobody is looking at.
public enum Earcon: Sendable, Equatable {
    case started    // recording began
    case stopped    // recording ended
    case error      // that press did not do what was asked
    case cancelled  // a request was dropped
}

/// The earbud microphone, kept running while the phone is armed (PLAN.md Phase
/// 32, STEPS.md 184: iOS will not start a microphone from the background).
@MainActor
public protocol VoiceRecorder: AnyObject {
    /// Starts keeping what the microphone hears. False if no microphone is running.
    func beginCapture() -> Bool
    /// Stops keeping it and hands it over.
    func endCapture() -> RecordedAudio?
}

/// Everything the person hears.
@MainActor
public protocol VoiceOutput: AnyObject {
    /// False when the sound would come out of the phone's own speaker (earbuds
    /// out): a reply is not read aloud to the room.
    var canSpeakPrivately: Bool { get }
    func earcon(_ earcon: Earcon)
    /// Plays MP3 audio; returns when it has finished or `stop()` was called.
    func play(mp3: Data) async
    /// Speaks text with the phone's own voice; same return rule as `play`.
    func say(_ text: String) async
    func stop()
}

/// The earbud-button voice conversation (PLAN.md Phase 32): one press starts
/// listening, the next sends what was said to the Mac and reads the answer back.
///
/// ```
///   off ──arm──▶ idle ──press──▶ recording ──press──▶ transcribing ──▶ thinking ──▶ speaking ──▶ idle
///                                                          press = cancel   press = stop the turn   press = interrupt and talk
/// ```
///
/// A confirmation gate is never answered here: the voice says it is waiting and
/// the card on the phone screen is the only way to answer (PLAN.md Phase 32).
@MainActor @Observable
public final class HeadsetVoiceSession {
    public enum Phase: Equatable, Sendable {
        case off, idle, recording, transcribing, thinking, speaking
    }

    public private(set) var phase: Phase = .off
    /// What was last heard from the microphone, and Oni's last spoken reply.
    public private(set) var heard: String?
    public private(set) var reply: String?
    public private(set) var notice: String?
    /// One line per step (what was heard, what will be said), for the app's log.
    public var onEvent: (@MainActor (String) -> Void)?
    /// Called whenever a voice turn ends or is cancelled and the session is
    /// listening-ready again (the app gives paused music back here).
    public var onIdle: (@MainActor () -> Void)?

    private let server: any MacServer
    private let chat: MacChatSession
    private let recorder: any VoiceRecorder
    private let output: any VoiceOutput
    private let maxRecording: Duration
    private var work: Task<Void, Never>?
    private var limit: Task<Void, Never>?
    private var generation = 0

    public init(
        server: any MacServer, chat: MacChatSession, recorder: any VoiceRecorder, output: any VoiceOutput,
        maxRecording: Duration = .seconds(60)
    ) {
        self.server = server
        self.chat = chat
        self.recorder = recorder
        self.output = output
        self.maxRecording = maxRecording
    }

    public var isArmed: Bool { phase != .off }

    public func arm() {
        guard phase == .off else { return }
        phase = .idle
        notice = nil
    }

    public func disarm() {
        output.stop()
        cancelWork()
        if phase == .recording { _ = recorder.endCapture() }
        phase = .off
        onIdle?()
    }

    /// The earbud button.
    public func press() {
        switch phase {
        case .off: break
        case .idle: startRecording()
        case .recording: finishRecording()
        case .transcribing:
            cancelWork()
            output.earcon(.cancelled)
            goIdle()
        case .thinking:
            cancelWork()
            output.earcon(.cancelled)
            goIdle()
            Task { await chat.stop() }
        case .speaking:
            // Pressing while Oni talks is "stop, I have something to say".
            output.stop()
            cancelWork()
            goIdle()
            startRecording()
        }
    }

    // MARK: recording

    private func startRecording() {
        notice = nil
        guard recorder.beginCapture() else {
            output.earcon(.error)
            notice = "The microphone isn't running. Open Oni and arm it again."
            return
        }
        output.earcon(.started)
        phase = .recording
        limit?.cancel()
        let longest = maxRecording
        limit = Task { [weak self] in
            try? await Task.sleep(for: longest)
            guard !Task.isCancelled else { return }
            self?.recordingTimedOut()
        }
    }

    private func recordingTimedOut() {
        guard phase == .recording else { return }
        notice = "That was a long one, so I stopped listening."
        finishRecording()
    }

    private func finishRecording() {
        limit?.cancel()
        output.earcon(.stopped)
        guard let audio = recorder.endCapture() else {
            output.earcon(.error)
            notice = "I didn't hear anything."
            goIdle()
            return
        }
        phase = .transcribing
        startWork { session, generation in await session.process(audio, generation: generation) }
    }

    // MARK: one request

    private func process(_ audio: RecordedAudio, generation mine: Int) async {
        guard let wav = VoicePrep.wav(from: audio) else {
            onEvent?("recording was too short or silent; not sent")
            await speak("I didn't catch that.", generation: mine)
            return settle(mine)
        }
        let text: String
        do {
            text = try await server.transcribe(audio: wav, filename: "voice.wav", mimeType: "audio/wav")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            guard isCurrent(mine) else { return }
            output.earcon(.error)
            notice = (error as? MacServerError)?.description ?? "I couldn't turn that into text."
            onEvent?("transcription failed: \(error)")
            return settle(mine)
        }
        guard isCurrent(mine) else { return }
        guard !text.isEmpty else {
            await speak("I didn't catch that.", generation: mine)
            return settle(mine)
        }
        heard = text
        reply = nil
        onEvent?("heard: \(text)")
        phase = .thinking

        let before = chat.items.count
        guard chat.sendSpoken(text) else {
            let phrase: String
            if case .awaitingApproval = chat.phase {
                phrase = "There's an approval waiting on your phone screen first."
            } else {
                phrase = "Oni is still working on the last request."
            }
            await speak(phrase, generation: mine)
            return settle(mine)
        }
        await chat.finishedTurn()
        guard isCurrent(mine) else { return }

        guard let spoken = replyToSpeak(newItemsAfter: before) else { return settle(mine) }
        reply = spoken
        onEvent?("reply: \(spoken.prefix(120))")
        phase = .speaking
        await speak(spoken, generation: mine)
        settle(mine)
    }

    /// What to say once the turn is over, or nil for silence.
    private func replyToSpeak(newItemsAfter before: Int) -> String? {
        switch chat.phase {
        case .awaitingApproval:
            return "That needs your approval. It's waiting on your phone screen."
        case .lostContact:
            return "I lost contact with your Mac."
        default:
            break
        }
        if chat.errorMessage != nil { return "Something went wrong. Check the Oni app." }
        if chat.notice == "Stopped." { return nil }
        for item in chat.items.dropFirst(before).reversed() {
            guard case .assistant(_, let text, let surfaces, _) = item else { continue }
            if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
            if !surfaces.isEmpty { return "I put that on your screen." }
        }
        return nil
    }

    // MARK: speaking

    /// Reads `text` aloud: the first piece starts playing as soon as it is made
    /// while the next is fetched; if the Mac cannot make the voice, the phone's
    /// own voice takes over for the rest.
    private func speak(_ text: String, generation mine: Int) async {
        guard isCurrent(mine) else { return }
        guard output.canSpeakPrivately else {
            notice = "Earbuds aren't connected, so the reply is on your screen."
            return
        }
        if phase == .transcribing || phase == .thinking { phase = .speaking }
        let (pieces, _) = SpokenReply.pieces(text)
        let server = self.server
        var fetches: [Int: Task<Data?, Never>] = [:]
        defer { for task in fetches.values { task.cancel() } }
        func fetch(_ index: Int) {
            guard index < pieces.count, fetches[index] == nil else { return }
            let piece = pieces[index]
            fetches[index] = Task { try? await server.speak(text: piece) }
        }
        fetch(0)
        var phoneVoiceOnly = false
        for index in pieces.indices {
            fetch(index + 1)
            let audio = phoneVoiceOnly ? nil : await fetches[index]?.value
            guard isCurrent(mine) else { return }
            if let audio {
                await output.play(mp3: audio)
            } else {
                phoneVoiceOnly = true
                for task in fetches.values { task.cancel() }
                await output.say(pieces[index])
            }
            guard isCurrent(mine) else { return }
        }
    }

    // MARK: plumbing

    private func startWork(_ body: @escaping @MainActor (HeadsetVoiceSession, Int) async -> Void) {
        work?.cancel()
        generation += 1
        let mine = generation
        work = Task { [weak self] in
            guard let self else { return }
            await body(self, mine)
        }
    }

    private func cancelWork() {
        limit?.cancel()
        work?.cancel()
        work = nil
        generation += 1
    }

    private func goIdle() {
        phase = .idle
        onIdle?()
    }

    private func isCurrent(_ mine: Int) -> Bool { mine == generation && !Task.isCancelled }

    /// Back to listening-ready, unless something newer has taken over.
    private func settle(_ mine: Int) {
        guard isCurrent(mine) else { return }
        work = nil
        goIdle()
    }
}
