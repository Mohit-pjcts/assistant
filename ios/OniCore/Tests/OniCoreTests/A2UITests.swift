import Foundation
import Testing
@testable import OniCore

/// The phone re-checks every generative-UI surface with the server's rules
/// (assistant/a2ui.py `validate_surface`). The rule that matters most: a
/// button's action is exactly `{"name": ...}`.
@Suite struct A2UITests {
    private func surface(_ components: [JSONValue], dataModel: JSONValue? = nil) -> JSONValue {
        var object: [String: JSONValue] = ["surfaceId": "s1", "components": .array(components)]
        if let dataModel { object["dataModel"] = dataModel }
        return .object(object)
    }

    private func rejected(_ json: JSONValue, containing fragment: String? = nil, sourceLocation: SourceLocation = #_sourceLocation) {
        do {
            _ = try A2UISurface.parse(json)
            Issue.record("expected the surface to be rejected", sourceLocation: sourceLocation)
        } catch let error as A2UIError {
            if let fragment { #expect(error.description.contains(fragment), "\(error)", sourceLocation: sourceLocation) }
        } catch {
            Issue.record("wrong error \(error)", sourceLocation: sourceLocation)
        }
    }

    private var card: JSONValue {
        surface([
        ["id": "root", "component": "Card", "child": "col"],
        ["id": "col", "component": "Column", "children": ["title", "go"]],
        ["id": "title", "component": "Text", "text": "Hello", "variant": "h2"],
        ["id": "label", "component": "Text", "text": "Go"],
        ["id": "go", "component": "Button", "child": "label", "action": ["name": "go"], "variant": "primary"],
        ])
    }


    @Test func aValidSurfaceParsesAndKeepsItsStructure() throws {
        let s = try A2UISurface.parse(card)
        #expect(s.surfaceId == "s1" && s.components.count == 5)
        #expect(s.root.type == "Card" && s.root.childIds == ["col"])
        #expect(s.component("go")?.actionName == "go")
        #expect(s.component("col")?.childIds == ["title", "go"])
    }

    // MARK: the button lock

    @Test func aButtonActionCarriesExactlyAName() {
        func button(_ action: JSONValue) -> JSONValue {
            surface([["id": "root", "component": "Button", "child": "t", "action": action],
                     ["id": "t", "component": "Text", "text": "x"]])
        }
        rejected(button(["name": "go", "functionCall": ["call": "rm", "args": []]]), containing: "action")
        rejected(button(["name": "go", "context": ["a": 1]]), containing: "action")
        rejected(button(["functionCall": ["call": "openUrl"]]), containing: "action")
        rejected(button(["name": ""]), containing: "action")
        rejected(button(["name": 5]), containing: "action")
        rejected(button("go"), containing: "action")
        rejected(button([:]), containing: "action")
        #expect((try? A2UISurface.parse(button(["name": "go"]))) != nil)
    }

    // MARK: structure

    @Test func theSurfaceNeedsARootAndUniqueIds() {
        rejected(surface([["id": "a", "component": "Text", "text": "x"]]), containing: "'root'")
        rejected(surface([["id": "root", "component": "Text", "text": "x"], ["id": "root", "component": "Text", "text": "y"]]), containing: "duplicate")
        rejected(surface([]), containing: "non-empty")
        rejected(["surfaceId": "", "components": [["id": "root", "component": "Text", "text": "x"]]], containing: "surfaceId")
        rejected("nope")
    }

    @Test func aChildThatDoesNotExistIsRejected() {
        rejected(surface([["id": "root", "component": "Column", "children": ["ghost"]]]), containing: "unknown child")
        rejected(surface([["id": "root", "component": "Card", "child": "ghost"]]), containing: "child")
    }

    @Test func aCycleIsRejectedButASharedLeafIsFine() throws {
        rejected(surface([["id": "root", "component": "Column", "children": ["a"]],
                          ["id": "a", "component": "Column", "children": ["root"]]]), containing: "cycle")
        let shared = surface([["id": "root", "component": "Row", "children": ["c1", "c2"]],
                              ["id": "c1", "component": "Card", "child": "leaf"],
                              ["id": "c2", "component": "Card", "child": "leaf"],
                              ["id": "leaf", "component": "Text", "text": "x"]])
        #expect((try? A2UISurface.parse(shared)) != nil)
    }

    @Test func unknownTypesAndFieldsAreRejected() {
        rejected(surface([["id": "root", "component": "Script", "text": "x"]]), containing: "unsupported component type")
        rejected(surface([["id": "root", "component": "Text", "text": "x", "onClick": "alert(1)"]]), containing: "unsupported field")
        rejected(surface([["id": "root", "component": "Text"]]), containing: "missing required")
        rejected(surface([["id": "root", "component": "Text", "text": "x", "variant": "huge"]]), containing: "variant")
    }

    @Test func tooManyComponentsAreRejected() {
        var components: [JSONValue] = [["id": "root", "component": "Column", "children": .array((0..<80).map { JSONValue.string("t\($0)") })]]
        for i in 0..<81 { components.append(["id": .string("t\(i)"), "component": "Text", "text": "x"]) }
        rejected(surface(components), containing: "limit")
    }

    // MARK: media

    @Test func anImageMustBeABase64DataURINeverARemoteURL() {
        func image(_ url: JSONValue) -> JSONValue { surface([["id": "root", "component": "Image", "url": url]]) }
        rejected(image("https://example.com/x.png"), containing: "base64")
        rejected(image("http://169.254.169.254/latest/meta-data"), containing: "base64")
        rejected(image("data:image/svg+xml;utf8,<svg/>"), containing: "base64")
        rejected(image("file:///etc/passwd"), containing: "base64")
        #expect((try? A2UISurface.parse(image("data:image/png;base64,iVBORw0KGgo="))) != nil)
        #expect((try? A2UISurface.parse(image(["path": "photo"]))) != nil)
    }

    @Test func videoAndAudioAreHeldToTheSameRule() {
        rejected(surface([["id": "root", "component": "Video", "url": "https://example.com/v.mp4"]]), containing: "base64")
        rejected(surface([["id": "root", "component": "AudioPlayer", "url": "https://example.com/a.mp3"]]), containing: "base64")
        #expect((try? A2UISurface.parse(surface([["id": "root", "component": "Video", "url": "data:video/mp4;base64,AAAA"]]))) != nil)
    }

    @Test func anIconMustBeAKnownName() {
        rejected(surface([["id": "root", "component": "Icon", "name": "nuclear"]]), containing: "icon")
        #expect((try? A2UISurface.parse(surface([["id": "root", "component": "Icon", "name": "mail"]]))) != nil)
    }

    // MARK: every type in the catalog parses

    @Test func everyComponentTypeInTheCatalogHasAValidExample() throws {
        let examples: [(String, JSONValue)] = [
            ("Text", ["id": "root", "component": "Text", "text": "x", "variant": "caption"]),
            ("Badge", ["id": "root", "component": "Badge", "text": "x"]),
            ("Divider", ["id": "root", "component": "Divider", "axis": "vertical"]),
            ("Icon", ["id": "root", "component": "Icon", "name": ["path": "icon"]]),
            ("TextField", ["id": "root", "component": "TextField", "label": "Name", "value": ["path": "name"], "variant": "shortText"]),
            ("CheckBox", ["id": "root", "component": "CheckBox", "label": "Ok", "value": true]),
            ("ChoicePicker", ["id": "root", "component": "ChoicePicker", "options": [["label": "A", "value": "a"]], "value": ["a"], "variant": "mutuallyExclusive"]),
            ("Slider", ["id": "root", "component": "Slider", "value": 3, "max": 10, "min": 0]),
            ("DateTimeInput", ["id": "root", "component": "DateTimeInput", "value": "2026-10-21", "enableDate": true]),
            ("AudioPlayer", ["id": "root", "component": "AudioPlayer", "url": "data:audio/mp3;base64,AAAA", "description": "clip"]),
        ]
        for (type, component) in examples {
            let s = try A2UISurface.parse(surface([component]))
            #expect(s.root.type == type)
        }
        let containers = surface([
            ["id": "root", "component": "Tabs", "tabs": [["title": "One", "child": "t"]]],
            ["id": "t", "component": "List", "children": ["m"], "direction": "horizontal"],
            ["id": "m", "component": "Modal", "trigger": "x", "content": "y"],
            ["id": "x", "component": "Text", "text": "open"],
            ["id": "y", "component": "Text", "text": "body"],
        ])
        #expect(try A2UISurface.parse(containers).components.count == 5)
    }

    @Test func fieldTypesAreChecked() {
        rejected(surface([["id": "root", "component": "Slider", "value": "high", "max": 10]]), containing: "value")
        rejected(surface([["id": "root", "component": "CheckBox", "label": "x", "value": "yes"]]), containing: "value")
        rejected(surface([["id": "root", "component": "ChoicePicker", "options": [["label": "A"]], "value": []]]), containing: "options")
        rejected(surface([["id": "root", "component": "ChoicePicker", "options": [["label": "A", "value": ""]], "value": []]]), containing: "value")
        rejected(surface([["id": "root", "component": "Text", "text": "x", "weight": "heavy"]]), containing: "weight")
        rejected(surface([["id": "root", "component": "Text", "text": ["path": "a", "extra": "b"]]]), containing: "text")
    }

    // MARK: data model

    @Test func aPathBindingResolvesAgainstTheDataModel() throws {
        let s = try A2UISurface.parse(surface(
            [["id": "root", "component": "Text", "text": ["path": "who"]]],
            dataModel: ["who": "Sam", "n": 3, "on": true, "tags": ["a", "b"]]))
        #expect(s.string(s.root.fields["text"]) == "Sam")
        #expect(s.string("literal") == "literal")
        #expect(s.string(["path": "missing"]) == nil)
    }

    @Test func aMalformedDataModelIsRejected() {
        rejected(surface([["id": "root", "component": "Text", "text": "x"]], dataModel: ["k": ["nested": 1]]), containing: "dataModel")
        rejected(surface([["id": "root", "component": "Text", "text": "x"]], dataModel: ["k": [1, 2]]), containing: "dataModel")
        rejected(surface([["id": "root", "component": "Text", "text": "x"]], dataModel: "x"), containing: "dataModel")
    }
}
