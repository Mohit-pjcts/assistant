import Foundation
import Testing
@testable import OniCore

/// One real conversation against the live API. Skipped unless
/// `ONI_SMOKE_ANTHROPIC_KEY` is set, because it spends real money (a few cents):
/// `ios/OniCore/Scripts/smoke.sh` sets it from the Mac's `.env` without printing it.
/// Everything it touches is a temp folder, never the real Vault.
private let smokeKey = ProcessInfo.processInfo.environment["ONI_SMOKE_ANTHROPIC_KEY"]

@Suite(.enabled(if: smokeKey != nil), .serialized) struct SmokeRealAPI {
    private func converse(_ model: ClaudeModel) async throws {
        let (replica, dir) = tempReplica()
        defer { try? FileManager.default.removeItem(at: dir) }
        try replica.write("Spanish Plan.md", text: "# Spanish Plan\n\nTuesday: flashcards for 20 minutes. Friday: speaking practice.\n")
        let agent = ChatAgent(client: AnthropicHTTPClient(apiKey: smokeKey!), toolbox: VaultToolbox(replica: replica))

        var history: [JSONValue] = []
        var usage = Usage()
        var transcript: [String] = []

        func turn(_ prompt: String) async throws -> [AgentEvent] {
            history.append(Chat.userMessage(prompt))
            let events = await collect(agent.run(history: history, model: model))
            history = committedHistory(events)
            // `.usage` carries a running total for the turn; the last one is the turn's sum.
            for case .usage(let u) in events.reversed() { usage.add(u); break }
            for case .failure(let why) in events.compactMap({ e -> Finish? in if case .finished(let f) = e { f } else { nil } }) {
                Issue.record("turn failed: \(why)")
            }
            let reply = events.compactMap { e -> String? in if case .textDelta(let t) = e { t } else { nil } }.joined()
            transcript.append("USER: \(prompt)\nONI: \(reply)")
            return events
        }

        // 1. Answer from the vault.
        let first = try await turn("What does my Spanish plan say I do on Tuesday?")
        #expect(history.last?["content"]?.array?.contains { $0["text"]?.string?.lowercased().contains("flashcard") == true } == true)
        #expect(first.contains { if case .toolStarted = $0 { true } else { false } })

        // 2. Save something unasked-for-by-name; it must come out as a linked, Oni-authored note.
        _ = try await turn("Remember that I want to try a pottery class in November.")
        let saved = replica.listNotes().map(\.path).filter { $0 != "Spanish Plan.md" }
        #expect(saved.count == 1, "expected exactly one new note, got \(saved)")
        if let path = saved.first { #expect(Frontmatter.isOniAuthored(replica.text(path) ?? "")) }

        // 3. The user's own note is protected.
        let original = replica.text("Spanish Plan.md")
        _ = try await turn("Delete my Spanish Plan note.")
        #expect(replica.text("Spanish Plan.md") == original)

        let cost = model.cost(of: usage)
        print("SMOKE \(model.rawValue): cost≈$\(String(format: "%.4f", cost)) usage=\(usage) notes=\(saved)")
        for t in transcript { print("SMOKE ---\n\(t)") }
    }

    @Test func haiku() async throws { try await converse(.haiku) }
    @Test func sonnet() async throws { try await converse(.sonnet) }
}
