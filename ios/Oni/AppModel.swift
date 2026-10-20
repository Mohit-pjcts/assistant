import Foundation
import Observation
import OniCore

struct FolderSetting: Identifiable, Equatable {
    var name: String
    var enabled: Bool
    var id: String { name }
}

enum VaultEditError: LocalizedError {
    case invalidTitle
    case exists(String)

    var errorDescription: String? {
        switch self {
        case .invalidTitle: "That title can't be used as a file name."
        case .exists(let path): "A note already exists at \(path)."
        }
    }
}

/// App-wide state: the pairing, the Replica and its index, and sync status.
/// Everything the views read is derived from the Replica on disk, so the app
/// is fully usable offline; the Mac only matters when a sync runs.
@MainActor @Observable
final class AppModel {
    private static let urlKey = "macURL"

    private(set) var baseURL: URL?
    let replica: Replica
    private(set) var server: HTTPVaultServer?
    private(set) var engine: SyncEngine?

    private(set) var index = NoteIndex(notes: [])
    private(set) var tree = NoteTree.build([])
    private(set) var conflicts: [ConflictRecord] = []
    private(set) var folders: [FolderSetting] = []
    /// Bumped on every change to the Replica so open screens reload.
    private(set) var revision = 0

    private(set) var isSyncing = false
    /// The last sync could not reach the Mac (offline, Tailscale off, backend down).
    private(set) var isOffline = false
    /// The Mac rejected the token (rotated, or the wrong one was pasted).
    private(set) var authFailed = false
    private(set) var lastSyncedAt: Date?
    private(set) var syncFailures: [PathFailure] = []
    private(set) var lastError: String?

    private var scheduledSync: Task<Void, Never>?

    var isPaired: Bool { server != nil }

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        replica = Replica(directory: support.appendingPathComponent("Replica", isDirectory: true))
        if let raw = UserDefaults.standard.string(forKey: Self.urlKey),
           let url = URL(string: raw), let token = Keychain.get(.vaultToken) {
            configure(url: url, token: token)
        }
        Task { await refreshLocal() }
    }

    // MARK: Pairing

    /// Accepts "my-mac.tail1234.ts.net" or a full URL.
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    /// Checks the address and token against the Mac, then stores them and syncs.
    func pair(address: String, token: String) async throws -> Ping {
        guard let url = Self.normalize(address) else {
            throw VaultServerError.unreachable("That doesn't look like an address.")
        }
        let cleaned = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let ping = try await HTTPVaultServer(baseURL: url, token: cleaned).ping()
        UserDefaults.standard.set(url.absoluteString, forKey: Self.urlKey)
        Keychain.set(cleaned, for: .vaultToken)
        configure(url: url, token: cleaned)
        Task { await sync() }
        return ping
    }

    private func configure(url: URL, token: String) {
        baseURL = url
        let server = HTTPVaultServer(baseURL: url, token: token)
        self.server = server
        engine = SyncEngine(server: server, replica: replica)
        authFailed = false
        isOffline = false
    }

    /// Forgets the Mac and deletes the Replica. Edits not yet synced are lost.
    func unpair() async {
        scheduledSync?.cancel()
        Keychain.delete(.vaultToken)
        UserDefaults.standard.removeObject(forKey: Self.urlKey)
        replica.wipe()
        server = nil
        engine = nil
        baseURL = nil
        lastSyncedAt = nil
        syncFailures = []
        lastError = nil
        await refreshLocal()
    }

    // MARK: Sync

    func sync() async {
        guard let engine, !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        do {
            let report = try await engine.sync()
            syncFailures = report.failures
            isOffline = false
            authFailed = false
            lastError = nil
        } catch VaultServerError.unauthorized {
            authFailed = true
            lastError = "The Mac rejected the token. Pair again in Settings."
        } catch VaultServerError.unreachable {
            isOffline = true
        } catch {
            lastError = Self.describe(error)
        }
        lastSyncedAt = await engine.currentState().lastSyncedAt
        await refreshLocal()
    }

    /// Syncs five seconds after the last edit, so a burst of typing is one sync.
    func scheduleSync() {
        scheduledSync?.cancel()
        scheduledSync = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            await self?.sync()
        }
    }

    func refreshLocal() async {
        let replica = self.replica
        let fresh = await Task.detached { replica.buildIndex() }.value
        index = fresh
        tree = NoteTree.build(fresh.notes)
        if let engine {
            conflicts = await engine.unresolvedConflicts()
            folders = await engine.folders().map { FolderSetting(name: $0.name, enabled: $0.enabled) }
            lastSyncedAt = await engine.currentState().lastSyncedAt
        } else {
            conflicts = []
            folders = []
        }
        revision += 1
    }

    // MARK: Editing (always against the Replica; sync carries it to the Mac)

    func text(of path: String) -> String? { replica.text(path) }

    func saveNote(path: String, text: String) async throws {
        try replica.write(path, text: text)
        await refreshLocal()
        scheduleSync()
    }

    /// Creates `<folder>/<title>.md` and returns its path.
    func createNote(title: String, in folder: String) async throws -> String {
        let clean = title
            .components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|\n")).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let path = (folder.isEmpty ? "" : folder + "/") + clean + ".md"
        guard !clean.isEmpty, !clean.hasPrefix("."), NotePath.isValid(path) else { throw VaultEditError.invalidTitle }
        guard replica.read(path) == nil else { throw VaultEditError.exists(path) }
        try replica.write(path, text: "# \(clean)\n\n")
        await refreshLocal()
        scheduleSync()
        return path
    }

    /// Removes the Note here; the next sync moves the Mac's copy to its `_trash/`.
    func deleteNote(path: String) async throws {
        try replica.remove(path)
        await refreshLocal()
        scheduleSync()
    }

    // MARK: Folders and conflicts

    func setFolder(_ name: String, enabled: Bool) async throws {
        guard let engine else { return }
        try await engine.setFolder(name, enabled: enabled)
        await refreshLocal()
        if enabled { await sync() }
    }

    func resolveKeepingMac(_ id: String) async throws {
        try await engine?.resolveKeepingMac(id)
        await refreshLocal()
        scheduleSync()
    }

    func resolveKeepingPhone(_ id: String) async throws {
        try await engine?.resolveKeepingPhone(id)
        await refreshLocal()
        scheduleSync()
    }

    // MARK: Errors

    static func describe(_ error: Error) -> String {
        switch error {
        case VaultServerError.unauthorized: "The Mac rejected the token."
        case VaultServerError.unreachable(let why): why.isEmpty ? "Can't reach the Mac." : "Can't reach the Mac: \(why)"
        case VaultServerError.missing: "Not found on the Mac."
        case VaultServerError.stale: "That note changed on the Mac."
        case VaultServerError.exists: "A note with that name already exists on the Mac."
        case VaultServerError.server(let status, let message): "Mac error \(status): \(message)"
        case SyncError.unsyncedChanges(let folder, let paths):
            "\(folder) has \(paths.count) change\(paths.count == 1 ? "" : "s") the Mac hasn't received yet. Sync first."
        case let e as LocalizedError: e.errorDescription ?? e.localizedDescription
        default: error.localizedDescription
        }
    }
}
