import Foundation
import Testing
@testable import OniCore

/// Every frame type the Mac's `/chat` stream can carry, as it is really
/// framed (`data: {json}`), including the ones the phone must not trust.
@Suite struct ChatFrameTests {
    private func parse(_ json: String) -> ChatFrame? { ChatFrame.parse(line: "data: " + json) }

    @Test func aTokenCarriesItsText() {
        #expect(parse(#"{"type": "token", "text": "Hel"}"#) == .token("Hel"))
        #expect(parse(#"{"type": "token", "text": "naïve — “q”\n"}"#) == .token("naïve — “q”\n"))
    }

    @Test func aMessageIsTerminal() {
        let frame = parse(#"{"type": "message", "content": "Done."}"#)
        #expect(frame == .message("Done."))
        #expect(frame?.isTerminal == true)
    }

    @Test func anErrorIsTerminalAndKeepsItsDetail() {
        let frame = parse(#"{"type": "error", "detail": "RateLimitError: slow down"}"#)
        #expect(frame == .error("RateLimitError: slow down"))
        #expect(frame?.isTerminal == true)
    }

    @Test func activityFramesBecomeStartsAndEnds() {
        #expect(parse(#"{"type": "activity", "phase": "tool_start", "agent": "research_agent", "tool": "web_search"}"#)
            == .activity(AgentActivity(phase: .toolStart, agent: "research_agent", tool: "web_search")))
        #expect(parse(#"{"type": "activity", "phase": "tool_end", "agent": "supervisor", "tool": "x"}"#)
            == .activity(AgentActivity(phase: .toolEnd, agent: "supervisor", tool: "x")))
        #expect(parse(#"{"type": "activity", "phase": "sideways", "agent": "a", "tool": "t"}"#) == .unknown("activity"))
        #expect(parse(#"{"type": "activity", "phase": "tool_start"}"#) == .unknown("activity"))
        #expect(parse(#"{"type": "token", "text": "x"}"#)?.isTerminal == false)
    }

    @Test func aGateBecomesAnInterruptWithItsRealContent() throws {
        let frame = parse(#"{"type": "interrupt", "payload": {"action": "send_imessage", "recipient": "+1555", "message": "hi", "voice_approvable": false}}"#)
        guard case .interrupt(let gate)? = frame else { Issue.record("expected an interrupt, got \(String(describing: frame))"); return }
        #expect(gate.action == "send_imessage")
        #expect(gate.rows.contains(.field(label: "To", value: "+1555")))
        #expect(frame?.isTerminal == true)
    }

    @Test func aGateThatCannotBeReadIsNeverShownBlind() {
        for payload in [#""just text""#, "null", "[1, 2]", "7"] {
            let frame = parse(#"{"type": "interrupt", "payload": \#(payload)}"#)
            #expect(frame == .unreadableInterrupt, "payload \(payload)")
            #expect(frame?.isTerminal == true)
        }
        #expect(parse(#"{"type": "interrupt"}"#) == .unreadableInterrupt)
    }

    @Test func aValidSurfaceIsDecodedAndAnInvalidOneIsRejectedNotDrawn() throws {
        let good = #"{"type": "a2ui", "surface": {"surfaceId": "s", "components": [{"id": "root", "component": "Text", "text": "hi"}]}}"#
        guard case .a2ui(let surface)? = parse(good) else { Issue.record("expected a surface"); return }
        #expect(surface.surfaceId == "s")

        let bad = #"{"type": "a2ui", "surface": {"surfaceId": "s", "components": [{"id": "root", "component": "Button", "child": "root", "action": {"name": "x", "functionCall": {}}}]}}"#
        guard case .rejectedSurface(let reason)? = parse(bad) else { Issue.record("expected a rejection"); return }
        #expect(reason.contains("action"))
        #expect(parse(#"{"type": "a2ui"}"#) == .rejectedSurface("the frame carried no surface"))
    }

    @Test func anUnknownTypeIsIgnoredAndNonDataLinesAreSkipped() {
        #expect(parse(#"{"type": "from_the_future"}"#) == .unknown("from_the_future"))
        #expect(ChatFrame.parse(line: "") == nil)
        #expect(ChatFrame.parse(line: ": keep-alive") == nil)
        #expect(ChatFrame.parse(line: "event: ping") == nil)
    }

    @Test func garbageIsReportedNotSilentlyDropped() {
        guard case .error? = parse("{not json") else { Issue.record("expected an error frame"); return }
        guard case .error? = parse("[]") else { Issue.record("expected an error frame"); return }
    }

    @Test func theSpaceAfterTheColonIsOptional() {
        #expect(ChatFrame.parse(line: #"data:{"type": "token", "text": "x"}"#) == .token("x"))
    }
}
