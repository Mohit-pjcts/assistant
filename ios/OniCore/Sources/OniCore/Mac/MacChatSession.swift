import Foundation
import Observation

/// One conversation with the Mac's Oni, as a screen sees it.
///
/// The Mac runs every turn started here on its own (PLAN.md Phase 31 D7), so
/// this object never *owns* a turn: it follows one. A screen lock, a dropped
/// link or a relaunch leaves the turn going on the Mac, and `open()` /
/// `reattach()` pick it up again from `turnState` and `/history`.
@MainActor @Observable
public final class MacChatSession {
    public enum Phase: Equatable, Sendable {
        case idle
        case running
        /// The live stream dropped; asking the Mac how the turn is going.
        case reconnecting
        case awaitingApproval(Gate)
        /// The Mac stopped answering while a turn was in flight.
        case lostContact
    }

    public let threadId: String
    private let server: any MacServer
    private let driver: MacTurnDriver

    public private(set) var items: [MacTranscriptItem] = []
    /// What was just sent, shown until the Mac's history includes it.
    public private(set) var pendingUser: String?
    public private(set) var liveText = ""
    /// Cards made during the running turn; they are drawn once the turn ends
    /// and `/history` carries them.
    public private(set) var liveSurfaceCount = 0
    public private(set) var activity: String?
    public private(set) var phase: Phase = .idle
    public private(set) var errorMessage: String?
    public private(set) var notice: String?
    public private(set) var isLoaded = false

    private var task: Task<Void, Never>?
    private var generation = 0

    public init(threadId: String, server: any MacServer, driver: MacTurnDriver? = nil) {
        self.threadId = threadId
        self.server = server
        self.driver = driver ?? MacTurnDriver(server: server)
    }

    public var isBusy: Bool { phase == .running || phase == .reconnecting }

    // MARK: Opening

    /// Loads the conversation and finds out what the Mac is doing with it. Safe
    /// to call whenever the screen appears or the app returns to the foreground.
    public func open() async {
        // A turn this session is already following needs no second watcher.
        if isBusy, task != nil { return }
        await reloadHistory()
        do {
            let state = try await server.turnState(threadId: threadId)
            switch state.status {
            case .running:
                begin(phase: .reconnecting) { driver, progress in
                    await driver.watch(threadId: self.threadId, progress: progress)
                }
            case .waitingForApproval:
                if let gate = state.gate { phase = .awaitingApproval(gate) } else { declineUnreadable() }
            case .idle:
                if phase == .lostContact, case .error(let detail)? = state.last { errorMessage = detail }
                phase = .idle
            }
        } catch MacServerError.unreachable {
            if pendingUser != nil || isBusy { phase = .lostContact }
        } catch {
            errorMessage = describe(error)
        }
    }

    /// The app came back to the foreground: a connection that was open when it
    /// was suspended is dead, so look at the turn again.
    public func reattach() async {
        guard isBusy || phase == .lostContact else { return }
        task?.cancel()
        task = nil
        generation += 1
        await open()
    }

    // MARK: Sending

    public func send(_ text: String, attachments: [MacAttachment] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canStartTurn else { return }
        pendingUser = trimmed
        run(.chat(message: trimmed, threadId: threadId, attachments: attachments))
    }

    /// Answers the confirmation the thread is paused at. The phase leaves
    /// `awaitingApproval` synchronously, so a second tap cannot send a second answer.
    public func answer(approved: Bool) {
        guard case .awaitingApproval(let gate) = phase else { return }
        errorMessage = nil
        notice = nil
        liveText = ""
        liveSurfaceCount = 0
        activity = "Sending your answer…"
        begin(phase: .running) { driver, progress in
            await driver.answer(approved: approved, expecting: gate, threadId: self.threadId, progress: progress)
        }
    }

    /// A generative-UI button was pressed.
    public func pressButton(surfaceId: String, name: String, context: [String: JSONValue] = [:]) {
        guard canStartTurn else { return }
        run(.a2uiAction(surfaceId: surfaceId, name: name, context: context, threadId: threadId))
    }

    /// Asks the Mac to stop. The turn ends on the Mac; the follower sees it end.
    public func stop() async {
        do { _ = try await server.stop(threadId: threadId) } catch { errorMessage = describe(error) }
    }

    public func dismissError() { errorMessage = nil }
    public func dismissNotice() { notice = nil }

    private var canStartTurn: Bool {
        if isBusy { return false }
        if case .awaitingApproval = phase { return false }
        return true
    }

    // MARK: Following a turn

    private func run(_ request: TurnRequest, notice: String? = nil) {
        errorMessage = nil
        self.notice = notice
        liveText = ""
        liveSurfaceCount = 0
        activity = "Thinking…"
        begin(phase: .running) { driver, progress in await driver.run(request, progress: progress) }
    }

    private func begin(
        phase newPhase: Phase,
        _ work: @escaping @MainActor (MacTurnDriver, @MainActor @Sendable (TurnProgress) -> Void) async -> TurnOutcome
    ) {
        task?.cancel()
        generation += 1
        let mine = generation
        phase = newPhase
        let driver = self.driver
        task = Task { [weak self] in
            let outcome = await work(driver) { progress in self?.apply(progress, generation: mine) }
            await self?.finish(outcome, generation: mine)
        }
    }

    private func apply(_ progress: TurnProgress, generation mine: Int) {
        guard mine == generation else { return }
        switch progress {
        case .reconnecting:
            phase = .reconnecting
            activity = "Reconnecting to your Mac…"
        case .busyElsewhere:
            pendingUser = nil
            notice = "Oni is already working on this conversation (it was started somewhere else), so your message was not sent."
        case .frame(let frame):
            if phase == .reconnecting { phase = .running }
            switch frame {
            case .token(let text):
                liveText += text
                activity = "Writing…"
            case .activity(let a):
                activity = MacActivityLabel.text(for: a) ?? "Thinking…"
            case .a2ui:
                liveSurfaceCount += 1
            case .rejectedSurface:
                notice = "Oni made a card the phone could not show safely, so it was skipped."
            default:
                break
            }
        }
    }

    private func finish(_ outcome: TurnOutcome, generation mine: Int) async {
        guard mine == generation else { return }
        task = nil
        activity = nil
        switch outcome {
        case .replied:
            await reloadHistory()
            phase = .idle
        case .stopped:
            await reloadHistory()
            phase = .idle
            notice = "Stopped."
        case .failed(let message):
            await reloadHistory()
            phase = .idle
            errorMessage = message
        case .needsApproval(let gate):
            await reloadHistory()
            phase = .awaitingApproval(gate)
        case .unreadableApproval:
            await reloadHistory()
            declineUnreadable()
            return
        case .lostContact:
            phase = .lostContact
            return
        case .staleApproval:
            // Nothing was sent. Show what the Mac actually has now.
            phase = .idle
            notice = "That confirmation was already answered somewhere else, so nothing was sent."
            await open()
            return
        }
        liveText = ""
        liveSurfaceCount = 0
    }

    /// A confirmation the phone cannot show is never approved blind (D4).
    private func declineUnreadable() {
        run(.resume(approved: false, threadId: threadId),
            notice: "A confirmation could not be shown on the phone, so it was declined.")
    }

    private func reloadHistory() async {
        do {
            items = MacTranscript.items(from: try await server.history(threadId: threadId))
            pendingUser = nil
            isLoaded = true
        } catch MacServerError.unreachable {
            // Keep what is on screen; the phase says the Mac is out of reach.
            if !isLoaded { errorMessage = "Can't reach your Mac." }
        } catch {
            errorMessage = describe(error)
        }
    }

    private func describe(_ error: Error) -> String {
        (error as? MacServerError)?.description ?? error.localizedDescription
    }
}
