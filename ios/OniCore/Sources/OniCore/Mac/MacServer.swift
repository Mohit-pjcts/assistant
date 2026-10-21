import Foundation

/// What starts a turn on the Mac. Every request is sent `detached`, so the Mac
/// keeps the turn running if the phone's connection drops (PLAN.md Phase 31 D7).
public enum TurnRequest: Sendable, Equatable {
    case chat(message: String, threadId: String, attachments: [MacAttachment])
    /// Answers the confirmation the thread is paused at.
    case resume(approved: Bool, threadId: String)
    /// A generative-UI button was pressed; sent as an ordinary user turn.
    case a2uiAction(surfaceId: String, name: String, context: [String: JSONValue], threadId: String)

    var path: String {
        switch self {
        case .chat: "/chat"
        case .resume: "/resume"
        case .a2uiAction: "/a2ui/action"
        }
    }

    public var threadId: String {
        switch self {
        case .chat(_, let id, _), .resume(_, let id), .a2uiAction(_, _, _, let id): id
        }
    }

    var body: JSONValue {
        switch self {
        case .chat(let message, let threadId, let attachments):
            ["message": .string(message), "thread_id": .string(threadId), "detached": true,
             "attachments": .array(attachments.map(\.json))]
        case .resume(let approved, let threadId):
            ["approved": .bool(approved), "thread_id": .string(threadId), "detached": true]
        case .a2uiAction(let surfaceId, let name, let context, let threadId):
            ["surface_id": .string(surfaceId), "name": .string(name), "context": .object(context),
             "thread_id": .string(threadId), "detached": true]
        }
    }
}

public enum MacServerError: Error, Equatable, CustomStringConvertible {
    /// No answer: the Mac is off, asleep, or the phone is off the tailnet.
    case unreachable(String)
    /// A turn is already running on that thread (another client, or this one).
    case busy
    case notFound(String)
    case server(status: Int, message: String)

    public var description: String {
        switch self {
        case .unreachable(let why): "Can't reach your Mac (\(why))."
        case .busy: "Oni is already working on this conversation."
        case .notFound(let what): what
        case .server(let status, let message): "The Mac answered \(status): \(message)"
        }
    }
}

/// The Mac's `/chat`-family API. A protocol so the screens and the reconnect
/// logic are tested against a scripted fake; `HTTPMacServer` is the real one.
public protocol MacServer: Sendable {
    /// Starts (or resumes) a turn and yields its frames until the stream ends.
    /// The stream ends WITHOUT a terminal frame if the connection drops: the
    /// turn is still running on the Mac, and `turnState` says how it went.
    func stream(_ request: TurnRequest) -> AsyncThrowingStream<ChatFrame, Error>
    func stop(threadId: String) async throws -> Bool
    func turnState(threadId: String) async throws -> TurnState
    func history(threadId: String) async throws -> [MacMessage]

    func threads() async throws -> ThreadList
    func createThread(title: String?) async throws -> MacThread
    func renameThread(id: String, title: String) async throws -> MacThread
    func deleteThread(id: String) async throws
    func projects() async throws -> [MacProject]

    func boardTasks() async throws -> [BoardTask]
    func createBoardTask(column: BoardColumn, title: String, description: String, priority: String) async throws -> BoardTask
    func moveBoardTask(id: String, to column: BoardColumn, position: Int?) async throws -> BoardTask
    func updateBoardTask(id: String, title: String?, description: String?, priority: String?) async throws -> BoardTask
    func deleteBoardTask(id: String) async throws

    func pendingFacts() async throws -> [PendingFact]
    func approvePendingFact(id: Int) async throws
    func declinePendingFact(id: Int) async throws

    func upload(data: Data, filename: String, mimeType: String) async throws -> MacAttachment
}

/// `MacServer` over HTTPS to the Mac (`tailscale serve`). No token: the routes
/// are the ones the dashboard uses, and the tailnet is the trust boundary
/// (PLAN.md Phase 31 D2, docs/adr/0005-*).
public struct HTTPMacServer: MacServer {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: transport

    private func makeRequest(
        _ method: String, _ path: String, query: [String: String] = [:],
        json: JSONValue? = nil, timeout: TimeInterval = 30
    ) throws -> URLRequest {
        var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        // `path` arrives already encoded (ids go through `id(_:)`).
        comps.percentEncodedPath = (comps.percentEncodedPath.hasSuffix("/") ? String(comps.percentEncodedPath.dropLast()) : comps.percentEncodedPath)
            + path
        if !query.isEmpty { comps.percentEncodedQuery = Self.encodeQuery(query) }
        var req = URLRequest(url: comps.url!, timeoutInterval: timeout)
        req.httpMethod = method
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try json.encoded()
        }
        return req
    }

    private func send(_ req: URLRequest) async throws -> JSONValue {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw MacServerError.unreachable(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw MacServerError.server(status: 0, message: "Not an HTTP response") }
        guard (200..<300).contains(http.statusCode) else { throw Self.mapError(status: http.statusCode, body: String(decoding: data, as: UTF8.self)) }
        return JSONValue.parse(String(decoding: data, as: UTF8.self)) ?? .null
    }

    private func call(_ method: String, _ path: String, query: [String: String] = [:], json: JSONValue? = nil) async throws -> JSONValue {
        try await send(makeRequest(method, path, query: query, json: json))
    }

    static func mapError(status: Int, body: String) -> MacServerError {
        let detail = JSONValue.parse(body)?["detail"]?.string ?? String(body.prefix(200))
        switch status {
        case 404: return .notFound(detail)
        case 409: return .busy
        default: return .server(status: status, message: detail)
        }
    }

    /// Percent-encodes everything but RFC 3986 "unreserved" characters, so `+`
    /// and `&` in a value survive (the lesson of HTTPVaultServer.encodeQuery).
    static func encodeQuery(_ items: [String: String]) -> String {
        items.sorted { $0.key < $1.key }.map { "\(encodeComponent($0.key))=\(encodeComponent($0.value))" }.joined(separator: "&")
    }

    /// An id as one path segment.
    private func id(_ raw: String) -> String { Self.encodeComponent(raw) }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    static func encodeComponent(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s }

    // MARK: turns

    public func stream(_ request: TurnRequest) -> AsyncThrowingStream<ChatFrame, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // No overall timeout: a turn can run for minutes. The idle
                    // timeout (no bytes at all) still catches a dead link.
                    let req = try makeRequest("POST", request.path, json: request.body, timeout: 120)
                    let bytes: URLSession.AsyncBytes
                    let response: URLResponse
                    do {
                        (bytes, response) = try await session.bytes(for: req)
                    } catch let e as URLError {
                        throw e.code == .cancelled ? CancellationError() : MacServerError.unreachable(e.localizedDescription)
                    }
                    guard let http = response as? HTTPURLResponse else { throw MacServerError.server(status: 0, message: "Not an HTTP response") }
                    if http.statusCode != 200 {
                        var text = ""
                        for try await line in bytes.lines { text += line }
                        throw Self.mapError(status: http.statusCode, body: text)
                    }
                    do {
                        for try await line in bytes.lines {
                            if let frame = ChatFrame.parse(line: line) { continuation.yield(frame) }
                        }
                    } catch let e as URLError where e.code != .cancelled {
                        // The link dropped mid-turn. Not an error to the caller:
                        // the Mac is still working, and `turnState` knows.
                        continuation.finish()
                        return
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch let e as URLError where e.code == .cancelled {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func stop(threadId: String) async throws -> Bool {
        let result = try await call("POST", "/chat/stop", json: ["thread_id": .string(threadId)])
        return result["stopped"]?.bool ?? false
    }

    public func turnState(threadId: String) async throws -> TurnState {
        try TurnState(try await call("GET", "/threads/\(id(threadId))/turn"))
    }

    public func history(threadId: String) async throws -> [MacMessage] {
        let result = try await call("GET", "/history", query: ["thread_id": threadId])
        return try (result["messages"]?.array ?? []).map(MacMessage.init)
    }

    // MARK: threads and projects

    public func threads() async throws -> ThreadList {
        let result = try await call("GET", "/threads")
        return ThreadList(
            threads: try (result["threads"]?.array ?? []).map(MacThread.init),
            activeThreadId: result["active_thread_id"]?.string)
    }

    public func createThread(title: String?) async throws -> MacThread {
        // activate: false, so a chat started here never switches the thread the
        // dashboard (and the Shortcuts) are on.
        try MacThread(try await call("POST", "/threads", json: ["title": title.map(JSONValue.string) ?? .null, "activate": false]))
    }

    public func renameThread(id: String, title: String) async throws -> MacThread {
        try MacThread(try await call("PATCH", "/threads/\(self.id(id))", json: ["title": .string(title)]))
    }

    public func deleteThread(id: String) async throws {
        _ = try await call("DELETE", "/threads/\(self.id(id))")
    }

    public func projects() async throws -> [MacProject] {
        try (try await call("GET", "/projects")["projects"]?.array ?? []).map(MacProject.init)
    }

    // MARK: board

    public func boardTasks() async throws -> [BoardTask] {
        try (try await call("GET", "/board/tasks")["tasks"]?.array ?? []).map(BoardTask.init)
    }

    public func createBoardTask(column: BoardColumn, title: String, description: String, priority: String) async throws -> BoardTask {
        try BoardTask(try await call("POST", "/board/tasks", json: [
            "column": .string(column.rawValue), "title": .string(title),
            "description": .string(description), "priority": .string(priority),
        ]))
    }

    public func moveBoardTask(id: String, to column: BoardColumn, position: Int?) async throws -> BoardTask {
        var body: [String: JSONValue] = ["column": .string(column.rawValue)]
        if let position { body["position"] = .number(Double(position)) }
        return try BoardTask(try await call("PATCH", "/board/tasks/\(self.id(id))", json: .object(body)))
    }

    public func updateBoardTask(id: String, title: String?, description: String?, priority: String?) async throws -> BoardTask {
        var body: [String: JSONValue] = [:]
        if let title { body["title"] = .string(title) }
        if let description { body["description"] = .string(description) }
        if let priority { body["priority"] = .string(priority) }
        return try BoardTask(try await call("PATCH", "/board/tasks/\(self.id(id))", json: .object(body)))
    }

    public func deleteBoardTask(id: String) async throws {
        _ = try await call("DELETE", "/board/tasks/\(self.id(id))")
    }

    // MARK: memory approvals

    public func pendingFacts() async throws -> [PendingFact] {
        try (try await call("GET", "/memory/pending")["pending"]?.array ?? []).map(PendingFact.init)
    }

    public func approvePendingFact(id: Int) async throws {
        _ = try await call("POST", "/memory/pending/\(id)/approve")
    }

    public func declinePendingFact(id: Int) async throws {
        _ = try await call("POST", "/memory/pending/\(id)/decline")
    }

    // MARK: uploads

    public func upload(data: Data, filename: String, mimeType: String) async throws -> MacAttachment {
        let boundary = "oni-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(Self.quoted(filename))\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var req = try makeRequest("POST", "/uploads", timeout: 120)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return try MacAttachment(try await send(req))
    }

    /// Keeps a filename from breaking out of its quoted header value. Works on
    /// unicode scalars: "\r\n" is ONE Character in Swift, so filtering
    /// Characters for "\r" and "\n" lets a CRLF straight through (a header
    /// injection the upload test caught).
    static func quoted(_ filename: String) -> String {
        String(String.UnicodeScalarView(filename.unicodeScalars.filter {
            $0 != "\"" && $0.properties.generalCategory != .control
        }))
    }
}
