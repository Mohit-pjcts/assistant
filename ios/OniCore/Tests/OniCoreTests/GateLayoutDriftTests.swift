import Foundation
import Testing
@testable import OniCore

/// Guards against a gated tool gaining a payload field the phone's card has no
/// slot for. `Fixtures/gate_payload_keys.json` is generated from the Python
/// code (`scripts/extract_gate_keys.py`), so it lists the keys each action
/// REALLY sends. For every one, the card must either have a slot for it or
/// list it under "Other details" under its own name; either way it is shown.
/// What this catches is a key going to "Other details" in normal use, which
/// means the layout needs a slot (the card still shows it, just unpolished).
@Suite struct GateLayoutDriftTests {
    private static let keys: [String: [String]] = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/gate_payload_keys.json")
        let data = try! Data(contentsOf: url)
        return try! JSONDecoder().decode([String: [String]].self, from: data)
    }()

    /// Keys the card deliberately does not show: the voice flags are for the
    /// phone/hotkey channels, and the spoken prompt is derived from the fields.
    private static let notShown: Set<String> = ["action", "voice_approvable", "spoken_prompt"]

    private func labels(_ rows: [GateRow]) -> Set<String> {
        Set(rows.compactMap { row in
            switch row {
            case .field(let label, _): label
            case .block(_, let label, _): label
            default: nil
            }
        })
    }

    @Test func everyKeyTheServerSendsHasASlotInItsActionsCard() throws {
        let variants: [JSONValue] = ["v", ["v"], ["k": "v"], true]
        var missing: [String] = []
        for (action, keys) in Self.keys where action != "<dynamic action>" {
            var claimed = Self.notShown
            for variant in variants {
                var object: [String: JSONValue] = ["action": .string(action)]
                for key in keys where key != "action" { object[key] = variant }
                let gate = try #require(Gate.parse(.object(object)), "\(action) did not parse")
                #expect(gate.isRecognised, "\(action) has no layout")
                let unclaimed = labels(gate.otherDetails)
                claimed.formUnion(Set(keys).subtracting(unclaimed))
            }
            for key in keys where !claimed.contains(key) { missing.append("\(action).\(key)") }
        }
        #expect(missing.isEmpty, "keys with no slot in their card (shown only under Other details): \(missing.sorted())")
    }

    @Test func theUpfrontConfirmationHasNothingLeftOver() throws {
        let keys = try #require(Self.keys["<dynamic action>"])
        var object: [String: JSONValue] = ["action": "send_email"]
        for key in keys where key != "action" { object[key] = key == "voice_approvable" ? false : "a summary" }
        let gate = try #require(Gate.parse(.object(object)))
        #expect(gate.otherDetails.isEmpty)
    }

    @Test func theFixtureCoversEveryActionTheAppHasALayoutFor() {
        #expect(Set(Gate.layouts.keys).subtracting(Self.keys.keys).isEmpty,
                "layouts for actions the server no longer sends: \(Set(Gate.layouts.keys).subtracting(Self.keys.keys).sorted())")
        #expect(Set(Self.keys.keys).subtracting(Gate.layouts.keys).subtracting(["<dynamic action>"]).isEmpty)
    }
}

/// The row model is tested to carry every field whole; this guards the one
/// step after it, the SwiftUI view, which cannot be unit-tested here. Nothing
/// that shortens, scales or hides text may appear in the card's source: a
/// message body clipped to "…" is exactly the hidden-content bug the card
/// exists to prevent (PLAN.md Phase 31 D3).
@Suite struct GateCardViewSourceTests {
    private static let source: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Oni/Views/GateCardView.swift")
        return try! String(contentsOf: url, encoding: .utf8)
    }()

    @Test(arguments: [
        "lineLimit", "minimumScaleFactor", "truncationMode", ".prefix(", ".suffix(", "allowsTightening",
        "ScrollView(.horizontal", ".hidden()", ".opacity(0)", ".frame(height", ".frame(maxHeight", "lineSpacing(-",
    ])
    func theCardNeverShortensOrHidesText(_ forbidden: String) {
        #expect(!Self.source.contains(forbidden), "GateCardView.swift uses \(forbidden)")
    }

    @Test func everyRowKindIsDrawnWithItsTextWhole() {
        // Each row kind must wrap, not clip.
        #expect(Self.source.components(separatedBy: "fixedSize(horizontal: false, vertical: true)").count - 1 >= 4)
        #expect(Self.source.contains("textSelection(.enabled)"))
    }

    @Test func declineComesBeforeApprove() throws {
        let decline = try #require(Self.source.range(of: "gate-decline"))
        let approve = try #require(Self.source.range(of: "gate-approve"))
        #expect(decline.lowerBound < approve.lowerBound)
    }
}
