import Foundation

public struct ManifestEntry: Codable, Sendable, Equatable {
    public var path: String
    public var sha256: String
    public var mtime: Int
    public var size: Int

    public init(path: String, sha256: String, mtime: Int = 0, size: Int = 0) {
        self.path = path
        self.sha256 = sha256
        self.mtime = mtime
        self.size = size
    }
}

public struct RemoteNote: Codable, Sendable, Equatable {
    public var path: String
    public var sha256: String
    public var mtime: Int
    public var size: Int
    public var content: String

    public init(path: String, sha256: String, mtime: Int = 0, size: Int = 0, content: String) {
        self.path = path
        self.sha256 = sha256
        self.mtime = mtime
        self.size = size
        self.content = content
    }
}

public struct PutResult: Codable, Sendable, Equatable {
    public var path: String
    public var sha256: String
    public var recreated: Bool

    public init(path: String, sha256: String, recreated: Bool = false) {
        self.path = path
        self.sha256 = sha256
        self.recreated = recreated
    }
}

public struct StoredCopy: Codable, Sendable, Equatable {
    public var path: String
    public var sha256: String
    public var originalPath: String?

    public init(path: String, sha256: String, originalPath: String? = nil) {
        self.path = path
        self.sha256 = sha256
        self.originalPath = originalPath
    }
}

public struct SearchHit: Codable, Sendable, Equatable {
    public var title: String
    public var path: String
    public var score: Double
}

public struct Ping: Codable, Sendable, Equatable {
    public var ok: Bool
    public var vault: String
    public var notes: Int
}

public enum VaultServerError: Error, Equatable, Sendable {
    /// 401 — the token is missing, wrong or was rotated.
    case unauthorized
    /// 409 `stale` — the Mac's copy changed since the phone last synced it.
    case stale(currentSha256: String)
    /// 409 `exists` — creating a Note whose path is already taken.
    case exists(currentSha256: String?)
    /// 404.
    case missing
    /// The Mac could not be reached (offline, Tailscale off, backend down).
    case unreachable(String)
    case server(status: Int, message: String)
}

/// The Mac's `/vault` API (assistant/vault_sync.py). A protocol so the sync
/// engine is tested against both an in-memory model and the real backend.
public protocol VaultServer: Sendable {
    func ping() async throws -> Ping
    func manifest() async throws -> [ManifestEntry]
    func note(path: String) async throws -> RemoteNote
    func put(path: String, content: String, baseSha256: String?) async throws -> PutResult
    /// Soft delete: the Mac moves the Note to `_trash/`.
    func delete(path: String, baseSha256: String) async throws
    func uploadConflict(path: String, content: String) async throws -> StoredCopy
    func listConflicts() async throws -> [StoredCopy]
    func resolveConflict(path: String) async throws
    func listTrash() async throws -> [StoredCopy]
    func restoreFromTrash(path: String) async throws -> String
    func emptyTrash() async throws -> Int
    func search(_ query: String) async throws -> [SearchHit]
}
