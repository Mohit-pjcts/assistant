import Foundation
import Testing
@testable import OniCore

@Suite struct ChatAgentTests {
    private func agent(_ replies: [Result<AssembledMessage, Error>], replica: Replica, hang: Bool = false) -> (ChatAgent, Script) {
        let script = Script(replies)
        return (ChatAgent(client: ScriptedClient(script: script, hang: hang), toolbox: toolbox(replica)), script)
    }

    @Test func aPlainAnswerIsOneCallAndCommitsTheHistory() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let (a, script) = agent([.success(assembled(content: [text("Hi!")], stop: "end_turn"))], replica: r)
        let events = await collect(a.run(history: [Chat.userMessage("hello")], model: .haiku))
        #expect(finish(events) == .done)
        #expect(events.contains(.textDelta("Hi!")))
        let h = committedHistory(events)
        #expect(h.count == 2 && h[1]["role"]?.string == "assistant")
        #expect(await script.requests.count == 1)
        #expect(await script.requests[0].tools.count == 5)
    }

    @Test func aToolRoundTripSendsAllResultsBackInOneUserMessage() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Pasta.md", text: "carbonara")
        let (a, script) = agent([
            .success(assembled(content: [text("Looking."), toolUse("t1", "search_vault", ["query": "carbonara"]),
                                         toolUse("t2", "read_vault_note", ["title": "Pasta"])], stop: "tool_use")),
            .success(assembled(content: [text("It's about carbonara.")], stop: "end_turn", usage: Usage(inputTokens: 200, outputTokens: 20))),
        ], replica: r)
        let events = await collect(a.run(history: [Chat.userMessage("pasta?")], model: .haiku))
        #expect(finish(events) == .done)

        let second = try #require(await script.requests.last)
        #expect(second.messages.count == 3)
        let results = try #require(second.messages[2]["content"]?.array)
        #expect(results.count == 2)  // both tool results, one message
        #expect(results.map { $0["tool_use_id"]?.string } == ["t1", "t2"])
        #expect(results[1]["content"]?.string == "carbonara")
        #expect(results.allSatisfy { $0["is_error"] == nil })

        var total = Usage()
        for case .usage(let u) in events { total = u }
        #expect(total.inputTokens == 300 && total.outputTokens == 30)  // summed across both calls
        #expect(events.contains(.toolFinished(name: "search_vault", isError: false, wroteVault: false)))
    }

    @Test func aWriteToolFlagsTheVaultAsChanged() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let (a, _) = agent([
            .success(assembled(content: [toolUse("w", "write_vault_note", ["title": "Idea", "content": "x"])], stop: "tool_use")),
            .success(assembled(content: [text("Saved.")], stop: "end_turn")),
        ], replica: r)
        let events = await collect(a.run(history: [Chat.userMessage("remember this")], model: .haiku))
        #expect(events.contains(.toolFinished(name: "write_vault_note", isError: false, wroteVault: true)))
        #expect(r.text("Idea.md")?.contains("oni: true") == true)
    }

    @Test func threeIdenticalFailuresStopTheLoopAndLeaveValidHistory() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let bad = assembled(content: [toolUse("x", "read_vault_note", ["title": "Nope"])], stop: "tool_use")
        let (a, script) = agent([.success(bad), .success(bad), .success(bad), .success(bad)], replica: r)
        let events = await collect(a.run(history: [Chat.userMessage("read it")], model: .haiku))
        #expect(finish(events) == .breaker(tool: "read_vault_note"))
        #expect(await script.requests.count == 3)  // the fourth call is never made
        let h = committedHistory(events)
        #expect(h.last?["role"]?.string == "assistant")
        #expect(h.last?["content"]?.array?.first?["text"]?.string?.contains("stopped") == true)
        // every assistant tool_use is answered by the next user message
        for (i, m) in h.enumerated() where m["role"]?.string == "assistant"
            && m["content"]?.array?.contains(where: { $0["type"]?.string == "tool_use" }) == true {
            #expect(h[i + 1]["role"]?.string == "user")
        }
    }

    @Test func aSuccessInBetweenResetsTheFailureStreak() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Real.md", text: "x")
        func call(_ title: String) -> Result<AssembledMessage, Error> {
            .success(assembled(content: [toolUse("c", "read_vault_note", ["title": .string(title)])], stop: "tool_use"))
        }
        let (a, _) = agent([call("Nope"), call("Nope"), call("Real"), call("Nope"), call("Nope"),
                            .success(assembled(content: [text("done")], stop: "end_turn"))], replica: r)
        #expect(finish(await collect(a.run(history: [Chat.userMessage("go")], model: .haiku))) == .done)
    }

    @Test func aDifferentFailingToolDoesNotCountTowardTheStreak() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        func call(_ name: String) -> Result<AssembledMessage, Error> {
            .success(assembled(content: [toolUse("c", name, ["title": "Nope", "content": "x"])], stop: "tool_use"))
        }
        let (a, _) = agent([call("read_vault_note"), call("update_vault_note"), call("read_vault_note"), call("update_vault_note"),
                            .success(assembled(content: [text("done")], stop: "end_turn"))], replica: r)
        #expect(finish(await collect(a.run(history: [Chat.userMessage("go")], model: .haiku))) == .done)
    }

    @Test func aLoopThatNeverFinishesIsCappedAtTheCallLimit() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        try r.write("Real.md", text: "x")
        let ok = assembled(content: [toolUse("c", "read_vault_note", ["title": "Real"])], stop: "tool_use")
        let (a, script) = agent(Array(repeating: .success(ok), count: 60), replica: r)
        let events = await collect(a.run(history: [Chat.userMessage("go")], model: .haiku))
        #expect(finish(events) == .callLimit)
        #expect(await script.requests.count == ChatAgent.Limit.modelCalls)
    }

    @Test func truncatedToolArgumentsAreNotRunAndAreReportedAsAnError() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let cut = assembled(content: [toolUse("cut", "write_vault_note", [:])], stop: "tool_use", malformed: ["cut"])
        let (a, script) = agent([.success(cut), .success(assembled(content: [text("sorry")], stop: "end_turn"))], replica: r)
        _ = await collect(a.run(history: [Chat.userMessage("write a long note")], model: .haiku))
        #expect(r.listNotes().isEmpty)  // nothing written from half an argument list
        let result = try #require(await script.requests.last?.messages.last?["content"]?.array?.first)
        #expect(result["is_error"]?.bool == true && result["content"]?.string?.contains("cut off") == true)
    }

    @Test func refusalAndMaxTokensEndTheTurnWithAMatchingFinish() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let (a, _) = agent([.success(assembled(content: [], stop: "refusal"))], replica: r)
        #expect(finish(await collect(a.run(history: [Chat.userMessage("x")], model: .haiku))) == .refused)
        let (b, _) = agent([.success(assembled(content: [text("partial")], stop: "max_tokens"))], replica: r)
        #expect(finish(await collect(b.run(history: [Chat.userMessage("x")], model: .haiku))) == .truncated)
    }

    @Test func anAPIErrorFailsTheTurnAndCommitsOnlyTheLastGoodHistory() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let user = Chat.userMessage("hello")
        let (a, _) = agent([.failure(ClaudeError.invalidKey)], replica: r)
        let events = await collect(a.run(history: [user], model: .haiku))
        #expect(finish(events) == .failure(ClaudeError.invalidKey.errorDescription!))
        #expect(committedHistory(events) == [user])
    }

    @Test func aFailureAfterATurnsToolsKeepsTheCompletedWork() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let (a, _) = agent([
            .success(assembled(content: [toolUse("w", "write_vault_note", ["title": "Kept", "content": "x"])], stop: "tool_use")),
            .failure(ClaudeError.overloaded),
        ], replica: r)
        let events = await collect(a.run(history: [Chat.userMessage("save")], model: .haiku))
        #expect(r.text("Kept.md") != nil)
        let h = committedHistory(events)
        #expect(h.count == 3)  // user, assistant tool_use, user tool_result: a valid prefix
        #expect(h[2]["content"]?.array?.first?["type"]?.string == "tool_result")
    }

    @Test func stopCancelsTheCallAndStillLeavesValidAlternatingHistory() async throws {
        let (r, dir) = tempReplica(); defer { try? FileManager.default.removeItem(at: dir) }
        let (a, _) = agent([], replica: r, hang: true)
        let run = a.run(history: [Chat.userMessage("long one")], model: .sonnet)
        let collecting = Task { await collect(run) }
        try await Task.sleep(for: .milliseconds(150))
        run.stop()
        let events = await collecting.value
        #expect(finish(events) == .stopped)
        let h = committedHistory(events)
        #expect(h.count == 2 && h[1]["role"]?.string == "assistant")
        #expect(h[1]["content"]?.array?.first?["text"]?.string == "(Stopped.)")
    }
}
