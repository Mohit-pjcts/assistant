import Foundation
import Testing
@testable import OniCore

@Suite struct NotePathRules {
    // Mirrors tests/test_vault_sync.py's list of rejected paths.
    @Test(arguments: [
        "../outside.md", "People/../../outside.md", "/etc/passwd.md", "a//b.md", "./a.md",
        "a/./b.md", "dir/", "back\\slash.md", "nul\u{0}.md", "", ".obsidian/app.md",
        "People/.hidden.md", "notes.txt", ".obsidian/app.json", "Folder",
        "_conflicts/x.md", "_trash/x.md", "_trash/Sub/x.md",
    ])
    func rejectsUnsafeOrUnsupportedPaths(path: String) {
        #expect(!NotePath.isValid(path))
    }

    @Test(arguments: [
        "Note.md", "People/Ana — Notes.md", "Semester 1 (2025-26)/MATH — Lecture 1.md",
        "A/B/C/d.md", "Café — Résumé.md", "not_conflicts/x.md",
    ])
    func acceptsOrdinaryNotePaths(path: String) {
        #expect(NotePath.isValid(path))
    }

    @Test func titleAndFolder() {
        #expect(NotePath.title(of: "People/Ana — Notes.md") == "Ana — Notes")
        #expect(NotePath.topLevelFolder(of: "People/Ana.md") == "People")
        #expect(NotePath.topLevelFolder(of: "Root.md") == nil)
    }
}

@Suite struct ReplicaFiles {
    private func make() -> (Replica, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("oni-replica-\(UUID().uuidString)", isDirectory: true)
        return (Replica(directory: dir), dir)
    }

    @Test func writesReadsAndHashesExactBytes() throws {
        let (r, dir) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        let text = "---\noni: true\n---\n\n# Ünïcode — ✓\r\n\ttabbed\n"
        try r.write("People/Ana.md", text: text)
        #expect(r.text("People/Ana.md") == text)
        #expect(r.hash(of: "People/Ana.md") == sha256Hex(Data(text.utf8)))
        #expect(try r.localHashes() == ["People/Ana.md": sha256Hex(text)])
    }

    @Test func refusesToWriteAnInvalidPath() {
        let (r, dir) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(throws: ReplicaError.invalidPath("../x.md")) { try r.write("../x.md", text: "x") }
        #expect(throws: ReplicaError.invalidPath("_trash/x.md")) { try r.write("_trash/x.md", text: "x") }
    }

    @Test func listingIgnoresHiddenAndNonMarkdownFiles() throws {
        let (r, dir) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Keep.md", text: "x")
        try Data("x".utf8).write(to: r.notesRoot.appendingPathComponent("image.png"))
        try Data("x".utf8).write(to: r.notesRoot.appendingPathComponent(".hidden.md"))
        #expect(try r.localHashes().keys.sorted() == ["Keep.md"])
    }

    @Test func removingTheLastNoteInAFolderRemovesTheFolderButNotTheRoot() throws {
        let (r, dir) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Deep/Er/Note.md", text: "x")
        try r.remove("Deep/Er/Note.md")
        #expect(!FileManager.default.fileExists(atPath: r.notesRoot.appendingPathComponent("Deep").path))
        #expect(FileManager.default.fileExists(atPath: r.notesRoot.path))
    }

    @Test func aCorruptStateFileIsSetAsideNotTrusted() throws {
        let (r, dir) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        let stateFile = dir.appendingPathComponent("sync-state.json")
        try Data("{ not json".utf8).write(to: stateFile)
        #expect(r.loadState() == SyncState())
        #expect(FileManager.default.fileExists(atPath: stateFile.appendingPathExtension("corrupt").path))
    }

    @Test func stateRoundTripsThroughDisk() throws {
        let (r, dir) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        var state = SyncState()
        state.base["A.md"] = "abc"
        state.disabledFolders = ["People"]
        state.conflicts = [ConflictRecord(originalPath: "A.md", serverPath: "_conflicts/A (phone 1).md", phoneSha256: "def")]
        try r.saveState(state)
        let loaded = r.loadState()
        #expect(loaded.base == state.base && loaded.disabledFolders == state.disabledFolders)
        #expect(loaded.conflicts.first?.originalPath == "A.md")
    }
}

@Suite struct HTTPErrorMapping {
    private func map(_ status: Int, _ json: String) -> VaultServerError {
        HTTPVaultServer.mapError(status: status, data: Data(json.utf8))
    }

    @Test func mapsTheServersErrorShapes() {
        #expect(map(401, #"{"detail":"Missing or invalid Vault token."}"#) == .unauthorized)
        #expect(map(404, #"{"detail":"No such note."}"#) == .missing)
        #expect(map(409, #"{"detail":{"code":"stale","current_sha256":"abc"}}"#) == .stale(currentSha256: "abc"))
        #expect(map(409, #"{"detail":{"code":"exists","current_sha256":"abc"}}"#) == .exists(currentSha256: "abc"))
        #expect(map(413, #"{"detail":"Note is too large."}"#) == .server(status: 413, message: "Note is too large."))
        #expect(map(500, "not json") == .server(status: 500, message: "HTTP 500"))
    }
}

@Suite struct QueryEncoding {
    @Test func encodesEveryCharacterTheServerWouldMisreadInAQuery() {
        // "+" must not survive as "+" (the server decodes it as a space).
        #expect(HTTPVaultServer.encodeQuery(["path": "C++ Basics.md"]) == "path=C%2B%2B%20Basics.md")
        #expect(HTTPVaultServer.encodeQuery(["q": "a&b=c#d?e/f"]) == "q=a%26b%3Dc%23d%3Fe%2Ff")
        #expect(HTTPVaultServer.encodeQuery(["path": "People/Ana — Café.md"])
            == "path=People%2FAna%20%E2%80%94%20Caf%C3%A9.md")
        #expect(HTTPVaultServer.encodeQuery(["b": "2", "a": "1"]) == "a=1&b=2")  // stable order
    }
}

@Suite struct ReplicaWipe {
    @Test func wipeLeavesAnEmptyUsableReplica() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oni-wipe-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let r = Replica(directory: dir)
        try r.write("People/Ana.md", text: "x")
        try r.saveConflictCopy(id: "c1", data: Data("phone".utf8))
        var state = SyncState()
        state.base["People/Ana.md"] = "abc"
        try r.saveState(state)

        r.wipe()

        #expect(try r.localHashes().isEmpty)
        #expect(r.conflictCopy(id: "c1") == nil)
        #expect(r.loadState() == SyncState())
        try r.write("Fresh.md", text: "still works")  // directories were recreated
        #expect(r.text("Fresh.md") == "still works")
    }
}
