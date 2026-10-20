import Foundation

public struct NoteInfo: Sendable, Equatable, Hashable, Identifiable {
    public var path: String
    public var modified: Date?
    public var size: Int
    public var id: String { path }
    public var title: String { NotePath.title(of: path) }
    /// The first path component, `nil` for a Note at the Vault root.
    public var folder: String? { NotePath.topLevelFolder(of: path) }

    public init(path: String, modified: Date? = nil, size: Int = 0) {
        self.path = path
        self.modified = modified
        self.size = size
    }
}

public struct SearchResult: Sendable, Equatable, Identifiable {
    public var path: String
    public var title: String
    public var snippet: String
    public var titleMatched: Bool
    public var id: String { path }
}

/// Everything the Replica holds, in memory: titles for wikilink resolution and
/// full text for keyword search. 450 Notes is ~4 MB, so there is no database.
public struct NoteIndex: Sendable {
    struct Entry: Sendable {
        var info: NoteInfo
        var text: String
        var lowerText: String
        var lowerTitle: String
    }

    var entries: [Entry]
    private let byTitle: [String: [Int]]
    private let byLowerTitle: [String: [Int]]

    public static let maxResults = 20
    private static let snippetRadius = 80

    public init(notes: [(info: NoteInfo, text: String)]) {
        let sorted = notes.sorted { $0.info.path.localizedStandardCompare($1.info.path) == .orderedAscending }
        entries = sorted.map {
            Entry(info: $0.info, text: $0.text, lowerText: $0.text.lowercased(),
                  lowerTitle: $0.info.title.lowercased())
        }
        var exact: [String: [Int]] = [:]
        var lower: [String: [Int]] = [:]
        for (i, e) in entries.enumerated() {
            exact[e.info.title, default: []].append(i)
            lower[e.lowerTitle, default: []].append(i)
        }
        byTitle = exact
        byLowerTitle = lower
    }

    public var notes: [NoteInfo] { entries.map(\.info) }
    public var count: Int { entries.count }

    public func text(of path: String) -> String? {
        entries.first { $0.info.path == path }?.text
    }

    /// Resolves a wikilink target to a Note path: exact title first, then
    /// case-insensitive; a target containing `/` is treated as a path (with or
    /// without `.md`). The shortest path wins a tie, so a root Note beats a
    /// same-named one buried in a course folder.
    public func resolve(_ target: String) -> String? {
        let t = target.trimmingCharacters(in: .whitespaces)
        if t.contains("/") {
            let path = t.hasSuffix(".md") ? t : t + ".md"
            return entries.first { $0.info.path == path }?.info.path
        }
        let hits = byTitle[t] ?? byLowerTitle[t.lowercased()] ?? []
        return hits.map { entries[$0].info.path }.min { $0.count < $1.count }
    }

    /// Case-insensitive substring match on title or text, like the Mac's
    /// `search_vault`; title matches first. The snippet comes from the body,
    /// never the frontmatter.
    public func search(_ query: String) -> [SearchResult] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        var titleHits: [SearchResult] = []
        var textHits: [SearchResult] = []
        for e in entries {
            let inTitle = e.lowerTitle.contains(needle)
            guard inTitle || e.lowerText.contains(needle) else { continue }
            let result = SearchResult(
                path: e.info.path, title: e.info.title,
                snippet: Self.snippet(in: e.text, needle: needle), titleMatched: inTitle)
            if inTitle { titleHits.append(result) } else { textHits.append(result) }
        }
        return Array((titleHits + textHits).prefix(Self.maxResults))
    }

    static func snippet(in text: String, needle: String) -> String {
        let body = Frontmatter.split(text).body
        guard let range = body.range(of: needle, options: [.caseInsensitive, .literal]) else { return "" }
        let start = body.index(range.lowerBound, offsetBy: -snippetRadius, limitedBy: body.startIndex) ?? body.startIndex
        let end = body.index(range.upperBound, offsetBy: snippetRadius, limitedBy: body.endIndex) ?? body.endIndex
        let flat = body[start..<end].replacingOccurrences(of: "\n", with: " ")
        return "…" + flat.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Notes that link to `path`, by title.
    public func backlinks(to path: String) -> [NoteInfo] {
        let title = NotePath.title(of: path).lowercased()
        return entries.filter { e in
            e.info.path != path
                && WikiLinks.targets(in: e.text).contains { target in
                    target.lowercased() == title || resolve(target) == path
                }
        }.map(\.info)
    }
}

extension Replica {
    /// Path, modification time and size of every Note — no file is read.
    public func listNotes() -> [NoteInfo] {
        let root = notesRoot.resolvingSymlinksInPath()
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { return [] }
        var out: [NoteInfo] = []
        for case let url as URL in walker where url.pathExtension == "md" {
            let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey])
            guard v?.isRegularFile == true else { continue }
            let full = url.resolvingSymlinksInPath().path
            guard full.hasPrefix(prefix) else { continue }
            let rel = String(full.dropFirst(prefix.count))
            guard NotePath.isValid(rel) else { continue }
            out.append(NoteInfo(path: rel, modified: v?.contentModificationDate, size: v?.fileSize ?? 0))
        }
        return out
    }

    /// Reads every Note into a searchable index.
    public func buildIndex() -> NoteIndex {
        NoteIndex(notes: listNotes().compactMap { info in
            text(info.path).map { (info, $0) }
        })
    }
}
