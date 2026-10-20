import Foundation
import Testing
@testable import OniCore

private func plain(_ s: AttributedString) -> String { String(s.characters) }

@Suite struct FrontmatterTests {
    // These mirror tests/test_obsidian_tools.py: the phone must agree with the Mac
    // on what "written by Oni" means.
    @Test func readsScalarFieldsAndOniAuthorship() {
        let note = "---\noni: true\ncreated: 2026-10-18\n---\n\nBody"
        #expect(Frontmatter.field("created", in: note) == "2026-10-18")
        #expect(Frontmatter.isOniAuthored(note))
        #expect(!Frontmatter.isOniAuthored("---\noni: false\n---\n\nBody"))
        #expect(!Frontmatter.isOniAuthored("Just text, no frontmatter."))
        #expect(Frontmatter.isOniAuthored("---\noni: TRUE\n---\nx"))
    }

    @Test func anIndentedOrNestedFieldIsNotAnOniMarker() {
        #expect(!Frontmatter.isOniAuthored("---\nmeta:\n  oni: true\n---\nx"))
        #expect(!Frontmatter.isOniAuthored("---\nnot_oni: true\n---\nx"))
    }

    @Test func splitsBodyFromFrontmatter() {
        let (fm, body) = Frontmatter.split("---\noni: true\n---\n\n# Title\n\ntext\n")
        #expect(fm == "\noni: true")
        #expect(body == "# Title\n\ntext\n")
    }

    @Test func noClosingFenceMeansNoFrontmatter() {
        let text = "---\nthis never closes\nand has body text"
        #expect(Frontmatter.split(text).frontmatter == nil)
        #expect(Frontmatter.split(text).body == text)
    }

    @Test func handlesWindowsLineEndings() {
        let (fm, body) = Frontmatter.split("---\r\noni: true\r\n---\r\n\r\nBody")
        #expect(fm != nil)
        #expect(body.hasSuffix("Body"))
    }

    @Test func listsScalarProperties() {
        let props = Frontmatter.properties(in: "---\noni: true\ntags: [a, b]\nlist:\n  - x\ncreated: 2026-10-18\n---\nx")
        #expect(props.map(\.key) == ["oni", "tags", "created"])
    }
}

@Suite struct WikiLinkTests {
    private func rewritten(_ s: String) -> String { WikiLinks.rewrite(s) }
    private func url(_ target: String, _ heading: String? = nil) -> String { WikiLinks.url(target: target, heading: heading) }

    @Test func plainAliasedAndHeadingLinks() {
        #expect(rewritten("see [[Ana — Notes]] now") == "see [Ana — Notes](\(url("Ana — Notes"))) now")
        #expect(rewritten("[[Ana|my friend]]") == "[my friend](\(url("Ana")))")
        #expect(rewritten("[[Ana#Contact]]") == "[Ana › Contact](\(url("Ana", "Contact")))")
        #expect(rewritten("[[Ana#Contact|her number]]") == "[her number](\(url("Ana", "Contact")))")
    }

    @Test func anAliasInsideATableCellUsesAnEscapedPipe() {
        // Obsidian writes [[A\|B]] in a table; the result must contain no bare pipe.
        let out = rewritten("| [[Ana\\|friend]] | x |")
        #expect(out == "| [friend](\(url("Ana"))) | x |")
    }

    @Test func linksInsideCodeAreLeftAlone() {
        #expect(rewritten("use `[[not a link]]` here") == "use `[[not a link]]` here")
        #expect(rewritten("```\n[[in a fence]]\n```") == "```\n[[in a fence]]\n```")
        #expect(rewritten("a [[Real]] and `[[Code]]` and [[Real2]]").contains("[Real]("))
        #expect(rewritten("a [[Real]] and `[[Code]]` and [[Real2]]").contains("`[[Code]]`"))
    }

    @Test func embedsBecomeMarkedLinksAndSameNoteHeadingsBecomeText() {
        #expect(rewritten("![[Diagram]]").hasPrefix("[↪ Diagram]("))
        #expect(rewritten("[[#Heading]]") == "Heading")
    }

    @Test func titlesWithBracketsOrSpecialCharactersRoundTrip() throws {
        let out = rewritten("[[C++ Basics & Pointers]]")
        let start = try #require(out.range(of: "(oni-note"))
        let link = String(out[start.upperBound...].dropLast()).replacingOccurrences(of: "", with: "")
        let parsed = WikiLinks.parse(url: try #require(URL(string: "oni-note" + link)))
        #expect(parsed?.target == "C++ Basics & Pointers")
    }

    @Test func parseRejectsOtherSchemes() {
        #expect(WikiLinks.parse(url: URL(string: "https://example.com")!) == nil)
        #expect(WikiLinks.parse(url: URL(string: "oni-note://open")!) == nil)
    }

    @Test func extractsTargetsOutsideCode() {
        let text = "[[A]] and [[B|b]] and `[[C]]`\n```\n[[D]]\n```\n[[E#h]]"
        #expect(WikiLinks.targets(in: text) == ["A", "B", "E"])
    }
}

@Suite struct NoteIndexTests {
    private func index() -> NoteIndex {
        func n(_ p: String, _ t: String) -> (info: NoteInfo, text: String) { (NoteInfo(path: p), t) }
        return NoteIndex(notes: [
            n("People/Ana — Notes.md", "---\noni: true\n---\n\nAna likes Recursion and Pasta.\nSee [[Master Profile]]."),
            n("Master Profile.md", "Mohit studies at HKU."),
            n("Semester 1/Recursion Basics.md", "Base case, recursive case."),
            n("Semester 2/Recursion Basics.md", "A duplicate title deeper in the tree."),
            n("Plans.md", "---\nsecretkey: recursion\n---\n\nNothing about it in the body."),
        ])
    }

    @Test func resolvesByTitleThenCaseInsensitivelyThenByPath() {
        let i = index()
        #expect(i.resolve("Master Profile") == "Master Profile.md")
        #expect(i.resolve("master profile") == "Master Profile.md")
        #expect(i.resolve("People/Ana — Notes") == "People/Ana — Notes.md")
        #expect(i.resolve("People/Ana — Notes.md") == "People/Ana — Notes.md")
        #expect(i.resolve("No Such Note") == nil)
    }

    @Test func aTitleTieGoesToTheShortestPath() {
        #expect(index().resolve("Recursion Basics") == "Semester 1/Recursion Basics.md")
    }

    @Test func searchesTitlesAndContentWithTitleMatchesFirst() {
        let hits = index().search("recursion")
        #expect(hits.first?.titleMatched == true)
        #expect(Set(hits.map(\.path)) == [
            "Semester 1/Recursion Basics.md", "Semester 2/Recursion Basics.md",
            "People/Ana — Notes.md", "Plans.md",
        ])
        #expect(hits.map(\.titleMatched) == [true, true, false, false])
    }

    @Test func theSnippetComesFromTheBodyNotTheFrontmatter() {
        let hits = index().search("recursion")
        let ana = hits.first { $0.path == "People/Ana — Notes.md" }
        #expect(ana?.snippet.contains("Ana likes Recursion") == true)
        #expect(ana?.snippet.contains("oni: true") == false)
        // Matched only inside frontmatter: found, but no snippet to show.
        #expect(hits.first { $0.path == "Plans.md" }?.snippet == "")
    }

    @Test func emptyOrWhitespaceQueriesFindNothingAndResultsAreCapped() {
        #expect(index().search("   ").isEmpty)
        let many = NoteIndex(notes: (0..<50).map { (NoteInfo(path: "N\($0).md"), "needle") })
        #expect(many.search("needle").count == NoteIndex.maxResults)
    }

    @Test func backlinksFindNotesThatLinkHere() {
        #expect(index().backlinks(to: "Master Profile.md").map(\.path) == ["People/Ana — Notes.md"])
        #expect(index().backlinks(to: "Plans.md").isEmpty)
    }
}

@Suite struct NoteTreeTests {
    @Test func buildsFoldersNotesAndCounts() {
        let tree = NoteTree.build([
            "Root B.md", "Root A.md", "People/Ana.md", "Semester 10/X.md", "Semester 2/Course/Y.md", "Semester 2/Z.md",
        ].map { NoteInfo(path: $0) })
        #expect(tree.notes.map(\.title) == ["Root A", "Root B"])
        #expect(tree.folders.map(\.name) == ["People", "Semester 2", "Semester 10"])  // natural order
        #expect(tree.totalNotes == 6)
        let sem2 = NoteTree.node(at: "Semester 2", in: tree)
        #expect(sem2?.totalNotes == 2 && sem2?.folders.map(\.name) == ["Course"])
        #expect(NoteTree.node(at: "Semester 2/Course", in: tree)?.notes.map(\.title) == ["Y"])
        #expect(NoteTree.node(at: "Nope", in: tree) == nil)
        #expect(NoteTree.node(at: "", in: tree)?.totalNotes == 6)
    }
}

@Suite struct MarkdownBlockTests {
    @Test func theFrontmatterIsNotRendered() {
        let blocks = MarkdownBlocks.parse(note: "---\noni: true\n---\n\n# Title\n\nHello **world**.")
        #expect(blocks.count == 2)
        guard case let .heading(level, text) = blocks[0] else { Issue.record("not a heading"); return }
        #expect(level == 1 && plain(text) == "Title")
    }

    @Test func inlineStylingIsKeptAsAttributes() throws {
        guard case let .paragraph(text) = MarkdownBlocks.parse(markdown: "a **bold** _it_ `code` ~~gone~~ [site](https://example.com)")[0]
        else { Issue.record("not a paragraph"); return }
        #expect(plain(text) == "a bold it code gone site")
        func intent(of word: String) -> InlinePresentationIntent? {
            text.runs.first { String(text[$0.range].characters) == word }?.inlinePresentationIntent
        }
        #expect(intent(of: "bold")?.contains(.stronglyEmphasized) == true)
        #expect(intent(of: "it")?.contains(.emphasized) == true)
        #expect(intent(of: "code")?.contains(.code) == true)
        #expect(intent(of: "gone")?.contains(.strikethrough) == true)
        #expect(text.runs.contains { $0.link == URL(string: "https://example.com") })
    }

    @Test func wikilinksBecomeTappableLinks() throws {
        guard case let .paragraph(text) = MarkdownBlocks.parse(markdown: "see [[Ana — Notes|Ana]] today")[0]
        else { Issue.record("not a paragraph"); return }
        #expect(plain(text) == "see Ana today")
        let link = try #require(text.runs.compactMap(\.link).first)
        #expect(WikiLinks.parse(url: link)?.target == "Ana — Notes")
    }

    @Test func tablesKeepHeadersAlignmentsAndCellLinks() {
        let md = "| Course | Day | Room |\n|:--|:-:|--:|\n| [[COMP1110]] | Mon | CPD 1.02 |\n| MATH1001 | Tue | — |\n"
        guard case let .table(header, alignments, rows) = MarkdownBlocks.parse(markdown: md)[0]
        else { Issue.record("not a table"); return }
        #expect(header.map(plain) == ["Course", "Day", "Room"])
        #expect(alignments == [.leading, .center, .trailing])
        #expect(rows.count == 2 && rows[0].map(plain) == ["COMP1110", "Mon", "CPD 1.02"])
        #expect(rows[0][0].runs.contains { $0.link != nil })
    }

    @Test func aliasedWikilinkInsideATableCellSurvivesTheTableParser() {
        guard case let .table(_, _, rows) = MarkdownBlocks.parse(markdown: "| a | b |\n|--|--|\n| [[Ana\\|friend]] | x |\n")[0]
        else { Issue.record("not a table"); return }
        #expect(rows[0].map(plain) == ["friend", "x"])
    }

    @Test func calloutsKeepKindTitleAndBody() {
        let md = "> [!warning] Deadline\n> Submit by Friday.\n>\n> - one\n> - two\n"
        guard case let .callout(kind, title, body) = MarkdownBlocks.parse(markdown: md)[0]
        else { Issue.record("not a callout"); return }
        #expect(kind == "warning" && plain(title) == "Deadline")
        #expect(body.count == 2)
        if case let .paragraph(p) = body[0] { #expect(plain(p) == "Submit by Friday.") } else { Issue.record("body[0]") }
        if case let .list(ordered, _, items) = body[1] { #expect(!ordered && items.count == 2) } else { Issue.record("body[1]") }
    }

    @Test func aCalloutWithNoTitleUsesItsKind() {
        guard case let .callout(kind, title, _) = MarkdownBlocks.parse(markdown: "> [!note]\n> Body")[0]
        else { Issue.record("not a callout"); return }
        #expect(kind == "note" && plain(title) == "Note")
    }

    @Test func foldableCalloutMarkersAreAccepted() {
        guard case let .callout(kind, title, _) = MarkdownBlocks.parse(markdown: "> [!tip]- Hidden\n> Body")[0]
        else { Issue.record("not a callout"); return }
        #expect(kind == "tip" && plain(title) == "Hidden")
    }

    @Test func anOrdinaryQuoteStaysAQuote() {
        guard case let .quote(inner) = MarkdownBlocks.parse(markdown: "> just a quote\n> second line")[0]
        else { Issue.record("not a quote"); return }
        #expect(inner.count == 1)
    }

    @Test func nestedAndTaskLists() {
        let md = "- a\n  - b\n  - c\n- [x] done\n- [ ] todo\n\n3. three\n4. four\n"
        let blocks = MarkdownBlocks.parse(markdown: md)
        guard case let .list(_, _, items) = blocks[0] else { Issue.record("not a list"); return }
        #expect(items.count == 3)
        guard case let .list(_, _, nested) = items[0].blocks[1] else { Issue.record("no nested list"); return }
        #expect(nested.count == 2)
        #expect(items[1].checked == true && items[2].checked == false && items[0].checked == nil)
        guard case let .list(ordered, start, _) = blocks[1] else { Issue.record("not ordered"); return }
        #expect(ordered && start == 3)
    }

    @Test func codeFencesKeepTheirTextAndLanguageAndAreNotLinkRewritten() {
        guard case let .code(language, text) = MarkdownBlocks.parse(markdown: "```python\nx = [[1, 2], [3]]\nprint(x)\n```")[0]
        else { Issue.record("not code"); return }
        #expect(language == "python" && text == "x = [[1, 2], [3]]\nprint(x)")
    }

    @Test func rulesAndHeadingLevels() {
        let blocks = MarkdownBlocks.parse(markdown: "## Two\n\n---\n\n###### Six")
        guard case .heading(2, _) = blocks[0], case .rule = blocks[1], case .heading(6, _) = blocks[2]
        else { Issue.record("unexpected blocks: \(blocks)"); return }
    }

    @Test func htmlIsReducedToItsText() {
        let blocks = MarkdownBlocks.parse(markdown: "<div class=\"x\">hello<br>there</div>")
        guard case let .paragraph(p) = blocks[0] else { Issue.record("not text"); return }
        #expect(plain(p) == "hello\nthere")
    }

    @Test func aDollarMathSpanIsLeftReadable() {
        guard case let .paragraph(p) = MarkdownBlocks.parse(markdown: "energy is $E = mc^2$ here")[0]
        else { Issue.record("not text"); return }
        #expect(plain(p) == "energy is $E = mc^2$ here")
    }

    @Test func emptyInputIsNoBlocks() {
        #expect(MarkdownBlocks.parse(note: "").isEmpty)
        #expect(MarkdownBlocks.parse(note: "---\noni: true\n---\n").isEmpty)
    }
}

/// Real notes, not hand-written samples. Runs only under `Scripts/integration.sh`,
/// which points ONI_TEST_VAULT_DIR at a temp copy of the real Vault.
private let realVault = ProcessInfo.processInfo.environment["ONI_TEST_VAULT_DIR"]

@Suite(.enabled(if: realVault != nil)) struct RealVaultContent {
    private func replica() throws -> Replica {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oni-content-\(UUID().uuidString)")
        let replica = Replica(directory: dir)
        let root = URL(fileURLWithPath: realVault!)
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])!
        let prefix = root.resolvingSymlinksInPath().path + "/"
        for case let url as URL in walker where url.pathExtension == "md" {
            let rel = String(url.resolvingSymlinksInPath().path.dropFirst(prefix.count))
            if NotePath.isValid(rel) { try replica.write(rel, data: Data(contentsOf: url)) }
        }
        return replica
    }

    @Test func everyRealNoteParsesAndTheFeaturesTheVaultUsesShowUp() throws {
        let replica = try replica()
        defer { try? FileManager.default.removeItem(at: replica.notesRoot.deletingLastPathComponent()) }
        let index = replica.buildIndex()
        #expect(index.count > 100)

        var tables = 0, callouts = 0, code = 0, links = 0
        func walk(_ blocks: [MDBlock]) {
            for b in blocks {
                switch b {
                case .table: tables += 1
                case let .callout(_, _, body): callouts += 1; walk(body)
                case .code: code += 1
                case let .quote(inner): walk(inner)
                case let .list(_, _, items): for item in items { walk(item.blocks) }
                case let .paragraph(t): links += t.runs.filter { $0.link != nil }.count
                default: break
                }
            }
        }
        var empty: [String] = []
        for info in index.notes {
            let blocks = MarkdownBlocks.parse(note: index.text(of: info.path) ?? "")
            if blocks.isEmpty { empty.append(info.path) }
            walk(blocks)
        }
        print("real vault: \(index.count) notes → \(tables) tables, \(callouts) callouts, \(code) code blocks, \(links) paragraph links; empty: \(empty.count)")
        #expect(tables > 50 && callouts > 50 && code > 20 && links > 500)
        #expect(empty.count < 10, "\(empty)")
    }

    @Test func mostRealWikilinksResolveToARealNote() throws {
        let replica = try replica()
        defer { try? FileManager.default.removeItem(at: replica.notesRoot.deletingLastPathComponent()) }
        let index = replica.buildIndex()
        var total = 0
        var unresolved: [String: Int] = [:]
        for info in index.notes {
            for target in WikiLinks.targets(in: index.text(of: info.path) ?? "") {
                total += 1
                if index.resolve(target) == nil { unresolved[target, default: 0] += 1 }
            }
        }
        let missing = unresolved.values.reduce(0, +)
        print("real vault wikilinks: \(total) total, \(missing) unresolved (\(unresolved.count) distinct), top: \(unresolved.sorted { $0.value > $1.value }.prefix(5).map { "\($0.key)×\($0.value)" })")
        #expect(total > 500)
        #expect(Double(missing) / Double(total) < 0.10)
    }
}
