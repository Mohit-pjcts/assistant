import Foundation
import Testing
@testable import OniCore

/// The same engine against the REAL Python backend (assistant/vault_sync.py)
/// serving a temp COPY of the real Vault. Skipped unless the harness set the
/// environment: run `./Scripts/integration.sh`.
private let env = ProcessInfo.processInfo.environment
private let enabled = env["ONI_TEST_BASE_URL"] != nil

@Suite(.serialized, .enabled(if: enabled)) struct RealBackend {
    private let macVault = URL(fileURLWithPath: env["ONI_TEST_VAULT_DIR"] ?? "/nonexistent")

    private func server(token: String? = nil) -> HTTPVaultServer {
        HTTPVaultServer(baseURL: URL(string: env["ONI_TEST_BASE_URL"]!)!, token: token ?? env["ONI_TEST_TOKEN"]!)
    }

    private func phone() -> (Replica, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("oni-integration-\(UUID().uuidString)", isDirectory: true)
        return (Replica(directory: dir), dir)
    }

    private func macRead(_ path: String) -> String? {
        try? String(contentsOf: macVault.appendingPathComponent(path), encoding: .utf8)
    }

    private func macWrite(_ path: String, _ text: String) throws {
        let url = macVault.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }

    private func macExists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: macVault.appendingPathComponent(path).path)
    }

    @Test func aWrongTokenIsRejected() async throws {
        await #expect(throws: VaultServerError.unauthorized) {
            _ = try await server(token: "wrong").ping()
        }
    }

    @Test func theWholeRealVaultSyncsDownIntact() async throws {
        let (replica, dir) = phone()
        defer { try? FileManager.default.removeItem(at: dir) }
        let engine = SyncEngine(server: server(), replica: replica)
        let report = try await engine.sync()
        let manifest = try await server().manifest()

        #expect(report.failures.isEmpty)
        #expect(report.pulled.count == manifest.count)
        #expect(manifest.count > 100)
        let local = try replica.localHashes()
        for entry in manifest { #expect(local[entry.path] == entry.sha256, "\(entry.path)") }
        #expect(manifest.contains { !$0.path.allSatisfy(\.isASCII) })  // real em-dash / accented names
        #expect(!(try await engine.sync()).changedAnything)
    }

    @Test func theFullLifecycleAgainstTheRealBackend() async throws {
        let (replica, dir) = phone()
        defer { try? FileManager.default.removeItem(at: dir) }
        let engine = SyncEngine(server: server(), replica: replica)
        _ = try await engine.sync()
        let path = "People/Integration — Lifecycle.md"

        // Create on the phone → on the Mac, byte for byte.
        let text = "---\noni: true\n---\n\n# Ünïcode — ✓\n\n- [[Master Profile]]\n"
        try replica.write(path, text: text)
        var report = try await engine.sync()
        #expect(report.pushed == [path])
        #expect(macRead(path) == text)

        // Edit on the Mac → on the phone.
        try macWrite(path, text + "mac line\n")
        report = try await engine.sync()
        #expect(report.pulled == [path])
        #expect(replica.text(path) == text + "mac line\n")

        // Edit on both → keep both.
        try replica.write(path, text: "phone edit\n")
        try macWrite(path, "mac edit\n")
        report = try await engine.sync()
        #expect(report.conflicts == [path])
        #expect(replica.text(path) == "mac edit\n")
        let record = try #require(await engine.unresolvedConflicts().first)
        #expect(macRead(record.serverPath) == "phone edit\n")
        #expect(record.serverPath.hasPrefix("_conflicts/People/Integration — Lifecycle (phone "))

        // Resolve keeping the phone's → it becomes the Note; the copy is gone.
        try await engine.resolveKeepingPhone(record.id)
        #expect(!macExists(record.serverPath))
        report = try await engine.sync()
        #expect(report.pushed == [path])
        #expect(macRead(path) == "phone edit\n")

        // Delete on the phone → soft-deleted on the Mac, and restorable.
        try replica.remove(path)
        report = try await engine.sync()
        #expect(report.trashedOnMac == [path])
        #expect(!macExists(path))
        #expect(macRead("_trash/" + path) == "phone edit\n")
        let trash = try await server().listTrash()
        #expect(trash.contains { $0.originalPath == path })
        #expect(try await server().restoreFromTrash(path: "_trash/" + path) == path)
        #expect(macRead(path) == "phone edit\n")

        // …and the restored Note comes back to the phone.
        report = try await engine.sync()
        #expect(report.pulled == [path])
    }

    @Test func anEditOnTheMacBeatsAPhoneDeleteOnTheRealBackend() async throws {
        let (replica, dir) = phone()
        defer { try? FileManager.default.removeItem(at: dir) }
        let engine = SyncEngine(server: server(), replica: replica)
        let path = "Integration — Edit beats delete.md"
        try replica.write(path, text: "v1")
        _ = try await engine.sync()
        try replica.remove(path)
        try macWrite(path, "v2 from the mac")
        let report = try await engine.sync()
        #expect(report.trashedOnMac.isEmpty)
        #expect(replica.text(path) == "v2 from the mac")
        #expect(macExists(path))
    }

    @Test func searchAndPingWork() async throws {
        let ping = try await server().ping()
        #expect(ping.ok && ping.notes > 100)
    }
}
