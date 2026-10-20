import Foundation

/// A Conflict copy the phone created: its own edit to a Note that had also
/// changed on the Mac. The phone's version is safe in three places — the Mac's
/// `_conflicts/` folder, a local copy here, and (once resolved) the Note.
public struct ConflictRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var originalPath: String
    /// Where the copy lives on the Mac, inside `_conflicts/`.
    public var serverPath: String
    public var phoneSha256: String
    public var createdAt: Date
    /// The user has chosen; only the Mac-side copy still needs removing.
    public var resolved: Bool

    public init(
        id: String = UUID().uuidString, originalPath: String, serverPath: String,
        phoneSha256: String, createdAt: Date = Date(), resolved: Bool = false
    ) {
        self.id = id
        self.originalPath = originalPath
        self.serverPath = serverPath
        self.phoneSha256 = phoneSha256
        self.createdAt = createdAt
        self.resolved = resolved
    }
}

/// What the sync engine remembers between runs.
public struct SyncState: Codable, Sendable, Equatable {
    /// path → SHA-256 of the version the phone and the Mac last agreed on.
    /// This is the "base" of a three-way comparison: a Note whose local hash
    /// differs from it has been edited on the phone; one whose Mac hash
    /// differs has been edited on the Mac.
    public var base: [String: String] = [:]
    /// Top-level folders the user switched off. Their Notes are not held on
    /// the phone and are invisible to on-device Oni.
    public var disabledFolders: Set<String> = []
    /// Every top-level folder seen so far, so a switched-off one stays listed.
    public var knownFolders: Set<String> = []
    public var conflicts: [ConflictRecord] = []
    public var lastSyncedAt: Date?

    public init() {}
}

public enum ReplicaError: Error, Equatable {
    case invalidPath(String)
}

/// The phone's copy of the Vault's Notes, as plain `.md` files, plus the sync
/// state beside them. All file access for sync goes through here.
public struct Replica: Sendable {
    public let notesRoot: URL
    private let stateURL: URL
    private let conflictsRoot: URL

    public init(directory: URL) {
        notesRoot = directory.appendingPathComponent("notes", isDirectory: true)
        stateURL = directory.appendingPathComponent("sync-state.json")
        conflictsRoot = directory.appendingPathComponent("conflict-copies", isDirectory: true)
        try? FileManager.default.createDirectory(at: notesRoot, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: conflictsRoot, withIntermediateDirectories: true)
    }

    // MARK: State

    public func loadState() -> SyncState {
        guard let data = try? Data(contentsOf: stateURL) else { return SyncState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let state = try? decoder.decode(SyncState.self, from: data) { return state }
        // Unreadable state is set aside, not trusted and not silently lost.
        // Starting empty is safe by construction: every Note then looks "new
        // on both sides", and a difference becomes a Conflict copy, never an
        // overwrite.
        try? FileManager.default.moveItem(
            at: stateURL, to: stateURL.appendingPathExtension("corrupt"))
        return SyncState()
    }

    public func saveState(_ state: SyncState) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(state).write(to: stateURL, options: .atomic)
    }

    // MARK: Notes

    private func url(for path: String) throws -> URL {
        guard NotePath.isValid(path) else { throw ReplicaError.invalidPath(path) }
        return notesRoot.appendingPathComponent(path)
    }

    public func read(_ path: String) -> Data? {
        guard let u = try? url(for: path) else { return nil }
        return try? Data(contentsOf: u)
    }

    public func text(_ path: String) -> String? {
        read(path).flatMap { String(data: $0, encoding: .utf8) }
    }

    public func write(_ path: String, data: Data) throws {
        let u = try url(for: path)
        try FileManager.default.createDirectory(
            at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: u, options: .atomic)
    }

    public func write(_ path: String, text: String) throws {
        try write(path, data: Data(text.utf8))
    }

    public func remove(_ path: String) throws {
        let u = try url(for: path)
        try? FileManager.default.removeItem(at: u)
        // Prune folders left empty, but never the Replica root itself.
        var dir = u.deletingLastPathComponent()
        let root = notesRoot.resolvingSymlinksInPath().path
        while dir.resolvingSymlinksInPath().path != root, dir.path.count > notesRoot.path.count {
            let contents = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
            guard contents.isEmpty else { break }
            try? FileManager.default.removeItem(at: dir)
            dir = dir.deletingLastPathComponent()
        }
    }

    public func removeFolder(_ name: String) throws {
        guard !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else {
            throw ReplicaError.invalidPath(name)
        }
        try? FileManager.default.removeItem(at: notesRoot.appendingPathComponent(name, isDirectory: true))
    }

    public func hash(of path: String) -> String? {
        read(path).map(sha256Hex)
    }

    /// path → SHA-256 for every Note on the phone. Hidden files, anything
    /// not `.md`, and anything whose path would be rejected are ignored.
    public func localHashes() throws -> [String: String] {
        let root = notesRoot.resolvingSymlinksInPath()
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { return [:] }
        var out: [String: String] = [:]
        for case let fileURL as URL in walker where fileURL.pathExtension == "md" {
            let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey])
            guard values?.isRegularFile == true else { continue }
            let full = fileURL.resolvingSymlinksInPath().path
            guard full.hasPrefix(prefix) else { continue }
            let rel = String(full.dropFirst(prefix.count))
            guard NotePath.isValid(rel), let data = try? Data(contentsOf: fileURL) else { continue }
            out[rel] = sha256Hex(data)
        }
        return out
    }

    /// Deletes every Note, the sync state and the kept Conflict copies, leaving an
    /// empty Replica. Anything not yet synced is gone — callers must say so.
    public func wipe() {
        let fm = FileManager.default
        for url in [notesRoot, conflictsRoot, stateURL, stateURL.appendingPathExtension("corrupt")] {
            try? fm.removeItem(at: url)
        }
        try? fm.createDirectory(at: notesRoot, withIntermediateDirectories: true)
        try? fm.createDirectory(at: conflictsRoot, withIntermediateDirectories: true)
    }

    // MARK: Conflict copies (the phone's own version, kept locally too)

    public func saveConflictCopy(id: String, data: Data) throws {
        try data.write(to: conflictsRoot.appendingPathComponent("\(id).md"), options: .atomic)
    }

    public func conflictCopy(id: String) -> Data? {
        try? Data(contentsOf: conflictsRoot.appendingPathComponent("\(id).md"))
    }

    public func removeConflictCopy(id: String) {
        try? FileManager.default.removeItem(at: conflictsRoot.appendingPathComponent("\(id).md"))
    }
}
