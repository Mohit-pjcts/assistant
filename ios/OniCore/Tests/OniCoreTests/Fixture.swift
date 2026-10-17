import Foundation
@testable import OniCore

/// One phone (a Replica in a temp directory) talking to one Mac (the model).
struct Fixture {
    let dir: URL
    let server: InMemoryVaultServer
    let replica: Replica
    let engine: SyncEngine

    init(notes: [String: String] = [:]) async {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("oni-core-tests-\(UUID().uuidString)", isDirectory: true)
        server = InMemoryVaultServer()
        for (path, text) in notes { await server.macWrite(path, text) }
        replica = Replica(directory: dir)
        engine = SyncEngine(server: server, replica: replica)
    }

    /// A fresh engine over the same files — the app being relaunched.
    func relaunched() -> SyncEngine { SyncEngine(server: server, replica: replica) }

    func phoneText(_ path: String) -> String? { replica.text(path) }
    func phoneWrite(_ path: String, _ text: String) throws { try replica.write(path, text: text) }
    func phoneDelete(_ path: String) throws { try replica.remove(path) }
    func cleanUp() { try? FileManager.default.removeItem(at: dir) }
}
