import Foundation
import Testing
@testable import OniCore

@Suite struct JSONAndPricingTests {
    @Test func roundTripsAndKeepsIntegersIntegral() throws {
        let value: JSONValue = ["a": 1, "b": [true, .null, "x"], "c": .number(1.5)]
        let data = try value.encoded()
        #expect(String(data: data, encoding: .utf8) == #"{"a":1,"b":[true,null,"x"],"c":1.5}"#)
        #expect(try JSONDecoder().decode(JSONValue.self, from: data) == value)
    }

    @Test func slashesAreNotEscapedAndKeysAreSorted() throws {
        let data = try (["z": "a/b", "a": 1] as JSONValue).encoded()
        #expect(String(data: data, encoding: .utf8) == #"{"a":1,"z":"a/b"}"#)
    }

    @Test func costMatchesTheRateCard() {
        // Haiku: $0.10 in / $0.50 out per MTok; cache write 1.25x, read 0.1x.
        let u = Usage(inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000)
        // 3M prompt tokens is over 100K, so Haiku's long-prompt rates ($0.50 / $2.50) apply.
        #expect(abs(ClaudeModel.haiku.cost(of: u) - (0.50 + 0.50 * 1.25 + 0.05 + 2.50)) < 1e-9)
        let small = Usage(inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 50_000)
        #expect(abs(ClaudeModel.haiku.cost(of: small) - (0.001 + 0.0005 + 0.001)) < 1e-9)
        #expect(abs(ClaudeModel.sonnet.cost(of: Usage(inputTokens: 1_000_000, outputTokens: 1_000_000)) - 12.0) < 1e-9)
        #expect(abs(ClaudeModel.sonnet.cost(of: Usage(cacheReadTokens: 1_000_000)) - 0.20) < 1e-9)
    }

    @Test func requestBodyCachesTheStablePrefixAndIsDeterministic() throws {
        let tools: [JSONValue] = [["name": "a", "input_schema": ["type": "object"]], ["name": "b", "input_schema": ["type": "object"]]]
        let req = ChatRequest(model: .haiku, system: "SYS", tools: tools, messages: [Chat.userMessage("hi")])
        let one = try AnthropicHTTPClient.body(for: req)
        #expect(one == (try AnthropicHTTPClient.body(for: req)))
        let body = try #require(JSONValue.parse(String(data: one, encoding: .utf8)!))
        #expect(body["model"]?.string == "claude-haiku-5-5")
        #expect(body["stream"]?.bool == true)
        #expect(body["thinking"] == nil)  // Sonnet 5.5 rejects "disabled"; effort steers instead
        #expect(body["output_config"]?["effort"]?.string == "low")
        #expect(body["system"]?.array?.first?["cache_control"]?["type"]?.string == "ephemeral")
        #expect(body["tools"]?.array?[0]["cache_control"] == nil)
        #expect(body["tools"]?.array?[1]["cache_control"]?["type"]?.string == "ephemeral")
        let sonnet = try AnthropicHTTPClient.body(for: ChatRequest(model: .sonnet, system: "S", tools: tools, messages: []))
        #expect(JSONValue.parse(String(data: sonnet, encoding: .utf8)!)?["output_config"]?["effort"]?.string == "medium")
    }

    @Test func httpErrorsMapToFriendlyCases() {
        func map(_ s: Int, _ body: String = "", _ retry: String? = nil) -> ClaudeError {
            AnthropicHTTPClient.error(status: s, body: body, retryAfter: retry)
        }
        #expect(map(401) == .invalidKey)
        #expect(map(403) == .blocked)  // a region block, not a bad key
        #expect(ClaudeError.blocked.errorDescription?.contains("still saved") == true)
        #expect(map(429, "", "12") == .rateLimited(retryAfter: 12))
        #expect(map(529) == .overloaded)
        #expect(map(400, #"{"error":{"type":"invalid_request_error","message":"bad"}}"#) == .api(status: 400, message: "bad"))
    }
}

@Suite struct StreamAssemblerTests {
    private func run(_ lines: [String]) throws -> (AssembledMessage, [StreamAssembler.Output]) {
        var a = StreamAssembler()
        var outputs: [StreamAssembler.Output] = []
        for l in lines { outputs += try a.consume(data: l) }
        return (try a.message(), outputs)
    }

    private let start = #"{"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":900,"cache_creation_input_tokens":0,"output_tokens":1}}}"#

    @Test func assemblesTextAndUsage() throws {
        let (m, out) = try run([
            start,
            #"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}"#,
            #"{"type":"ping"}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
            #"{"type":"message_stop"}"#,
        ])
        #expect(m.text == "Hello" && m.stopReason == "end_turn")
        #expect(out == [.text("Hel"), .text("lo")])
        #expect(m.usage == Usage(inputTokens: 50, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 900))
    }

    @Test func assemblesAToolCallFromPartialJSON() throws {
        let (m, out) = try run([
            start,
            #"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking."}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"search_vault","input":{}}}"#,
            #"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"que"}}"#,
            #"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ry\": \"recursion\"}"}}"#,
            #"{"type":"content_block_stop","index":1}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}"#,
            #"{"type":"message_stop"}"#,
        ])
        #expect(out.contains(.toolStarted(id: "toolu_1", name: "search_vault")))
        let use = try #require(m.toolUses.first)
        #expect(use.id == "toolu_1" && use.name == "search_vault" && use.input["query"]?.string == "recursion")
        #expect(m.stopReason == "tool_use" && m.malformedToolUseIDs.isEmpty)
    }

    @Test func aToolWithNoArgumentsGetsAnEmptyObject() throws {
        let (m, _) = try run([
            start,
            #"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"x","input":{}}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}"#,
            #"{"type":"message_stop"}"#,
        ])
        #expect(m.toolUses.first?.input == [:])
        #expect(m.malformedToolUseIDs.isEmpty)
    }

    @Test func truncatedToolJSONIsFlaggedAndNeverTrusted() throws {
        let (m, _) = try run([
            start,
            #"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"cut","name":"write_vault_note","input":{}}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"title\":\"A\",\"content\":\"half a no"}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":99}}"#,
            #"{"type":"message_stop"}"#,
        ])
        #expect(m.malformedToolUseIDs == ["cut"])
        #expect(m.toolUses.first?.input == [:])
    }

    @Test func thinkingBlocksKeepTheirSignatureForReplay() throws {
        let (m, _) = try run([
            start,
            #"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#,
            #"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG=="}}"#,
            #"{"type":"content_block_stop","index":0}"#,
            #"{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"ENC"}}"#,
            #"{"type":"content_block_stop","index":1}"#,
            #"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#,
            #"{"type":"message_stop"}"#,
        ])
        #expect(m.content[0] == ["type": "thinking", "thinking": "hmm", "signature": "SIG=="])
        #expect(m.content[1] == ["type": "redacted_thinking", "data": "ENC"])
    }

    @Test func aStreamThatEndsEarlyIsAnErrorNotATurn() throws {
        var a = StreamAssembler()
        _ = try a.consume(data: start)
        #expect(throws: ClaudeError.self) { try a.message() }
    }

    @Test func errorEventsSurface() {
        var a = StreamAssembler()
        #expect(throws: ClaudeError.overloaded) {
            try a.consume(data: #"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#)
        }
        #expect(throws: ClaudeError.stream("boom")) {
            try a.consume(data: #"{"type":"error","error":{"type":"api_error","message":"boom"}}"#)
        }
    }

    @Test func junkLinesAreIgnored() throws {
        var a = StreamAssembler()
        #expect(try a.consume(data: "not json").isEmpty)
        #expect(try a.consume(data: "").isEmpty)
    }
}

@Suite struct ChatModelTests {
    @Test func transcriptShowsTextAndToolCallsAndMarksFailures() {
        let messages: [JSONValue] = [
            Chat.userMessage("what's in my plan?"),
            ["role": "assistant", "content": [text("Let me look."), toolUse("a", "search_vault", ["query": "plan"]),
                                              toolUse("b", "read_vault_note", ["title": "Nope"])]],
            ["role": "user", "content": [["type": "tool_result", "tool_use_id": "a", "content": "ok"],
                                         ["type": "tool_result", "tool_use_id": "b", "content": "Error: no", "is_error": true]]],
            ["role": "assistant", "content": [text("Found it.")]],
        ]
        #expect(Transcript.items(from: messages) == [
            .user(id: 1, text: "what's in my plan?"), .assistant(id: 2, text: "Let me look."),
            .tool(id: 3, name: "search_vault", detail: "plan", failed: false),
            .tool(id: 4, name: "read_vault_note", detail: "Nope", failed: true),
            .assistant(id: 5, text: "Found it."),
        ])
    }

    @Test func toolResultOnlyUserMessagesAreNotShownAsUserBubbles() {
        let items = Transcript.items(from: [["role": "user", "content": [["type": "tool_result", "tool_use_id": "a", "content": "x"]]]])
        #expect(items.isEmpty)
    }

    @Test func titleComesFromTheFirstMessageAndCostSumsAcrossModels() {
        var chat = Chat(model: .haiku)
        chat.apply(committed: [Chat.userMessage("Remind me what my Spanish plan says\nplease")])
        #expect(chat.title == "Remind me what my Spanish plan says")
        chat.record(Usage(inputTokens: 1_000_000), model: .haiku)
        chat.record(Usage(inputTokens: 1_000_000), model: .sonnet)
        #expect(abs(chat.cost - (0.50 + 2.00)) < 1e-9)  // 1M prompt tokens is past Haiku's 100K tier
        chat.apply(committed: [Chat.userMessage("a different later title")])
        #expect(chat.title == "Remind me what my Spanish plan says")  // set once
    }

    @Test func storeRoundTripsEverythingIncludingThinkingBlocks() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("oni-store-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = ChatStore(directory: dir)
        #expect(store.load().isEmpty)
        var chat = Chat(model: .sonnet)
        chat.apply(committed: [
            Chat.userMessage("hi"),
            ["role": "assistant", "content": [["type": "thinking", "thinking": "", "signature": "SIG=="], text("hello")]],
        ])
        chat.record(Usage(inputTokens: 5, outputTokens: 6), model: .sonnet)
        try store.save([chat])
        let back = try #require(store.load().first)
        #expect(back.messages == chat.messages && back.usageByModel == chat.usageByModel && back.model == .sonnet)
    }
}
