import Foundation
import Observation
import OniCore

/// The phone's link to the Mac's Oni: the thread list, the Projects, and one
/// `MacChatSession` per open conversation. PLAN.md Phase 31.
@MainActor @Observable
final class MacController {
    enum Link: Equatable {
        case unknown
        case connected
        case unreachable(String)
    }

    private let app: AppModel

    private(set) var link: Link = .unknown
    private(set) var threads: [MacThread] = []
    private(set) var projects: [MacProject] = []
    private(set) var isLoading = false
    private var sessions: [String: MacChatSession] = [:]
    /// The Board and the memory-review queue, shared by their screens and the
    /// list that shows the queue's count. Created on first use, from a `.task`.
    private(set) var board: MacBoard?
    private(set) var review: MacMemoryReview?
    private var cached: (url: URL, server: HTTPMacServer)?

    init(app: AppModel) { self.app = app }

    /// The Mac's API, at the same address the Vault pairing already holds.
    var server: HTTPMacServer? {
        guard let url = app.baseURL else { return nil }
        if let cached, cached.url == url { return cached.server }
        let server = HTTPMacServer(baseURL: url)
        cached = (url, server)
        sessions = [:]
        board = nil
        review = nil
        return server
    }

    /// True while any conversation has a turn running, so the tab can say so.
    var anyBusy: Bool { sessions.values.contains { $0.isBusy } }

    /// The conversation's session if one is open. Safe to call from a view body.
    func existingSession(_ threadId: String) -> MacChatSession? { sessions[threadId] }

    /// The session for a conversation, created on first use. Mutates state, so
    /// call it from a `.task`, never from a view body.
    func session(_ threadId: String) -> MacChatSession? {
        guard let server else { return nil }
        if let existing = sessions[threadId] { return existing }
        let made = MacChatSession(threadId: threadId, server: server)
        sessions[threadId] = made
        return made
    }

    /// The Board and the review queue for the current Mac, created if needed.
    /// Mutates state: call from a `.task`, never from a view body.
    func prepareExtras() -> (board: MacBoard, review: MacMemoryReview)? {
        guard let server else { return nil }
        if board == nil { board = MacBoard(server: server) }
        if review == nil { review = MacMemoryReview(server: server) }
        return (board!, review!)
    }

    func refresh() async {
        guard let server, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let list = server.threads()
            async let folders = server.projects()
            let (fetched, fetchedProjects) = try await (list, folders)
            threads = fetched.threads.sorted { $0.lastActiveAt > $1.lastActiveAt }
            projects = fetchedProjects
            link = .connected
            // The count on the list; failures here are not the list's problem.
            if let extras = prepareExtras() { await extras.review.load() }
        } catch MacServerError.unreachable(let why) {
            link = .unreachable(why)
        } catch {
            link = .unreachable((error as? MacServerError)?.description ?? error.localizedDescription)
        }
    }

    /// Creates a conversation on the Mac. It lands ungrouped and does not move
    /// the thread the dashboard is showing.
    func newThread() async -> String? {
        guard let server else { return nil }
        do {
            let thread = try await server.createThread(title: nil)
            threads.insert(thread, at: 0)
            link = .connected
            return thread.id
        } catch {
            link = .unreachable((error as? MacServerError)?.description ?? error.localizedDescription)
            return nil
        }
    }

    /// The app came back to the foreground: refresh the list and re-check every
    /// turn that was in flight when the connection died.
    func foreground() async {
        await refresh()
        for session in sessions.values { await session.reattach() }
    }
}
