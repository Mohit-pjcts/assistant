import Foundation

/// How a turn ended, as far as the phone can tell.
public enum TurnOutcome: Sendable, Equatable {
    /// Oni finished. Re-read `/history` for the reply.
    case replied
    /// The turn was stopped.
    case stopped
    case failed(String)
    /// Paused at a confirmation; show the card.
    case needsApproval(Gate)
    /// Paused at a confirmation the phone cannot show: decline it.
    case unreadableApproval
    /// The Mac stopped answering while a turn was running. The turn is
    /// probably still going on the Mac; reopening the thread checks again.
    case lostContact
    /// An answer was NOT sent: the card on screen is no longer the confirmation
    /// the Mac is waiting on (answered from the dashboard, or already done).
    case staleApproval
}

/// What the app shows while it waits.
public enum TurnProgress: Sendable, Equatable {
    case frame(ChatFrame)
    /// The live stream dropped; the app is now asking the Mac how the turn is going.
    case reconnecting
    /// The Mac refused to start the turn because another client already has one
    /// running on this thread. The message was NOT sent; the app now just watches.
    case busyElsewhere
}

/// Runs one turn against the Mac and survives the phone going away.
///
/// A turn started here runs on the Mac regardless of this connection (detached
/// turns, PLAN.md Phase 31 D7). So when the stream ends without a terminal
/// frame, that is not a failure: the driver asks `turnState` until the Mac says
/// the turn is over, paused at a confirmation, or unreachable for too long.
public struct MacTurnDriver: Sendable {
    public let server: any MacServer
    public let pollInterval: Duration
    /// Consecutive failed polls tolerated before giving up with `.lostContact`.
    public let maxMisses: Int
    let sleep: @Sendable (Duration) async throws -> Void

    public init(
        server: any MacServer,
        pollInterval: Duration = .seconds(1.5),
        maxMisses: Int = 20,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.server = server
        self.pollInterval = pollInterval
        self.maxMisses = maxMisses
        self.sleep = sleep
    }

    /// Starts a turn and follows it to the end.
    public func run(
        _ request: TurnRequest, progress: @MainActor @Sendable (TurnProgress) -> Void
    ) async -> TurnOutcome {
        do {
            for try await frame in server.stream(request) {
                await progress(.frame(frame))
                switch frame {
                case .message: return .replied
                case .error(let detail): return .failed(detail)
                case .interrupt(let gate): return .needsApproval(gate)
                case .unreadableInterrupt: return .unreadableApproval
                default: continue
                }
            }
        } catch MacServerError.busy {
            // Another client (the dashboard) is mid-turn on this thread: just watch it.
            await progress(.busyElsewhere)
            return await watch(threadId: request.threadId, progress: progress)
        } catch is CancellationError {
            return .lostContact
        } catch let error as MacServerError {
            if case .unreachable = error { return .lostContact }
            return .failed(error.description)
        } catch {
            return .failed(error.localizedDescription)
        }
        // The stream ended with no terminal frame: the link dropped.
        return await watch(threadId: request.threadId, progress: progress)
    }

    /// Answers a confirmation, but only after the Mac confirms it is STILL
    /// waiting on exactly the card the person saw. `/resume` does not check
    /// that anything is pending, so a stale Approve (answered meanwhile from the
    /// dashboard, or tapped twice from two devices) must never be sent. If the
    /// check itself cannot be made, nothing is sent either.
    public func answer(
        approved: Bool, expecting gate: Gate, threadId: String,
        progress: @MainActor @Sendable (TurnProgress) -> Void
    ) async -> TurnOutcome {
        do {
            let state = try await server.turnState(threadId: threadId)
            guard state.status == .waitingForApproval, state.gate == gate else { return .staleApproval }
        } catch {
            return .lostContact
        }
        return await run(.resume(approved: approved, threadId: threadId), progress: progress)
    }

    /// Follows a thread's turn without sending anything: used after a dropped
    /// stream and when the app reopens a thread that may have a turn in flight.
    public func watch(
        threadId: String, progress: @MainActor @Sendable (TurnProgress) -> Void
    ) async -> TurnOutcome {
        await progress(.reconnecting)
        return await poll(threadId: threadId)
    }

    private func poll(threadId: String) async -> TurnOutcome {
        var misses = 0
        while !Task.isCancelled {
            do {
                let state = try await server.turnState(threadId: threadId)
                misses = 0
                switch state.status {
                case .running:
                    break
                case .waitingForApproval:
                    if let gate = state.gate { return .needsApproval(gate) }
                    return .unreadableApproval
                case .idle:
                    switch state.last {
                    case .cancelled: return .stopped
                    case .error(let detail): return .failed(detail)
                    case .completed, nil: return .replied
                    }
                }
            } catch is CancellationError {
                return .lostContact
            } catch MacServerError.notFound {
                return .failed("That conversation no longer exists on your Mac.")
            } catch {
                misses += 1
                if misses >= maxMisses { return .lostContact }
            }
            do { try await sleep(pollInterval) } catch { return .lostContact }
        }
        return .lostContact
    }
}
