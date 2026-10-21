import Foundation
import Testing
@testable import OniCore

/// A canned HTTP answer for `StubProtocol`.
struct StubReply: Sendable {
    var status = 200
    var chunks: [Data] = []
    /// Delivered after the chunks instead of a clean finish.
    var failure: URLError.Code?
    /// Delivered instead of any response (the Mac not answering at all).
    var failBeforeResponse: URLError.Code?

    static func json(_ text: String, status: Int = 200) -> StubReply { StubReply(status: status, chunks: [Data(text.utf8)]) }
    static func sse(_ chunks: [String], failure: URLError.Code? = nil) -> StubReply {
        StubReply(chunks: chunks.map { Data($0.utf8) }, failure: failure)
    }
}

/// A URLProtocol standing in for the Mac, recording what was asked.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var reply: @Sendable (URLRequest, Data) -> StubReply = { _, _ in .json("{}") }
    nonisolated(unsafe) static var seen: [(request: URLRequest, body: Data)] = []
    private static let lock = NSLock()

    static func reset(_ reply: @escaping @Sendable (URLRequest, Data) -> StubReply) {
        lock.lock(); defer { lock.unlock() }
        self.reply = reply
        seen = []
    }

    static var requests: [(request: URLRequest, body: Data)] {
        lock.lock(); defer { lock.unlock() }
        return seen
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let body = Self.readBody(request)
        Self.lock.lock()
        Self.seen.append((request, body))
        let reply = Self.reply
        Self.lock.unlock()
        let answer = reply(request, body)

        if let code = answer.failBeforeResponse {
            client?.urlProtocol(self, didFailWithError: URLError(code))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        for chunk in answer.chunks { client?.urlProtocol(self, didLoad: chunk) }
        if let code = answer.failure {
            // A moment later, like a real link dying after bytes arrived;
            // failing in the same breath can drop the bytes before they are read.
            let client = self.client
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { client?.urlProtocol(self, didFailWithError: URLError(code)) }
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

@Suite(.serialized) struct MacServerTests {
    private let base = URL(string: "https://oni.example.ts.net")!

    private func client(_ reply: @escaping @Sendable (URLRequest, Data) -> StubReply) -> HTTPMacServer {
        StubProtocol.reset(reply)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return HTTPMacServer(baseURL: base, session: URLSession(configuration: config))
    }

    private func frames(_ stream: AsyncThrowingStream<ChatFrame, Error>) async throws -> [ChatFrame] {
        var out: [ChatFrame] = []
        for try await frame in stream { out.append(frame) }
        return out
    }

    private func sentJSON(_ index: Int = 0) -> JSONValue? {
        JSONValue.parse(String(decoding: StubProtocol.requests[index].body, as: UTF8.self))
    }

    // MARK: turns

    @Test func aChatTurnIsSentDetachedToTheRightThreadWithItsAttachments() async throws {
        let attachment = try MacAttachment(["path": "uploads/p.jpg", "mime_type": "image/jpeg", "kind": "image", "filename": "p.jpg"])
        let mac = client { _, _ in .sse(["data: {\"type\": \"message\", \"content\": \"ok\"}\n\n"]) }
        _ = try await frames(mac.stream(.chat(message: "hi there", threadId: "t-1", attachments: [attachment])))

        let sent = StubProtocol.requests[0]
        #expect(sent.request.url?.absoluteString == "https://oni.example.ts.net/chat")
        #expect(sent.request.httpMethod == "POST")
        #expect(sent.request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(sentJSON())
        #expect(body["message"]?.string == "hi there")
        #expect(body["thread_id"]?.string == "t-1")
        #expect(body["detached"]?.bool == true)
        #expect(body["attachments"]?.array?.first?["path"]?.string == "uploads/p.jpg")
    }

    @Test func aResumeAndAnA2UIActionAreSentDetachedToo() async throws {
        let mac = client { _, _ in .sse(["data: {\"type\": \"message\", \"content\": \"ok\"}\n\n"]) }
        _ = try await frames(mac.stream(.resume(approved: false, threadId: "t-1")))
        _ = try await frames(mac.stream(.a2uiAction(surfaceId: "s1", name: "go", context: ["who": "Sam"], threadId: "t-2")))

        #expect(StubProtocol.requests[0].request.url?.path == "/resume")
        #expect(sentJSON(0)?["approved"]?.bool == false)
        #expect(sentJSON(0)?["detached"]?.bool == true)
        #expect(StubProtocol.requests[1].request.url?.path == "/a2ui/action")
        #expect(sentJSON(1)?["surface_id"]?.string == "s1")
        #expect(sentJSON(1)?["name"]?.string == "go")
        #expect(sentJSON(1)?["context"]?["who"]?.string == "Sam")
        #expect(sentJSON(1)?["thread_id"]?.string == "t-2")
        #expect(sentJSON(1)?["detached"]?.bool == true)
    }

    @Test func framesSplitAcrossNetworkChunksAreStillReadWhole() async throws {
        let mac = client { _, _ in
            .sse(["data: {\"type\": \"tok", "en\", \"text\": \"Hel\"}\n\ndata: {\"type\": \"token\", \"text\": \"lo\"}\n",
                  "\ndata: {\"type\": \"message\", \"content\": \"Hello\"}\n\n"])
        }
        let got = try await frames(mac.stream(.chat(message: "x", threadId: "t", attachments: [])))
        #expect(got == [.token("Hel"), .token("lo"), .message("Hello")])
    }

    @Test func aDroppedConnectionEndsTheStreamQuietlyWithoutATerminalFrame() async throws {
        let mac = client { _, _ in .sse(["data: {\"type\": \"token\", \"text\": \"par\"}\n\n"], failure: .networkConnectionLost) }
        let got = try await frames(mac.stream(.chat(message: "x", threadId: "t", attachments: [])))
        #expect(got == [.token("par")])
        #expect(got.allSatisfy { !$0.isTerminal })
    }

    @Test func aMacThatDoesNotAnswerIsReportedAsUnreachable() async {
        let mac = client { _, _ in StubReply(failBeforeResponse: .cannotConnectToHost) }
        do {
            _ = try await frames(mac.stream(.chat(message: "x", threadId: "t", attachments: [])))
            Issue.record("expected an error")
        } catch let error as MacServerError {
            guard case .unreachable = error else { Issue.record("wrong error \(error)"); return }
        } catch { Issue.record("wrong error \(error)") }
    }

    @Test func aTurnAlreadyRunningIsBusyAndAnUnknownThreadIsNotFound() async {
        let busy = client { _, _ in .json(#"{"detail": "A turn is already running"}"#, status: 409) }
        do { _ = try await frames(busy.stream(.chat(message: "x", threadId: "t", attachments: []))); Issue.record("expected busy") }
        catch { #expect(error as? MacServerError == .busy) }

        let missing = client { _, _ in .json(#"{"detail": "No thread with id zzz"}"#, status: 404) }
        do { _ = try await frames(missing.stream(.chat(message: "x", threadId: "zzz", attachments: []))); Issue.record("expected not found") }
        catch { #expect(error as? MacServerError == .notFound("No thread with id zzz")) }
    }

    @Test func stoppingAThreadReportsWhetherAnythingWasRunning() async throws {
        let mac = client { _, _ in .json(#"{"stopped": true}"#) }
        #expect(try await mac.stop(threadId: "t-9") == true)
        #expect(StubProtocol.requests[0].request.url?.path == "/chat/stop")
        #expect(sentJSON()?["thread_id"]?.string == "t-9")
        let idle = client { _, _ in .json(#"{"stopped": false}"#) }
        #expect(try await idle.stop(threadId: "t-9") == false)
    }

    // MARK: turn state and history

    @Test func theTurnStateSaysRunningWaitingOrIdle() async throws {
        let running = client { _, _ in .json(#"{"status": "running", "gate": null, "activity": {"agent": "x"}, "last": null}"#) }
        let r = try await running.turnState(threadId: "t")
        #expect(r.status == .running && r.gate == nil && r.last == nil)
        #expect(StubProtocol.requests[0].request.url?.path == "/threads/t/turn")

        let waiting = client { _, _ in
            .json(#"{"status": "waiting_for_approval", "gate": {"action": "send_imessage", "recipient": "+1", "message": "hi"}, "activity": null, "last": null}"#)
        }
        let w = try await waiting.turnState(threadId: "t")
        #expect(w.status == .waitingForApproval && w.gate?.action == "send_imessage" && !w.gateUnreadable)

        let idle = client { _, _ in .json(#"{"status": "idle", "gate": null, "activity": null, "last": {"outcome": "error", "detail": "RateLimitError"}}"#) }
        let i = try await idle.turnState(threadId: "t")
        #expect(i.status == .idle && i.last == .error("RateLimitError"))

        let done = client { _, _ in .json(#"{"status": "idle", "last": {"outcome": "completed"}}"#) }
        #expect(try await done.turnState(threadId: "t").last == .completed)
    }

    @Test func aPausedTurnWhoseGateCannotBeReadIsFlaggedSoItCanBeDeclined() async throws {
        let mac = client { _, _ in .json(#"{"status": "waiting_for_approval", "gate": "garbage"}"#) }
        let state = try await mac.turnState(threadId: "t")
        #expect(state.status == .waitingForApproval && state.gate == nil && state.gateUnreadable)
    }

    @Test func historyReadsTheNamedThreadAndKeepsSurfacesAndSyntheticFlags() async throws {
        let mac = client { _, _ in
            .json(#"{"thread_id": "t", "messages": [{"role": "user", "content": "hi", "synthetic": false, "name": null, "surfaces": []}, {"role": "user", "content": "[facts]", "synthetic": true}, {"role": "assistant", "content": "hello", "name": "supervisor", "surfaces": [{"surfaceId": "s"}]}]}"#)
        }
        let messages = try await mac.history(threadId: "t")
        #expect(StubProtocol.requests[0].request.url?.query == "thread_id=t")
        #expect(messages.map(\.role) == ["user", "user", "assistant"])
        #expect(messages[1].synthetic && !messages[0].synthetic)
        #expect(messages[2].name == "supervisor" && messages[2].surfaces.count == 1)
    }

    // MARK: threads, projects

    @Test func threadsAndProjectsAreDecoded() async throws {
        let mac = client { req, _ in
            req.url!.path == "/projects"
                ? .json(#"{"projects": [{"id": "p1", "name": "Uni", "color": "violet", "created_at": "x"}]}"#)
                : .json(#"{"threads": [{"id": "a", "title": "One", "created_at": "c", "last_active_at": "l", "project_id": "p1"}, {"id": "b", "title": null, "created_at": "c", "last_active_at": "l", "project_id": null}], "active_thread_id": "a"}"#)
        }
        let list = try await mac.threads()
        #expect(list.threads.map(\.id) == ["a", "b"] && list.threads[0].projectId == "p1" && list.threads[1].title == nil)
        #expect(list.activeThreadId == "a")
        let projects = try await mac.projects()
        #expect(projects == [try MacProject(["id": "p1", "name": "Uni", "color": "violet"])])
    }

    @Test func creatingRenamingAndDeletingAThread() async throws {
        let mac = client { _, _ in .json(#"{"id": "n", "title": "T", "created_at": "c", "last_active_at": "l", "project_id": null}"#) }
        #expect(try await mac.createThread(title: nil).id == "n")
        #expect(sentJSON(0)?["title"] == .null)
        _ = try await mac.renameThread(id: "n", title: "Renamed")
        #expect(StubProtocol.requests[1].request.httpMethod == "PATCH" && StubProtocol.requests[1].request.url?.path == "/threads/n")
        try await mac.deleteThread(id: "n")
        #expect(StubProtocol.requests[2].request.httpMethod == "DELETE")
    }

    @Test func anIdIsEncodedAsOnePathSegment() async throws {
        let mac = client { _, _ in .json(#"{"status": "idle"}"#) }
        _ = try await mac.turnState(threadId: "a/b c")
        #expect(StubProtocol.requests[0].request.url?.absoluteString == "https://oni.example.ts.net/threads/a%2Fb%20c/turn")
    }

    // MARK: board

    private let taskJSON = #"{"id": "k1", "column": "in-progress", "ref": "ONI-4", "priority": "high", "title": "Ship it", "description": "d", "position": 2, "created_at": "c", "updated_at": "u"}"#

    @Test func boardTasksAreDecodedIncludingTheirColumns() async throws {
        let mac = client { _, _ in .json(#"{"tasks": [\#(taskJSON)]}"#) }
        let tasks = try await mac.boardTasks()
        #expect(tasks.first?.ref == "ONI-4" && tasks.first?.column == .inProgress && tasks.first?.position == 2)
    }

    @Test func movingAndEditingATaskSendsOnlyWhatChanged() async throws {
        let mac = client { _, _ in .json(taskJSON) }
        _ = try await mac.moveBoardTask(id: "k1", to: .inReview, position: 0)
        #expect(sentJSON(0) == ["column": "in-review", "position": 0])
        _ = try await mac.updateBoardTask(id: "k1", title: "New", description: nil, priority: nil)
        #expect(sentJSON(1) == ["title": "New"])
        _ = try await mac.createBoardTask(column: .todo, title: "T", description: "", priority: "low")
        #expect(StubProtocol.requests[2].request.httpMethod == "POST")
        #expect(sentJSON(2)?["column"]?.string == "todo")
        try await mac.deleteBoardTask(id: "k1")
        #expect(StubProtocol.requests[3].request.httpMethod == "DELETE")
    }

    @Test func anUnknownBoardColumnFromTheMacIsAnErrorNotAGuess() async {
        let mac = client { _, _ in .json(#"{"tasks": [{"id": "k", "column": "limbo", "ref": "r", "title": "t"}]}"#) }
        await #expect(throws: MacAPIError.self) { _ = try await mac.boardTasks() }
    }

    // MARK: memory approvals

    @Test func pendingFactsCanBeApprovedAndDeclined() async throws {
        let mac = client { _, _ in .json(#"{"pending": [{"id": 3, "content": "Likes tea", "provenance": "chat", "created_at": "c"}]}"#) }
        #expect(try await mac.pendingFacts() == [try PendingFact(["id": 3, "content": "Likes tea", "provenance": "chat", "created_at": "c"])])
        try await mac.approvePendingFact(id: 3)
        try await mac.declinePendingFact(id: 3)
        #expect(StubProtocol.requests[1].request.url?.path == "/memory/pending/3/approve")
        #expect(StubProtocol.requests[2].request.url?.path == "/memory/pending/3/decline")
    }

    // MARK: upload

    @Test func anUploadIsAMultipartFileWithASafeFilename() async throws {
        let mac = client { _, _ in
            .json(#"{"id": "u", "path": "uploads/2026-10-21/ab_p.jpg", "filename": "p.jpg", "mime_type": "image/jpeg", "size": 3, "kind": "image"}"#)
        }
        let attachment = try await mac.upload(data: Data([1, 2, 3]), filename: "p\".jpg\r\nX-Evil: 1", mimeType: "image/jpeg")
        #expect(attachment.path == "uploads/2026-10-21/ab_p.jpg" && attachment.kind == "image")

        let sent = StubProtocol.requests[0]
        #expect(sent.request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        let text = String(decoding: sent.body, as: UTF8.self)
        #expect(text.contains("name=\"file\"; filename=\"p.jpgX-Evil: 1\""))
        #expect(text.contains("Content-Type: image/jpeg"))
        #expect(sent.body.range(of: Data([1, 2, 3])) != nil)
    }

    // MARK: encoding

    @Test func queryValuesSurviveSpecialCharacters() {
        #expect(HTTPMacServer.encodeQuery(["thread_id": "a+b&c=d"]) == "thread_id=a%2Bb%26c%3Dd")
    }
}
