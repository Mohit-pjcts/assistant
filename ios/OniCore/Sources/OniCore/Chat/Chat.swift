import Foundation

/// One phone-local conversation. Chats live only on this iPhone (PLAN.md
/// Phase 30): the Mac's threads are Phase 31.
public struct Chat: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var title: String
    public var createdAt: Date
    public var updatedAt: Date
    public var model: ClaudeModel
    public var messages: [JSONValue]
    /// Tokens this chat has used, summed over every call (and per model, since
    /// the user may switch mid-chat).
    public var usageByModel: [String: Usage]

    public init(id: UUID = UUID(), model: ClaudeModel, now: Date = Date()) {
        self.id = id
        title = "New chat"
        createdAt = now
        updatedAt = now
        self.model = model
        messages = []
        usageByModel = [:]
    }

    /// Estimated dollars spent in this chat.
    public var cost: Double {
        usageByModel.reduce(0) { sum, entry in
            sum + (ClaudeModel(rawValue: entry.key)?.cost(of: entry.value) ?? 0)
        }
    }

    public mutating func record(_ usage: Usage, model: ClaudeModel) {
        usageByModel[model.rawValue, default: Usage()].add(usage)
    }

    static func title(from text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > 48 ? String(trimmed.prefix(48)) + "…" : (trimmed.isEmpty ? "New chat" : trimmed)
    }

    public static func userMessage(_ text: String) -> JSONValue {
        ["role": "user", "content": [["type": "text", "text": .string(text)]]]
    }
}

/// What a chat screen shows, derived from the stored messages so there is only
/// one source of truth.
public enum TranscriptItem: Sendable, Equatable, Identifiable {
    case user(id: Int, text: String)
    case assistant(id: Int, text: String)
    case tool(id: Int, name: String, detail: String, failed: Bool)

    public var id: Int {
        switch self {
        case .user(let id, _), .assistant(let id, _), .tool(let id, _, _, _): id
        }
    }
}

public enum Transcript {
    public static func items(from messages: [JSONValue]) -> [TranscriptItem] {
        // tool_use id -> did the answering tool_result report an error
        var failed: [String: Bool] = [:]
        for m in messages where m["role"]?.string == "user" {
            for block in m["content"]?.array ?? [] where block["type"]?.string == "tool_result" {
                if let id = block["tool_use_id"]?.string { failed[id] = block["is_error"]?.bool ?? false }
            }
        }
        var items: [TranscriptItem] = []
        var n = 0
        func next() -> Int { n += 1; return n }
        for m in messages {
            let blocks = m["content"]?.array ?? (m["content"]?.string).map { [["type": "text", "text": .string($0)]] } ?? []
            switch m["role"]?.string {
            case "user":
                let text = blocks.compactMap { $0["type"]?.string == "text" ? $0["text"]?.string : nil }.joined(separator: "\n")
                if !text.isEmpty { items.append(.user(id: next(), text: text)) }
            case "assistant":
                for block in blocks {
                    switch block["type"]?.string {
                    case "text":
                        if let t = block["text"]?.string, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            items.append(.assistant(id: next(), text: t))
                        }
                    case "tool_use":
                        let name = block["name"]?.string ?? "tool"
                        items.append(.tool(id: next(), name: name, detail: detail(of: block["input"]),
                                           failed: failed[block["id"]?.string ?? ""] ?? false))
                    default: break
                    }
                }
            default: break
            }
        }
        return items
    }

    /// The one argument worth showing: a query or a note title.
    private static func detail(of input: JSONValue?) -> String {
        input?["query"]?.string ?? input?["title"]?.string ?? ""
    }

    /// Present-tense label for a tool, for the "Oni is…" indicator.
    public static func activity(forTool name: String) -> String {
        switch name {
        case "search_vault": "Searching the vault…"
        case "read_vault_note": "Reading a note…"
        case "write_vault_note": "Writing a note…"
        case "update_vault_note": "Updating a note…"
        case "delete_vault_note": "Deleting a note…"
        default: "Working…"
        }
    }
}

/// Chats on disk: one JSON file, written atomically. A few hundred KB at most.
public struct ChatStore: Sendable {
    private let url: URL

    public init(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent("chats.json")
    }

    public func load() -> [Chat] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([Chat].self, from: data)) ?? []
    }

    public func save(_ chats: [Chat]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(chats).write(to: url, options: .atomic)
    }
}

extension Chat {
    /// Applies a finished or interrupted turn's committed history.
    public mutating func apply(committed: [JSONValue], now: Date = Date()) {
        messages = committed
        updatedAt = now
        if title == "New chat",
           let first = committed.first(where: { $0["role"]?.string == "user" }),
           let text = first["content"]?.array?.first?["text"]?.string {
            title = Chat.title(from: text)
        }
    }
}
