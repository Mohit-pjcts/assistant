import Foundation
import Testing
@testable import OniCore

private let base: [String: String] = [
    "Master Profile.md": "profile v1",
    "People/Ana — Notes.md": "ana v1",
    "Semester 1/MATH1001 — Lecture 1.md": "math v1",
]

private func synced() async throws -> Fixture {
    let f = await Fixture(notes: base)
    _ = try await f.engine.sync()
    return f
}

// MARK: - The decision table

@Suite struct DecisionTable {
    @Test func firstSyncPullsEveryNote() async throws {
        let f = await Fixture(notes: base)
        defer { f.cleanUp() }
        let report = try await f.engine.sync()
        #expect(Set(report.pulled) == Set(base.keys))
        for (path, text) in base { #expect(f.phoneText(path) == text) }
        #expect(report.failures.isEmpty)
    }

    @Test func aSecondSyncChangesNothing() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        let report = try await f.engine.sync()
        #expect(!report.changedAnything)
        #expect(report.failures.isEmpty)
    }

    @Test func aPhoneEditReachesTheMac() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "profile v2")
        let report = try await f.engine.sync()
        #expect(report.pushed == ["Master Profile.md"])
        #expect(await f.server.text("Master Profile.md") == "profile v2")
        #expect(!(try await f.engine.sync()).changedAnything)
    }

    @Test func aMacEditReachesThePhone() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        await f.server.macWrite("People/Ana — Notes.md", "ana v2")
        let report = try await f.engine.sync()
        #expect(report.pulled == ["People/Ana — Notes.md"])
        #expect(f.phoneText("People/Ana — Notes.md") == "ana v2")
    }

    @Test func aNewPhoneNoteInANewFolderReachesTheMac() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Ideas/Fresh.md", "new")
        let report = try await f.engine.sync()
        #expect(report.pushed == ["Ideas/Fresh.md"])
        #expect(await f.server.text("Ideas/Fresh.md") == "new")
    }

    @Test func aNewMacNoteAppearsOnThePhone() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        await f.server.macWrite("Oni Note.md", "from oni")
        _ = try await f.engine.sync()
        #expect(f.phoneText("Oni Note.md") == "from oni")
    }

    @Test func deletingOnThePhoneMovesTheNoteToTheMacsTrash() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneDelete("People/Ana — Notes.md")
        let report = try await f.engine.sync()
        #expect(report.trashedOnMac == ["People/Ana — Notes.md"])
        #expect(await f.server.text("People/Ana — Notes.md") == nil)
        #expect(await f.server.trash["People/Ana — Notes.md"] == "ana v1")  // recoverable
        #expect(!(try await f.engine.sync()).changedAnything)
    }

    @Test func deletingOnTheMacRemovesItFromThePhone() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        await f.server.macDelete("People/Ana — Notes.md")
        let report = try await f.engine.sync()
        #expect(report.removedLocally == ["People/Ana — Notes.md"])
        #expect(f.phoneText("People/Ana — Notes.md") == nil)
    }

    @Test func anEditOnTheMacBeatsADeleteOnThePhone() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneDelete("People/Ana — Notes.md")
        await f.server.macWrite("People/Ana — Notes.md", "ana edited on the mac")
        let report = try await f.engine.sync()
        #expect(report.trashedOnMac.isEmpty)
        #expect(f.phoneText("People/Ana — Notes.md") == "ana edited on the mac")
        #expect(await f.server.text("People/Ana — Notes.md") == "ana edited on the mac")
    }

    @Test func anEditOnThePhoneBeatsADeleteOnTheMac() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        await f.server.macDelete("People/Ana — Notes.md")
        try f.phoneWrite("People/Ana — Notes.md", "ana edited on the phone")
        let report = try await f.engine.sync()
        #expect(report.removedLocally.isEmpty)
        #expect(report.pushed == ["People/Ana — Notes.md"])
        #expect(await f.server.text("People/Ana — Notes.md") == "ana edited on the phone")
    }

    @Test func aNoteDeletedOnBothSidesJustDisappears() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneDelete("People/Ana — Notes.md")
        await f.server.macDelete("People/Ana — Notes.md")
        let report = try await f.engine.sync()
        #expect(report.failures.isEmpty && !report.changedAnything)
        #expect(await f.engine.currentState().base["People/Ana — Notes.md"] == nil)
    }

    @Test func bothSidesMakingTheSameEditIsNotAConflict() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "same edit")
        await f.server.macWrite("Master Profile.md", "same edit")
        let report = try await f.engine.sync()
        #expect(report.conflicts.isEmpty)
        #expect(await f.engine.unresolvedConflicts().isEmpty)
    }
}

// MARK: - Conflicts: keep both

@Suite struct Conflicts {
    @Test func editingBothSidesKeepsBothVersions() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("Master Profile.md", "mac's edit")

        let report = try await f.engine.sync()

        #expect(report.conflicts == ["Master Profile.md"])
        // The Mac's version is the Note; the phone's is a Conflict copy on the Mac.
        #expect(f.phoneText("Master Profile.md") == "mac's edit")
        #expect(await f.server.text("Master Profile.md") == "mac's edit")
        #expect(await f.server.conflictCopies.values.contains("phone's edit"))
        // …and also kept on the phone itself, and recorded.
        let records = await f.engine.unresolvedConflicts()
        #expect(records.count == 1 && records[0].originalPath == "Master Profile.md")
        #expect(f.replica.conflictCopy(id: records[0].id).flatMap { String(data: $0, encoding: .utf8) } == "phone's edit")
        #expect(!(try await f.engine.sync()).changedAnything)
    }

    @Test func anUnreachableMacNeverLosesThePhonesEdit() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("Master Profile.md", "mac's edit")
        // Manifest succeeds, then the connection drops before the copy uploads.
        await f.server.setDropAfter(2)
        await #expect(throws: VaultServerError.self) { try await f.engine.sync() }
        #expect(f.phoneText("Master Profile.md") == "phone's edit")

        let report = try await f.engine.sync()
        #expect(report.conflicts == ["Master Profile.md"])
        #expect(f.phoneText("Master Profile.md") == "mac's edit")
        #expect(await f.server.conflictCopies.count == 1)
    }

    @Test func replayingTheSameConflictDoesNotMakeASecondCopy() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("Master Profile.md", "mac's edit")
        // Upload succeeds, then the connection drops before the Mac's version is fetched.
        await f.server.setDropAfter(3)
        await #expect(throws: VaultServerError.self) { try await f.engine.sync() }
        _ = try await f.engine.sync()
        #expect(await f.server.conflictCopies.count == 1)
        #expect(await f.engine.unresolvedConflicts().count == 1)
    }

    @Test func twoPeopleCreatingTheSamePathDifferentlyIsAConflict() async throws {
        let f = await Fixture()
        defer { f.cleanUp() }
        try f.phoneWrite("Same Name.md", "phone version")
        await f.server.macWrite("Same Name.md", "mac version")
        let report = try await f.engine.sync()
        #expect(report.conflicts == ["Same Name.md"])
        #expect(f.phoneText("Same Name.md") == "mac version")
        #expect(await f.server.conflictCopies.values.contains("phone version"))
    }

    @Test func keepingTheMacsVersionDiscardsThePhoneCopyEverywhere() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("Master Profile.md", "mac's edit")
        _ = try await f.engine.sync()
        let id = try #require(await f.engine.unresolvedConflicts().first?.id)

        try await f.engine.resolveKeepingMac(id)

        #expect(f.phoneText("Master Profile.md") == "mac's edit")
        #expect(await f.server.conflictCopies.isEmpty)
        #expect(await f.engine.currentState().conflicts.isEmpty)
        #expect(f.replica.conflictCopy(id: id) == nil)
    }

    @Test func keepingThePhonesVersionMakesItTheNoteAndSyncsIt() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("Master Profile.md", "mac's edit")
        _ = try await f.engine.sync()
        let id = try #require(await f.engine.unresolvedConflicts().first?.id)

        try await f.engine.resolveKeepingPhone(id)
        #expect(f.phoneText("Master Profile.md") == "phone's edit")
        let report = try await f.engine.sync()

        #expect(report.pushed == ["Master Profile.md"])
        #expect(await f.server.text("Master Profile.md") == "phone's edit")
        #expect(await f.server.conflictCopies.isEmpty)
    }

    @Test func resolvingOfflineIsFinishedByTheNextSync() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("Master Profile.md", "mac's edit")
        _ = try await f.engine.sync()
        let id = try #require(await f.engine.unresolvedConflicts().first?.id)

        await f.server.setOffline(true)
        try await f.engine.resolveKeepingMac(id)  // user's choice is recorded, Mac cleanup deferred
        #expect(await f.engine.unresolvedConflicts().isEmpty)
        #expect(await f.server.conflictCopies.count == 1)

        await f.server.setOffline(false)
        _ = try await f.engine.sync()
        #expect(await f.server.conflictCopies.isEmpty)
        #expect(await f.engine.currentState().conflicts.isEmpty)
    }

    @Test func resolvingAnUnknownConflictThrows() async throws {
        let f = await Fixture()
        defer { f.cleanUp() }
        await #expect(throws: SyncError.unknownConflict("nope")) {
            try await f.engine.resolveKeepingMac("nope")
        }
    }
}

// MARK: - Safety properties

@Suite struct Safety {
    @Test func anUnreachableMacThrowsAndTouchesNothing() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "offline edit")
        await f.server.setOffline(true)
        await #expect(throws: VaultServerError.unreachable("offline")) { try await f.engine.sync() }
        #expect(f.phoneText("Master Profile.md") == "offline edit")
    }

    @Test func aSyncInterruptedPartwayResumesWithoutRedoingOrLosingWork() async throws {
        let f = await Fixture(notes: base)
        defer { f.cleanUp() }
        await f.server.setDropAfter(3)  // manifest + two notes, then the connection drops
        await #expect(throws: VaultServerError.self) { try await f.engine.sync() }
        let partial = await f.engine.currentState().base.count
        #expect(partial == 1 || partial == 2)  // progress was kept

        // A relaunch (new engine, state read from disk) finishes the job.
        let report = try await f.relaunched().sync()
        #expect(report.failures.isEmpty)
        for (path, text) in base { #expect(f.phoneText(path) == text) }
    }

    @Test func offlineEditsSurviveARelaunchAndSyncLater() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "edited on a plane")
        try f.phoneWrite("Trip.md", "new on a plane")
        try f.phoneDelete("People/Ana — Notes.md")
        // App is killed; nothing was queued in memory — edits are just files.
        let report = try await f.relaunched().sync()
        #expect(Set(report.pushed) == ["Master Profile.md", "Trip.md"])
        #expect(report.trashedOnMac == ["People/Ana — Notes.md"])
    }

    @Test func losingTheSyncStateNeverLosesData() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("Master Profile.md", "phone's edit")
        await f.server.macWrite("People/Ana — Notes.md", "ana edited on the mac")
        try? FileManager.default.removeItem(at: f.dir.appendingPathComponent("sync-state.json"))

        let report = try await f.relaunched().sync()

        // Identical notes are simply adopted; the one that differs in a way
        // that can't be told apart from "edited both" becomes a Conflict copy.
        #expect(await f.server.conflictCopies.values.contains("phone's edit"))
        #expect(report.failures.isEmpty)
        #expect(f.phoneText("People/Ana — Notes.md") != nil)
    }

    @Test func aNoteEditedWhileTheSyncRunsIsNeverOverwritten() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        await f.server.macWrite("People/Ana — Notes.md", "ana edited on the mac")
        let replica = f.replica
        await f.server.setDuringNote { path in
            // The user types into the Note just as the sync is fetching it.
            try? replica.write(path, text: "typed during the sync")
        }
        _ = try await f.engine.sync()
        #expect(f.phoneText("People/Ana — Notes.md") == "typed during the sync")

        // Nothing was lost: the next sync treats it as the conflict it is.
        await f.server.setDuringNote(nil)
        let report = try await f.engine.sync()
        #expect(report.conflicts == ["People/Ana — Notes.md"])
        #expect(await f.server.conflictCopies.values.contains("typed during the sync"))
    }

    @Test func pathsTheServerShouldNeverSendAreIgnored() async throws {
        let f = await Fixture(notes: [
            "Fine.md": "ok", "../escape.md": "bad", ".obsidian/x.md": "bad",
            "_trash/old.md": "bad", "/abs.md": "bad", "a//b.md": "bad",
        ])
        defer { f.cleanUp() }
        _ = try await f.engine.sync()
        #expect(f.phoneText("Fine.md") == "ok")
        #expect(try f.replica.localHashes().keys.sorted() == ["Fine.md"])
        #expect(!FileManager.default.fileExists(atPath: f.dir.deletingLastPathComponent().appendingPathComponent("escape.md").path))
    }

    @Test func aNoteThatIsNotTextIsReportedNotSilentlyDropped() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.replica.write("Binary.md", data: Data([0xff, 0xfe, 0x00, 0x80]))
        let report = try await f.engine.sync()
        #expect(report.failures.map(\.path) == ["Binary.md"])
        #expect(f.replica.read("Binary.md") != nil)
    }

    @Test func aSyncCalledWhileAnotherIsRunningJoinsIt() async throws {
        let f = await Fixture(notes: base)
        defer { f.cleanUp() }
        async let a = f.engine.sync()
        async let b = f.engine.sync()
        let (ra, rb) = try await (a, b)
        #expect(ra.pulled.count + rb.pulled.count >= base.count)
        #expect(await f.server.callLog.filter { $0 == "manifest" }.count <= 2)
    }
}

// MARK: - Folder switches

@Suite struct FolderSwitches {
    @Test func switchingAFolderOffRemovesItFromThePhoneAndStopsSyncingIt() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try await f.engine.setFolder("People", enabled: false)

        #expect(f.phoneText("People/Ana — Notes.md") == nil)
        #expect(await f.server.text("People/Ana — Notes.md") == "ana v1")  // the Mac is untouched
        // A new note appearing in that folder on the Mac is not fetched.
        await f.server.macWrite("People/Ben.md", "ben")
        _ = try await f.engine.sync()
        #expect(f.phoneText("People/Ben.md") == nil)
        #expect(f.phoneText("Master Profile.md") == "profile v1")  // other folders keep syncing
        let folders = await f.engine.folders()
        #expect(folders.contains { $0.name == "People" && !$0.enabled })
    }

    @Test func switchingItBackOnPullsTheFolderAgain() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try await f.engine.setFolder("People", enabled: false)
        try await f.engine.setFolder("People", enabled: true)
        _ = try await f.engine.sync()
        #expect(f.phoneText("People/Ana — Notes.md") == "ana v1")
    }

    @Test func switchingOffRefusesWhileThereAreUnsyncedEdits() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneWrite("People/Ana — Notes.md", "unsynced edit")
        await #expect(throws: SyncError.unsyncedChanges(folder: "People", paths: ["People/Ana — Notes.md"])) {
            try await f.engine.setFolder("People", enabled: false)
        }
        #expect(f.phoneText("People/Ana — Notes.md") == "unsynced edit")
    }

    @Test func switchingOffRefusesWhileThereAreUnsyncedDeletes() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        try f.phoneDelete("People/Ana — Notes.md")
        await #expect(throws: SyncError.self) {
            try await f.engine.setFolder("People", enabled: false)
        }
    }

    @Test func rootNotesHaveNoSwitchAndAlwaysSync() async throws {
        let f = try await synced()
        defer { f.cleanUp() }
        #expect(NotePath.topLevelFolder(of: "Master Profile.md") == nil)
        #expect(await f.engine.folders().map(\.name) == ["People", "Semester 1"])
    }
}
