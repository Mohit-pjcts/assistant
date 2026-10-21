import Foundation

// Plain value types for what the Mac's API returns (assistant/server.py).
// Each is decoded by hand from `JSONValue` rather than with `Decodable`, so a
// field the server adds later is ignored instead of breaking the screen, and a
// field that is wrongly typed fails loudly with its name.

public struct MacAPIError: Error, Equatable, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

extension JSONValue {
    func requireString(_ key: String, in what: String) throws -> String {
        guard let s = self[key]?.string else { throw MacAPIError("\(what): '\(key)' missing or not a string") }
        return s
    }
}

/// A conversation on the Mac (shared with the dashboard).
public struct MacThread: Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String?
    public let createdAt: String
    public let lastActiveAt: String
    /// The Project folder it sits in, if any. The app only reads this.
    public let projectId: String?

    init(_ json: JSONValue) throws {
        id = try json.requireString("id", in: "thread")
        title = json["title"]?.string
        createdAt = json["created_at"]?.string ?? ""
        lastActiveAt = json["last_active_at"]?.string ?? ""
        projectId = json["project_id"]?.string
    }
}

public struct MacProject: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let color: String

    init(_ json: JSONValue) throws {
        id = try json.requireString("id", in: "project")
        name = try json.requireString("name", in: "project")
        color = json["color"]?.string ?? ""
    }
}

/// One message of a thread as `/history` returns it.
public struct MacMessage: Sendable, Equatable {
    /// "user", "assistant" or "tool".
    public let role: String
    public let content: String
    /// True for a user-role message the graph inserted itself (recalled
    /// facts, the compaction summary): not something the person typed.
    public let synthetic: Bool
    /// On a tool message the tool; on an assistant message the agent.
    public let name: String?
    /// Generative-UI surfaces attached to this message, as sent. Validate with
    /// `A2UISurface.parse` before drawing; an invalid one is skipped.
    public let surfaces: [JSONValue]

    init(_ json: JSONValue) throws {
        role = try json.requireString("role", in: "message")
        content = json["content"]?.string ?? ""
        synthetic = json["synthetic"]?.bool ?? false
        name = json["name"]?.string
        surfaces = json["surfaces"]?.array ?? []
    }
}

public enum BoardColumn: String, Sendable, CaseIterable, Equatable {
    case todo, inProgress = "in-progress", inReview = "in-review", done
}

public struct BoardTask: Sendable, Equatable, Identifiable {
    public let id: String
    public let column: BoardColumn
    public let ref: String
    public let priority: String
    public let title: String
    public let description: String
    public let position: Int

    init(_ json: JSONValue) throws {
        id = try json.requireString("id", in: "task")
        let columnName = try json.requireString("column", in: "task")
        guard let column = BoardColumn(rawValue: columnName) else { throw MacAPIError("task: unknown column '\(columnName)'") }
        self.column = column
        ref = try json.requireString("ref", in: "task")
        priority = json["priority"]?.string ?? "medium"
        title = try json.requireString("title", in: "task")
        description = json["description"]?.string ?? ""
        position = json["position"]?.int ?? 0
    }
}

/// A fact Oni's nightly review proposed remembering, waiting for approval.
public struct PendingFact: Sendable, Equatable, Identifiable {
    public let id: Int
    public let content: String
    public let provenance: String?
    public let createdAt: String

    init(_ json: JSONValue) throws {
        guard let id = json["id"]?.int else { throw MacAPIError("pending fact: 'id' missing") }
        self.id = id
        content = try json.requireString("content", in: "pending fact")
        provenance = json["provenance"]?.string
        createdAt = json["created_at"]?.string ?? ""
    }
}

/// What `/uploads` returned; sent back on the `/chat` call that uses it.
public struct MacAttachment: Sendable, Equatable {
    public let path: String
    public let mimeType: String
    public let kind: String
    public let filename: String

    init(_ json: JSONValue) throws {
        path = try json.requireString("path", in: "attachment")
        mimeType = try json.requireString("mime_type", in: "attachment")
        kind = try json.requireString("kind", in: "attachment")
        filename = try json.requireString("filename", in: "attachment")
    }

    var json: JSONValue {
        ["path": .string(path), "mime_type": .string(mimeType), "kind": .string(kind), "filename": .string(filename)]
    }
}

/// Where a thread's turn stands (`GET /threads/{id}/turn`): what the app asks
/// after it was away, to learn whether the Mac finished, is still working, or
/// is waiting for an approval.
public struct TurnState: Sendable, Equatable {
    public enum Status: Sendable, Equatable { case running, waitingForApproval, idle }
    public enum Ending: Sendable, Equatable { case completed, cancelled, error(String) }

    public let status: Status
    /// Set only when `status == .waitingForApproval` and the payload could be
    /// shown. An unreadable gate is `gateUnreadable`: decline it.
    public let gate: Gate?
    public let gateUnreadable: Bool
    /// How the most recent detached turn on this thread ended, if one did
    /// since the server started.
    public let last: Ending?

    init(_ json: JSONValue) throws {
        switch json["status"]?.string {
        case "running": status = .running
        case "waiting_for_approval": status = .waitingForApproval
        case "idle": status = .idle
        default: throw MacAPIError("turn state: unknown status")
        }
        if status == .waitingForApproval, let payload = json["gate"] {
            gate = Gate.parse(payload)
            gateUnreadable = gate == nil
        } else {
            gate = nil
            gateUnreadable = status == .waitingForApproval
        }
        switch json["last"]?["outcome"]?.string {
        case "completed": last = .completed
        case "cancelled": last = .cancelled
        case "error": last = .error(json["last"]?["detail"]?.string ?? "the turn failed")
        default: last = nil
        }
    }
}

/// A thread list and the dashboard's currently active thread.
public struct ThreadList: Sendable, Equatable {
    public let threads: [MacThread]
    public let activeThreadId: String?
}
