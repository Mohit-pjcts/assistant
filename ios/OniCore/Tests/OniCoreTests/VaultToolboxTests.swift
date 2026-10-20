import Foundation
import Testing
@testable import OniCore

@Suite struct VaultToolboxTests {
    private func run(_ box: VaultToolbox, _ name: String, _ args: JSONValue) async -> ToolOutput {
        await box.execute(name: name, input: args)
    }

    @Test func writeCreatesAnOniNoteAtTheRootWithFrontmatterAndRelatedLinks() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Semester 1/Linear Algebra Notes.md", text: "x")
        try r.write("Pasta Recipes.md", text: "x")  // shares no 4+ letter word with the new title
        let out = await run(toolbox(r), "write_vault_note", ["title": "Linear Algebra Study Plan", "content": "Do problem sets.\n\n"])
        #expect(out.text == "Created 'Linear Algebra Study Plan', linked to 1 related note(s): Linear Algebra Notes.")
        #expect(out.wroteVault && !out.isError)
        let saved = try #require(r.text("Linear Algebra Study Plan.md"))
        #expect(saved == "---\noni: true\ncreated: 2026-10-20\n---\n\nDo problem sets.\n\n## Related Notes\n\n- [[Linear Algebra Notes]]\n")
        #expect(Frontmatter.isOniAuthored(saved))
    }

    @Test func writeWithNothingRelatedSaysSo() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let out = await run(toolbox(r), "write_vault_note", ["title": "Zebra", "content": "stripes"])
        #expect(out.text == "Created 'Zebra' (no related notes found to link).")
        #expect(r.text("Zebra.md") == "---\noni: true\ncreated: 2026-10-20\n---\n\nstripes\n")
    }

    @Test func writeRefusesATitleThatExistsAnywhereInTheTree() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Semester 2/CCHU9053 — Overview.md", text: "the user's own")
        let out = await run(toolbox(r), "write_vault_note", ["title": "CCHU9053 — Overview", "content": "mine"])
        #expect(out.isError && !out.wroteVault)
        #expect(out.text.contains("already exists"))
        #expect(r.text("Semester 2/CCHU9053 — Overview.md") == "the user's own")
    }

    @Test func aSlashInATitleBecomesADash() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let out = await run(toolbox(r), "write_vault_note", ["title": "Plan A/B", "content": "x"])
        #expect(!out.isError)
        #expect(r.text("Plan A-B.md") != nil)
    }

    @Test func badTitlesAreRejectedWithoutWriting() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        for title in ["", "   ", ".hidden"] {
            let out = await run(toolbox(r), "write_vault_note", ["title": .string(title), "content": "x"])
            #expect(out.isError, "title \(title.debugDescription)")
        }
        #expect(r.listNotes().isEmpty)
    }

    @Test func updateReplacesTheBodyOfAnOniNoteAndKeepsItsCreatedDate() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Mine.md", text: "---\noni: true\ncreated: 2026-01-02\n---\n\nold\n")
        let out = await run(toolbox(r), "update_vault_note", ["title": "Mine", "content": "new body\n\n\n"])
        #expect(!out.isError && out.wroteVault && out.text.hasPrefix("Updated 'Mine'"))
        #expect(r.text("Mine.md") == "---\noni: true\ncreated: 2026-01-02\nupdated: 2026-10-20\n---\n\nnew body\n")
    }

    @Test func updateAndDeleteRefuseTheUsersOwnNotes() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let original = "# Master Profile\nprivate\n"
        try r.write("Master Profile.md", text: original)
        try r.write("Faked.md", text: "---\nnot_oni: true\n---\nx")  // a lookalike marker must not count
        for (name, title) in [("update_vault_note", "Master Profile"), ("delete_vault_note", "Master Profile"),
                              ("update_vault_note", "Faked"), ("delete_vault_note", "Faked")] {
            let out = await run(toolbox(r), name, ["title": .string(title), "content": "overwritten"])
            #expect(out.isError && !out.wroteVault && out.text.contains("was not created by Oni"), "\(name) \(title)")
        }
        #expect(r.text("Master Profile.md") == original)
        #expect(r.text("Faked.md") != nil)
    }

    @Test func deleteRemovesAnOniNoteFromTheReplica() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Gone.md", text: "---\noni: true\n---\nx")
        let out = await run(toolbox(r), "delete_vault_note", ["title": "Gone"])
        #expect(out.text.hasPrefix("Deleted 'Gone'") && out.wroteVault)
        #expect(r.text("Gone.md") == nil)
    }

    @Test func missingNotesAreErrors() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        for name in ["read_vault_note", "update_vault_note", "delete_vault_note"] {
            let out = await run(toolbox(r), name, ["title": "Nope", "content": "x"])
            #expect(out.isError && out.text.contains("no note titled 'Nope'"), "\(name)")
        }
    }

    @Test func readReturnsTheWholeNoteAndEnforcesTheSizeCap() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Small.md", text: "---\noni: true\n---\nhello")
        try r.write("Big.md", text: String(repeating: "x", count: VaultToolbox.maxReadBytes + 1))
        #expect(await run(toolbox(r), "read_vault_note", ["title": "Small"]).text == "---\noni: true\n---\nhello")
        let big = await run(toolbox(r), "read_vault_note", ["title": "Big"])
        #expect(big.isError && big.text.contains("too large to read"))
    }

    @Test func searchFindsTitleAndContentWithSnippets() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Recursion Basics.md", text: "---\noni: true\n---\n\nBase case and recursive case.")
        try r.write("Other.md", text: "Talks about recursion in passing.")
        try r.write("Unrelated.md", text: "pasta")
        let out = await run(toolbox(r, semantic: { _ in [] }), "search_vault", ["query": "Recursion"])
        #expect(out.text.contains("[[Recursion Basics]]"))
        #expect(out.text.contains("[[Other]] — …Talks about recursion in passing.…"))
        #expect(!out.text.contains("Unrelated") && !out.text.contains("Semantic search unavailable"))
    }

    @Test func searchAddsSemanticHitsAndSaysWhenTheMacIsUnreachable() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Pasta.md", text: "carbonara")
        let online = await run(toolbox(r, semantic: { _ in
            [SearchHit(title: "Pasta", path: "Pasta.md", score: 0.5), SearchHit(title: "Dinner Ideas", path: "Dinner Ideas.md", score: 0.4321)]
        }), "search_vault", ["query": "carbonara"])
        #expect(online.text.contains("[[Dinner Ideas]] (semantic match, no exact text overlap, score=0.43)"))
        #expect(!online.text.contains("[[Pasta]] (semantic"))  // already an exact hit

        struct Down: Error {}
        let offline = await run(toolbox(r, semantic: { _ in throw Down() }), "search_vault", ["query": "zzz"])
        #expect(offline.text.hasPrefix("No notes found matching 'zzz'."))
        #expect(offline.text.contains("keyword matches only"))
        #expect(!offline.isError)
    }

    @Test func searchTruncatesAtTwentyAndSaysHowManyMore() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        for i in 0..<25 { try r.write("Note \(i).md", text: "needle") }
        let out = await run(toolbox(r, semantic: { _ in [] }), "search_vault", ["query": "needle"])
        #expect(out.text.contains("... and 5 more (truncated)"))
        #expect(out.text.components(separatedBy: "[[Note").count - 1 == 20)
    }

    @Test func badArgumentsAndUnknownToolsAreErrorsNotCrashes() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        #expect(await run(toolbox(r), "search_vault", [:]).text.contains("missing required argument 'query'"))
        #expect(await run(toolbox(r), "write_vault_note", ["title": "A"]).text.contains("'content'"))
        #expect(await run(toolbox(r), "search_vault", ["query": 5]).isError)
        #expect(await run(toolbox(r), "not_a_tool", [:]).text.contains("unknown tool"))
    }

    @Test func relatedNotesMirrorTheMacsRules() {
        let existing = ["Spanish Verbs", "Spanish Grammar Overview", "The Verbs", "Ana"]
        // 4+ letter words only, stopwords ignored, best overlap first then alphabetical, never itself.
        #expect(VaultToolbox.relatedNotes(for: "Spanish verbs plan", among: existing) == ["Spanish Verbs", "Spanish Grammar Overview", "The Verbs"])
        #expect(VaultToolbox.relatedNotes(for: "Ana", among: existing).isEmpty)
        #expect(VaultToolbox.relatedNotes(for: "Notes overview", among: ["Notes about this"]).isEmpty)
        #expect(VaultToolbox.relatedNotes(for: "Many topics here", among: (0..<9).map { "Topics \($0)" }).count == VaultToolbox.maxRelated)
    }

    @Test func theToolDefinitionsMatchTheFiveMacTools() throws {
        let names = VaultToolbox.definitions.compactMap { $0["name"]?.string }
        #expect(names == ["search_vault", "read_vault_note", "write_vault_note", "update_vault_note", "delete_vault_note"])
        for d in VaultToolbox.definitions {
            #expect(d["input_schema"]?["additionalProperties"]?.bool == false)
            #expect((d["input_schema"]?["required"]?.array?.count ?? 0) >= 1)
        }
    }
}
