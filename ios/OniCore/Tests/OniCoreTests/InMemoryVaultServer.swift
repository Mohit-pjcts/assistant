import Foundation
@testable import OniCore

/// A model of the Mac's /vault API (assistant/vault_sync.py) with the same
/// hash rules, for fast engine tests. It can drift from the real thing, which
/// is why `HTTPIntegrationTests` runs the same engine against the real backend.
actor InMemoryVaultServer: VaultServer {
    var notes: [String: String] = [:]
    var trash: [String: String] = [:]
    var conflictCopies: [String: String] = [:]

    var offline = false
    /// Throws `.unreachable` on the Nth call from now (1 = the next call).
    var dropAfterCalls: Int?
    var callLog: [String] = []
    /// Runs just before `note(path:)` returns — lets a test edit the phone's
    /// file "while the sync is running".
    var duringNote: (@Sendable (String) -> Void)?

    func setOffline(_ value: Bool) { offline = value }
    func setDropAfter(_ n: Int?) { dropAfterCalls = n }
    func setDuringNote(_ hook: (@Sendable (String) -> Void)?) { duringNote = hook }
    func macWrite(_ path: String, _ text: String) { notes[path] = text }
    func macDelete(_ path: String) { notes[path] = nil }
    func text(_ path: String) -> String? { notes[path] }

    private func gate(_ name: String) throws {
        callLog.append(name)
        if offline { throw VaultServerError.unreachable("offline") }
        if let n = dropAfterCalls {
            if n <= 1 {
                dropAfterCalls = nil
                throw VaultServerError.unreachable("connection dropped")
            }
            dropAfterCalls = n - 1
        }
    }

    func ping() async throws -> Ping {
        try gate("ping")
        return Ping(ok: true, vault: "OniVault", notes: notes.count)
    }

    func manifest() async throws -> [ManifestEntry] {
        try gate("manifest")
        return notes.map { ManifestEntry(path: $0.key, sha256: sha256Hex($0.value)) }
    }

    func note(path: String) async throws -> RemoteNote {
        try gate("note")
        guard let content = notes[path] else { throw VaultServerError.missing }
        duringNote?(path)
        return RemoteNote(path: path, sha256: sha256Hex(content), content: content)
    }

    func put(path: String, content: String, baseSha256: String?) async throws -> PutResult {
        try gate("put")
        let newHash = sha256Hex(content)
        if let current = notes[path] {
            let currentHash = sha256Hex(current)
            if currentHash == newHash { return PutResult(path: path, sha256: newHash) }
            guard let base = baseSha256 else { throw VaultServerError.exists(currentSha256: currentHash) }
            guard base == currentHash else { throw VaultServerError.stale(currentSha256: currentHash) }
            notes[path] = content
            return PutResult(path: path, sha256: newHash)
        }
        notes[path] = content
        return PutResult(path: path, sha256: newHash, recreated: baseSha256 != nil)
    }

    func delete(path: String, baseSha256: String) async throws {
        try gate("delete")
        guard let current = notes[path] else { throw VaultServerError.missing }
        guard sha256Hex(current) == baseSha256 else {
            throw VaultServerError.stale(currentSha256: sha256Hex(current))
        }
        trash[path] = current
        notes[path] = nil
    }

    func uploadConflict(path: String, content: String) async throws -> StoredCopy {
        try gate("uploadConflict")
        let stem = NotePath.title(of: path)
        if let existing = conflictCopies.first(where: { $0.key.contains("/\(stem) (phone ") && $0.value == content }) {
            return StoredCopy(path: existing.key, sha256: sha256Hex(content), originalPath: path)
        }
        let key = "_conflicts/\(stem) (phone \(conflictCopies.count + 1)).md"
        conflictCopies[key] = content
        return StoredCopy(path: key, sha256: sha256Hex(content), originalPath: path)
    }

    func listConflicts() async throws -> [StoredCopy] {
        try gate("listConflicts")
        return conflictCopies.map { StoredCopy(path: $0.key, sha256: sha256Hex($0.value)) }
    }

    func resolveConflict(path: String) async throws {
        try gate("resolveConflict")
        guard conflictCopies.removeValue(forKey: path) != nil else { throw VaultServerError.missing }
    }

    func listTrash() async throws -> [StoredCopy] {
        try gate("listTrash")
        return trash.map { StoredCopy(path: "_trash/\($0.key)", sha256: sha256Hex($0.value), originalPath: $0.key) }
    }

    func restoreFromTrash(path: String) async throws -> String {
        try gate("restore")
        let original = String(path.dropFirst("_trash/".count))
        guard let content = trash.removeValue(forKey: original) else { throw VaultServerError.missing }
        notes[original] = content
        return original
    }

    func emptyTrash() async throws -> Int {
        try gate("emptyTrash")
        defer { trash = [:] }
        return trash.count
    }

    func search(_ query: String) async throws -> [SearchHit] {
        try gate("search")
        return []
    }
}
