import Foundation

public struct ToolOutput: Sendable, Equatable {
    public var text: String
    public var isError: Bool
    /// The Replica changed, so the app should refresh and schedule a sync.
    public var wroteVault: Bool
}

/// The five Vault tools, ported from `assistant/obsidian_tools.py` so the
/// phone's Oni behaves like the Mac's (docs/adr/0001-0004): fully ungated, no
/// per-turn write cap, `oni: true` required to update or delete, a delete is
/// recoverable (the next sync moves the Mac's copy to `_trash/`). Result
/// strings match the Mac's on purpose. Run against the Replica, so every tool
/// works with the Mac off.
public struct VaultToolbox: Sendable {
    public typealias Semantic = @Sendable (String) async throws -> [SearchHit]

    private let replica: Replica
    private let semantic: Semantic?
    private let today: @Sendable () -> String

    static let maxResults = 20
    static let maxReadBytes = 200_000
    static let maxRelated = 5
    /// Mirrors `_TITLE_STOPWORDS`: connective words in almost every title.
    static let stopwords: Set<String> = [
        "with", "from", "into", "your", "about", "this", "that", "note", "notes", "overview", "and", "the", "for",
    ]

    public init(replica: Replica, semantic: Semantic? = nil, today: @escaping @Sendable () -> String = VaultToolbox.localDate) {
        self.replica = replica
        self.semantic = semantic
        self.today = today
    }

    /// `date.today().isoformat()`, in the phone's local time like the Mac's.
    public static func localDate() -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    // MARK: Definitions

    public static let definitions: [JSONValue] = [
        tool("search_vault", """
            Search Oni's own note vault (title and content) for `query` — substring match, case-insensitive, plus a \
            semantic supplement (when the Mac is reachable) so a paraphrase or synonym-shaped query can still find a \
            relevant note; a result marked "(semantic match...)" didn't literally contain your search text but is \
            topically related. Use this to check whether something related already exists before writing a new note, \
            or to find a note to read/update/delete.
            """, ["query": "Search text."]),
        tool("read_vault_note", "Read one note from Oni's own note vault by its exact title.",
             ["title": "The note's title (matches its filename, without `.md`)."]),
        tool("write_vault_note", """
            Create a NEW note in Oni's own note vault — a persistent store for information that doesn't need to be \
            loaded every run but might be useful later. Redundancy across notes is fine; don't hold back for fear of \
            duplicating something. This tool automatically searches existing note titles for related notes and links \
            them in — you don't need to call search_vault yourself first or write your own [[wikilinks]] for that \
            purpose. Do NOT include your own YAML frontmatter in `content` — it's added automatically. Fails if a \
            note with this exact title already exists — use update_vault_note to change an existing one instead.
            """, ["title": "The new note's title (becomes its filename).",
                  "content": "The note's body (markdown, no frontmatter)."]),
        tool("update_vault_note", """
            Fully replace an existing note's body in Oni's own note vault — pass the COMPLETE new body, not a diff. \
            If you need to preserve part of the current content, read_vault_note it first. Refuses to update a note \
            that wasn't created by Oni (no `oni: true` marker), so a note the user wrote themselves can't be silently \
            overwritten. Do NOT include your own YAML frontmatter in `content` — it's preserved/added automatically.
            """, ["title": "The existing note's exact title.",
                  "content": "The complete new body (markdown, no frontmatter)."]),
        tool("delete_vault_note", """
            Delete a note from Oni's own note vault — it is moved to the vault's trash folder, not erased, so the \
            user can restore it. Refuses to delete a note that wasn't created by Oni (no `oni: true` marker) — this \
            is the standing protection for anything the user wrote themselves.
            """, ["title": "The note's exact title."]),
    ]

    private static func tool(_ name: String, _ description: String, _ args: KeyValuePairs<String, String>) -> JSONValue {
        var properties: [String: JSONValue] = [:]
        for (key, text) in args { properties[key] = ["type": "string", "description": .string(text)] }
        return [
            "name": .string(name),
            "description": .string(description),
            "input_schema": [
                "type": "object",
                "properties": .object(properties),
                "required": .array(args.map { .string($0.key) }),
                "additionalProperties": false,
            ],
        ]
    }

    // MARK: Dispatch

    public func execute(name: String, input: JSONValue) async -> ToolOutput {
        func arg(_ key: String) -> String? { input[key]?.string }
        func missing(_ key: String) -> ToolOutput {
            ToolOutput(text: "Error: missing required argument '\(key)'.", isError: true, wroteVault: false)
        }
        switch name {
        case "search_vault":
            guard let q = arg("query") else { return missing("query") }
            return finish(await search(q))
        case "read_vault_note":
            guard let t = arg("title") else { return missing("title") }
            return finish(read(t))
        case "write_vault_note":
            guard let t = arg("title") else { return missing("title") }
            guard let c = arg("content") else { return missing("content") }
            return finish(write(t, c), wrote: true)
        case "update_vault_note":
            guard let t = arg("title") else { return missing("title") }
            guard let c = arg("content") else { return missing("content") }
            return finish(update(t, c), wrote: true)
        case "delete_vault_note":
            guard let t = arg("title") else { return missing("title") }
            return finish(delete(t), wrote: true)
        default:
            return ToolOutput(text: "Error: unknown tool '\(name)'.", isError: true, wroteVault: false)
        }
    }

    /// A result starting "Error:" is a failure (Anthropic's `is_error`), which
    /// is also what the agent's repeated-failure breaker counts.
    private func finish(_ text: String, wrote: Bool = false) -> ToolOutput {
        let isError = text.hasPrefix("Error:")
        return ToolOutput(text: text, isError: isError, wroteVault: wrote && !isError)
    }

    // MARK: Helpers

    static func sanitize(_ title: String) -> String? {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/", with: "-")
        return cleaned.isEmpty ? nil : cleaned
    }

    /// A Note by exact title anywhere in the Replica (case-sensitive, like the
    /// Mac). If titles collide the shortest path wins, then alphabetical.
    private func findExisting(_ title: String) -> String? {
        guard let target = Self.sanitize(title) else { return nil }
        return replica.listNotes().map(\.path)
            .filter { NotePath.title(of: $0) == target }
            .min { ($0.count, $0) < ($1.count, $1) }
    }

    static func frontmatter(created: String, updated: String? = nil) -> String {
        var lines = ["---", "oni: true", "created: \(created)"]
        if let updated { lines.append("updated: \(updated)") }
        lines.append("---")
        return lines.joined(separator: "\n") + "\n\n"
    }

    private static func rstripNewlines(_ s: String) -> String {
        var out = Substring(s)
        while out.last == "\n" { out = out.dropLast() }
        return String(out)
    }

    private static func words(_ s: String) -> [String] {
        var out: [String] = []
        var current = ""
        for ch in s.lowercased() {
            if ch.isASCII, ch.isLetter { current.append(ch) } else { if current.count >= 4 { out.append(current) }; current = "" }
        }
        if current.count >= 4 { out.append(current) }
        return out
    }

    /// Mirrors `_related_notes`: title-only keyword overlap, best first.
    static func relatedNotes(for title: String, among existing: [String]) -> [String] {
        let mine = Set(words(title)).subtracting(stopwords)
        guard !mine.isEmpty else { return [] }
        var scored: [(overlap: Int, title: String)] = []
        for other in existing where other != title {
            let overlap = mine.intersection(Set(words(other))).count
            if overlap > 0 { scored.append((overlap, other)) }
        }
        scored.sort { $0.overlap != $1.overlap ? $0.overlap > $1.overlap : $0.title < $1.title }
        return scored.prefix(maxRelated).map(\.title)
    }

    // MARK: Tools

    private func search(_ query: String) async -> String {
        let needle = query.lowercased()
        let index = replica.buildIndex()
        var hits: [String] = []
        var exact = Set<String>()
        for e in index.entries where e.lowerTitle.contains(needle) || e.lowerText.contains(needle) {
            let snippet = NoteIndex.snippet(in: e.text, needle: needle)
            hits.append("[[\(e.info.title)]]" + (snippet.isEmpty ? "" : " — " + snippet))
            exact.insert(e.info.title)
        }

        var semanticLines: [String] = []
        var unavailable = false
        if let semantic {
            do {
                for hit in try await semantic(query) where !exact.contains(hit.title) {
                    semanticLines.append(
                        "[[\(hit.title)]] (semantic match, no exact text overlap, score=\(String(format: "%.2f", hit.score)))")
                }
            } catch {
                unavailable = true
            }
        } else {
            unavailable = true
        }
        let note = unavailable
            ? "\n(Semantic search unavailable — the Mac isn't reachable — so these are keyword matches only.)" : ""

        if hits.isEmpty && semanticLines.isEmpty { return "No notes found matching '\(query)'." + note }
        var lines = hits.prefix(Self.maxResults).joined(separator: "\n")
        if hits.count > Self.maxResults { lines += "\n... and \(hits.count - Self.maxResults) more (truncated)" }
        if !semanticLines.isEmpty { lines = lines.isEmpty ? semanticLines.joined(separator: "\n") : lines + "\n" + semanticLines.joined(separator: "\n") }
        return lines + note
    }

    private func read(_ title: String) -> String {
        guard let path = findExisting(title), let data = replica.read(path) else {
            return "Error: no note titled '\(title)' found in the vault."
        }
        if data.count > Self.maxReadBytes {
            return "Error: '\(title)' is too large to read (\(data.count) bytes, cap \(Self.maxReadBytes))"
        }
        guard let text = String(data: data, encoding: .utf8) else { return "Error: '\(title)' is not a text file" }
        return text
    }

    private func write(_ title: String, _ content: String) -> String {
        guard let clean = Self.sanitize(title) else { return "Error: title cannot be empty." }
        let path = clean + ".md"
        guard NotePath.isValid(path) else { return "Error: '\(title)' can't be used as a note title." }
        if findExisting(title) != nil {
            return "Error: a note titled '\(title)' already exists — use update_vault_note instead."
        }
        let related = Self.relatedNotes(for: clean, among: replica.listNotes().map { NotePath.title(of: $0.path) })
        var body = Self.rstripNewlines(content) + "\n"
        if !related.isEmpty {
            body += "\n## Related Notes\n\n" + related.map { "- [[\($0)]]" }.joined(separator: "\n") + "\n"
        }
        do { try replica.write(path, text: Self.frontmatter(created: today()) + body) }
        catch { return "Error: could not save '\(clean)': \(error)" }
        return related.isEmpty
            ? "Created '\(clean)' (no related notes found to link)."
            : "Created '\(clean)', linked to \(related.count) related note(s): \(related.joined(separator: ", "))."
    }

    private func update(_ title: String, _ content: String) -> String {
        guard let path = findExisting(title) else {
            return "Error: no note titled '\(title)' found in the vault — use write_vault_note to create it."
        }
        guard let current = replica.text(path) else { return "Error: could not read '\(title)' before updating it." }
        guard Frontmatter.isOniAuthored(current) else {
            return "Error: '\(title)' was not created by Oni (no 'oni: true' marker) — refusing to overwrite a note the user may have written themselves."
        }
        let created = Frontmatter.field("created", in: current) ?? today()
        let full = Self.frontmatter(created: created, updated: today()) + Self.rstripNewlines(content) + "\n"
        do { try replica.write(path, text: full) } catch { return "Error: could not save '\(title)': \(error)" }
        return "Updated '\(title)' (\(current.count) -> \(full.count) bytes)."
    }

    private func delete(_ title: String) -> String {
        guard let path = findExisting(title) else { return "Error: no note titled '\(title)' found in the vault." }
        guard let current = replica.text(path) else { return "Error: could not read '\(title)' before deleting it." }
        guard Frontmatter.isOniAuthored(current) else {
            return "Error: '\(title)' was not created by Oni (no 'oni: true' marker) — refusing to delete a note the user may have written themselves."
        }
        do { try replica.remove(path) } catch { return "Error: could not delete '\(title)': \(error)" }
        return "Deleted '\(title)' (moved to the vault's trash; the user can restore it)."
    }
}
