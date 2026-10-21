import Foundation
import Testing
@testable import OniCore

/// What a surface's inputs read, write and report back.
@Suite struct A2UIFormStateTests {
    private func state(_ model: [String: JSONValue] = [:]) throws -> A2UIFormState {
        var object: [String: JSONValue] = ["surfaceId": "s", "components": [["id": "root", "component": "Text", "text": "x"]]]
        if !model.isEmpty { object["dataModel"] = .object(model) }
        return A2UIFormState(try A2UISurface.parse(.object(object)))
    }

    private let bind: (String) -> JSONValue = { ["path": .string($0)] }

    @Test func literalsReadAsThemselvesAndBindingsReadTheDataModel() throws {
        let s = try state(["/name": "Ada", "/n": 3, "/f": .number(2.5), "/ok": true])
        #expect(s.string("hi") == "hi")
        #expect(s.string(bind("/name")) == "Ada")
        #expect(s.string(bind("/n")) == "3")
        #expect(s.string(bind("/f")) == "2.5")
        #expect(s.string(bind("/ok")) == "true")
    }

    @Test func aMissingOrWronglyTypedBindingReadsAsEmptyNotAJsonDump() throws {
        let s = try state(["/list": ["a", "b"]])
        #expect(s.string(bind("/nothing")) == "")
        #expect(s.string(bind("/list")) == "")
        #expect(s.string(nil) == "")
        #expect(s.string(["not": "a binding"]) == "")
    }

    @Test func numbersBooleansAndListsReadTheSameWay() throws {
        let s = try state(["/v": 7, "/c": true, "/pick": ["x", "y"], "/oops": "str"])
        #expect(s.number(bind("/v")) == 7)
        #expect(s.number(5) == 5)
        #expect(s.number(bind("/oops"), fallback: 1) == 1)
        #expect(s.bool(bind("/c")) && s.bool(true) && !s.bool(bind("/oops")) && !s.bool(false))
        #expect(s.stringList(bind("/pick")) == ["x", "y"])
        #expect(s.stringList(["a", "b"]) == ["a", "b"])
        #expect(s.stringList(bind("/oops")) == [])
    }

    @Test func aLiteralInputIsReadOnlyAndABoundOneIsWritable() throws {
        var s = try state(["/name": "Ada"])
        #expect(s.path("literal") == nil && s.path(bind("/name")) == "/name")
        s.set(s.path("literal"), string: "ignored")
        #expect(s.data == ["/name": "Ada"])
        s.set(s.path(bind("/name")), string: "Grace")
        #expect(s.string(bind("/name")) == "Grace")
    }

    @Test func choicesToggleWhenMultipleAndReplaceWhenExclusive() throws {
        var multi = try state(["/p": ["a"]])
        multi.choose("/p", value: "b", multiple: true)
        #expect(multi.stringList(bind("/p")) == ["a", "b"])
        multi.choose("/p", value: "a", multiple: true)
        #expect(multi.stringList(bind("/p")) == ["b"])

        var single = try state(["/p": ["a"]])
        single.choose("/p", value: "b", multiple: false)
        single.choose("/p", value: "b", multiple: false)      // no deselect, like the dashboard
        #expect(single.stringList(bind("/p")) == ["b"])

        var unbound = try state()
        unbound.choose(nil, value: "x", multiple: true)
        #expect(unbound.data.isEmpty)
    }

    @Test func aPressedButtonReportsTheWholeModelIncludingEdits() throws {
        var s = try state(["/name": "", "/agree": false, "/stars": 3])
        s.set("/name", string: "Ada")
        s.set("/agree", bool: true)
        s.set("/stars", number: 5)
        #expect(s.context == ["/name": "Ada", "/agree": true, "/stars": 5])
    }

    @Test func iconNamesAreOnlyTheFixedSet() throws {
        let s = try state(["/i": "mail", "/bad": "../../etc/passwd"])
        #expect(s.iconName("home") == "home")
        #expect(s.iconName(bind("/i")) == "mail")
        #expect(s.iconName(bind("/bad")) == nil)
        #expect(s.iconName("nonsense") == nil)
    }
}

@Suite struct A2UIMediaTests {
    @Test func decodesABase64DataURI() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        let decoded = try #require(A2UIMedia.decode("data:image/png;base64,\(png)"))
        #expect(decoded.mimeType == "image/png" && decoded.data == Data([0x89, 0x50, 0x4E, 0x47]))
    }

    @Test func refusesAnythingThatIsNotAnInlineBase64Image() {
        #expect(A2UIMedia.decode("https://example.com/a.png") == nil)
        #expect(A2UIMedia.decode("file:///etc/passwd") == nil)
        #expect(A2UIMedia.decode("data:image/png,rawtext") == nil)           // not base64
        #expect(A2UIMedia.decode("data:;base64,AAAA") == nil)                // no media type
        #expect(A2UIMedia.decode("data:image/png;base64,") == nil)           // empty
        #expect(A2UIMedia.decode("data:image/png;base64,!!!notbase64!!!") == nil)
    }
}

@Suite struct A2UIDateTimeTests {
    @Test func readsBrowserStyleAndIsoStrings() throws {
        let local = try #require(A2UIDateTime.parse("2026-10-21T14:30"))
        #expect(A2UIDateTime.format(local, parts: .init(date: true, time: true)) == "2026-10-21T14:30")
        #expect(A2UIDateTime.format(local, parts: .init(date: true, time: false)) == "2026-10-21")
        #expect(A2UIDateTime.format(local, parts: .init(date: false, time: true)) == "14:30")

        let utc = try #require(A2UIDateTime.parse("2026-10-21T06:00:00+00:00"))
        #expect(utc == A2UIDateTime.parse("2026-10-21T06:00:00Z"))
        #expect(A2UIDateTime.parse("2026-10-21") != nil)
        #expect(A2UIDateTime.parse("09:15") != nil)
    }

    @Test func garbageIsNilNotNow() {
        #expect(A2UIDateTime.parse("") == nil)
        #expect(A2UIDateTime.parse("next tuesday") == nil)
    }

    @Test func theFieldsPickersFollowEnableDateAndEnableTime() {
        #expect(A2UIDateTime.parts(enableDate: true, enableTime: true) == .init(date: true, time: true))
        #expect(A2UIDateTime.parts(enableDate: false, enableTime: true) == .init(date: false, time: true))
        #expect(A2UIDateTime.parts(enableDate: true, enableTime: false) == .init(date: true, time: false))
        #expect(A2UIDateTime.parts(enableDate: false, enableTime: false) == .init(date: true, time: false))
    }
}

/// The renderer is the one place model-written UI meets the screen, so it must
/// stay incapable of fetching or running anything on a surface's say-so.
@Suite struct A2UIViewsSourceTests {
    private static let source: String = {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Oni/Views/A2UIViews.swift")
        return try! String(contentsOf: url, encoding: .utf8)
    }()

    @Test(arguments: ["AsyncImage", "URLSession", "URL(string", "WKWebView", "WebView", "openURL", "UIApplication", "Link("])
    func theRendererCannotFetchOrNavigate(_ forbidden: String) {
        #expect(!Self.source.contains(forbidden), "A2UIViews.swift uses \(forbidden)")
    }

    @Test func aButtonCanOnlyReportItsActionNameAndTheForm() {
        // The single place a press leaves the view.
        #expect(Self.source.components(separatedBy: "ctx.press(").count - 1 == 1)
        #expect(Self.source.contains("c.actionName"))
    }
}
