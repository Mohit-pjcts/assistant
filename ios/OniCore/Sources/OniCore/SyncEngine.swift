import Foundation

public struct PathFailure: Sendable, Equatable {
    public var path: String
    public var message: String
}

public struct SyncReport: Sendable, Equatable {
    /// Notes fetched from the Mac (new or changed there).
    public var pulled: [String] = []
    /// Notes the phone created or edited that the Mac now has.
    public var pushed: [String] = []
    /// Notes removed from the phone because they were deleted on the Mac.
    public var removedLocally: [String] = []
    /// Notes deleted on the phone, now in the Mac's `_trash/`.
    public var trashedOnMac: [String] = []
    /// Notes edited on both sides: the phone's version went to `_conflicts/`.
    public var conflicts: [String] = []
    public var failures: [PathFailure] = []

    public var changedAnything: Bool {
        !(pulled.isEmpty && pushed.isEmpty && removedLocally.isEmpty
            && trashedOnMac.isEmpty && conflicts.isEmpty)
    }
}

public enum SyncError: Error, Equatable {
    case notText(String)
    case hashMismatch(String)
    case unsyncedChanges(folder: String, paths: [String])
    case unknownConflict(String)
}

/// Keeps the Replica and the Mac's Vault in step (PLAN.md Phase 30).
///
/// **Three-way and state-based, not an operation log.** For each Note the
/// engine compares three hashes: the phone's file now (L), the version the two
/// sides last agreed on (B, `SyncState.base`), and the Mac's now (R). Edits
/// are *detected* by L ≠ B rather than recorded, so there is no queue to
/// corrupt, an offline session needs no special handling, a sync interrupted
/// halfway simply resumes, and re-running one that already finished changes
/// nothing. The decisions below are the user's (STEPS.md 164):
///
/// - Only one side changed → copy it across.
/// - **Both changed** → the phone's version is uploaded to `_conflicts/` and
///   the Mac's becomes the Note. Nothing is overwritten without a copy first.
/// - Deleted on the phone → moved to the Mac's `_trash/`, never erased.
/// - **An edit beats a delete**, in both directions.
///
/// Losing `SyncState` is safe: every Note then looks new on both sides and a
/// difference is a Conflict copy, not an overwrite.
public actor SyncEngine {
    private let server: any VaultServer
    private let replica: Replica
    private var state: SyncState
    private var inFlight: Task<SyncReport, Error>?
    private var operationsSinceSave = 0

    public init(server: any VaultServer, replica: Replica) {
        self.server = server
        self.replica = replica
        self.state = replica.loadState()
    }

    public func currentState() -> SyncState { state }

    /// Conflicts the user has not yet resolved, oldest first.
    public func unresolvedConflicts() -> [ConflictRecord] {
        state.conflicts.filter { !$0.resolved }.sorted { $0.createdAt < $1.createdAt }
    }

    public func folders() -> [(name: String, enabled: Bool)] {
        state.knownFolders.sorted().map { ($0, !state.disabledFolders.contains($0)) }
    }

    // MARK: Sync

    /// Runs one sync. A call made while one is running joins it.
    public func sync() async throws -> SyncReport {
        if let running = inFlight { return try await running.value }
        let task = Task { try await self.runSync() }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }

    private func settle() async {
        _ = try? await inFlight?.value
    }

    private func isEnabled(_ path: String) -> Bool {
        guard let folder = NotePath.topLevelFolder(of: path) else { return true }
        return !state.disabledFolders.contains(folder)
    }

    private func save() throws {
        operationsSinceSave = 0
        try replica.saveState(state)
    }

    private func noteOperation() throws {
        operationsSinceSave += 1
        if operationsSinceSave >= 40 { try save() }
    }

    private func runSync() async throws -> SyncReport {
        var report = SyncReport()
        let manifest = try await server.manifest()
        var remote: [String: String] = [:]
        for entry in manifest where NotePath.isValid(entry.path) { remote[entry.path] = entry.sha256 }
        let local = try replica.localHashes()

        state.knownFolders.formUnion(remote.keys.compactMap(NotePath.topLevelFolder(of:)))
        state.knownFolders.formUnion(local.keys.compactMap(NotePath.topLevelFolder(of:)))

        let paths = Set(local.keys).union(state.base.keys).union(remote.keys)
            .filter(isEnabled).sorted()
        do {
            try await finishResolvedConflicts()
            for path in paths {
                do {
                    try await reconcile(path, local: local[path], remote: remote[path], report: &report)
                    try noteOperation()
                } catch let error as VaultServerError {
                    switch error {
                    case .unauthorized, .unreachable: throw error
                    default: report.failures.append(.init(path: path, message: "\(error)"))
                    }
                } catch {
                    report.failures.append(.init(path: path, message: "\(error)"))
                }
            }
        } catch {
            try? save()  // keep the progress made before the connection dropped
            throw error
        }
        state.lastSyncedAt = Date()
        try save()
        return report
    }

    /// The decision table. `l`/`b`/`r` are the phone's hash now, the last
    /// agreed hash, and the Mac's hash now (nil = no such Note there).
    private func reconcile(
        _ path: String, local l: String?, remote r: String?, report: inout SyncReport
    ) async throws {
        let b = state.base[path]
        switch (l, b, r) {
        case (nil, nil, nil):
            return
        case (nil, .some, nil):
            state.base[path] = nil  // gone on both sides
        case (nil, nil, .some):
            try await pull(path, expectedLocal: nil, report: &report)  // new on the Mac
        case let (nil, .some(base), .some(remoteHash)):
            if remoteHash == base {
                // Deleted on the phone, untouched on the Mac: soft-delete there.
                do {
                    try await server.delete(path: path, baseSha256: base)
                    state.base[path] = nil
                    report.trashedOnMac.append(path)
                } catch VaultServerError.missing {
                    state.base[path] = nil
                } catch VaultServerError.stale {
                    try await pull(path, expectedLocal: nil, report: &report)  // edit beats delete
                }
            } else {
                try await pull(path, expectedLocal: nil, report: &report)  // edit beats delete
            }
        case let (.some(localHash), nil, nil):
            try await push(path, localHash: localHash, base: nil, report: &report)  // new on the phone
        case let (.some(localHash), nil, .some(remoteHash)):
            if localHash == remoteHash {
                state.base[path] = remoteHash  // both made the identical Note
            } else {
                try await conflict(path, localHash: localHash, report: &report)
            }
        case let (.some(localHash), .some(base), nil):
            if localHash == base {
                // Deleted on the Mac, untouched here: follow the delete.
                guard replica.hash(of: path) == localHash else { return }
                try replica.remove(path)
                state.base[path] = nil
                report.removedLocally.append(path)
            } else {
                // Edited here, deleted on the Mac: the edit wins and recreates it.
                try await push(path, localHash: localHash, base: base, report: &report)
            }
        case let (.some(localHash), .some(base), .some(remoteHash)):
            switch (localHash == base, remoteHash == base) {
            case (true, true): return
            case (true, false): try await pull(path, expectedLocal: localHash, report: &report)
            case (false, true): try await push(path, localHash: localHash, base: base, report: &report)
            case (false, false):
                if localHash == remoteHash {
                    state.base[path] = remoteHash
                } else {
                    try await conflict(path, localHash: localHash, report: &report)
                }
            }
        }
    }

    private func pull(_ path: String, expectedLocal: String?, report: inout SyncReport) async throws {
        let note = try await server.note(path: path)
        guard sha256Hex(note.content) == note.sha256 else { throw SyncError.hashMismatch(path) }
        // If the user edited this Note while the sync was running, leave it:
        // the next sync sees the edit and handles it properly.
        guard replica.hash(of: path) == expectedLocal else { return }
        try replica.write(path, text: note.content)
        state.base[path] = note.sha256
        report.pulled.append(path)
    }

    private func push(
        _ path: String, localHash: String, base: String?, report: inout SyncReport
    ) async throws {
        guard let data = replica.read(path), sha256Hex(data) == localHash,
              let text = String(data: data, encoding: .utf8)
        else {
            // Edited again mid-sync, or not UTF-8 text; try again next time.
            if let data = replica.read(path), String(data: data, encoding: .utf8) == nil {
                throw SyncError.notText(path)
            }
            return
        }
        do {
            let result = try await server.put(path: path, content: text, baseSha256: base)
            state.base[path] = result.sha256
            report.pushed.append(path)
        } catch VaultServerError.stale {
            try await conflict(path, localHash: localHash, report: &report)
        } catch VaultServerError.exists {
            try await conflict(path, localHash: localHash, report: &report)
        }
    }

    /// Both sides changed (or both created) a Note differently: keep both.
    private func conflict(_ path: String, localHash: String, report: inout SyncReport) async throws {
        guard let data = replica.read(path), sha256Hex(data) == localHash,
              let text = String(data: data, encoding: .utf8)
        else { return }
        // Upload FIRST. If the Mac is unreachable this throws and the phone's
        // edit is exactly where it was; the next sync starts again.
        let stored = try await server.uploadConflict(path: path, content: text)
        if !state.conflicts.contains(where: {
            $0.originalPath == path && $0.phoneSha256 == localHash && !$0.resolved
        }) {
            let record = ConflictRecord(
                originalPath: path, serverPath: stored.path, phoneSha256: localHash)
            try replica.saveConflictCopy(id: record.id, data: data)
            state.conflicts.append(record)
        }
        report.conflicts.append(path)
        do {
            try await pull(path, expectedLocal: localHash, report: &report)
        } catch VaultServerError.missing {
            // The Mac deleted it meanwhile: the phone's version stands and
            // will be recreated by the next sync.
            state.base[path] = nil
        }
    }

    // MARK: Folder switches

    /// Turns a top-level folder on or off. Switching OFF removes its Notes
    /// from the phone, so it refuses while any of them has a change the Mac
    /// has not received — sync first.
    public func setFolder(_ name: String, enabled: Bool) async throws {
        await settle()
        if enabled {
            state.disabledFolders.remove(name)
            try save()
            return
        }
        let local = try replica.localHashes()
        var unsynced = local.filter {
            NotePath.topLevelFolder(of: $0.key) == name && state.base[$0.key] != $0.value
        }.map(\.key)
        unsynced += state.base.keys.filter {
            NotePath.topLevelFolder(of: $0) == name && local[$0] == nil
        }
        guard unsynced.isEmpty else {
            throw SyncError.unsyncedChanges(folder: name, paths: unsynced.sorted())
        }
        try replica.removeFolder(name)
        state.base = state.base.filter { NotePath.topLevelFolder(of: $0.key) != name }
        state.knownFolders.insert(name)
        state.disabledFolders.insert(name)
        try save()
    }

    // MARK: Resolving conflicts

    /// The user keeps the Mac's version: the phone's copy is discarded.
    public func resolveKeepingMac(_ id: String) async throws {
        await settle()
        guard let index = state.conflicts.firstIndex(where: { $0.id == id }) else {
            throw SyncError.unknownConflict(id)
        }
        state.conflicts[index].resolved = true
        replica.removeConflictCopy(id: id)
        try save()
        try await finishResolvedConflicts()
    }

    /// The user keeps the phone's version: it becomes the Note (and reaches
    /// the Mac at the next sync, as an ordinary edit).
    public func resolveKeepingPhone(_ id: String) async throws {
        await settle()
        guard let index = state.conflicts.firstIndex(where: { $0.id == id }) else {
            throw SyncError.unknownConflict(id)
        }
        let record = state.conflicts[index]
        let data: Data
        if let kept = replica.conflictCopy(id: id) {
            data = kept
        } else {
            data = Data(try await server.note(path: record.serverPath).content.utf8)
        }
        try replica.write(record.originalPath, data: data)
        state.conflicts[index].resolved = true
        replica.removeConflictCopy(id: id)
        try save()
        try await finishResolvedConflicts()
    }

    /// Removes the Mac-side copy of every resolved conflict. A copy that is
    /// already gone counts as removed; an unreachable Mac leaves the record
    /// for the next sync.
    private func finishResolvedConflicts() async throws {
        for record in state.conflicts where record.resolved {
            do {
                try await server.resolveConflict(path: record.serverPath)
            } catch VaultServerError.missing {
            } catch VaultServerError.unreachable {
                continue
            }
            state.conflicts.removeAll { $0.id == record.id }
        }
        try save()
    }
}
