import Foundation

/// A generative-UI surface the Mac's Oni drew (A2UI v0.9 Basic Catalog, plus
/// the local `Badge`). PLAN.md Phase 31 D5.
///
/// The server validates every surface before sending it (`assistant/a2ui.py`).
/// The phone validates again, with the same rules, because this is the one
/// place a button can start a turn: a surface that does not pass is never
/// drawn. The rule that matters most is the `Button` lock: an action is
/// exactly `{"name": <non-empty string>}`, with no function call and no
/// nested payload, so a button can only ever report "this was pressed".
public struct A2UISurface: Sendable, Equatable {
    public let surfaceId: String
    /// In the order the server sent them.
    public let components: [A2UIComponent]
    /// Values that `{"path": ...}` bindings resolve against.
    public let dataModel: [String: JSONValue]

    public func component(_ id: String) -> A2UIComponent? { byId[id] }
    public var root: A2UIComponent { byId["root"]! }

    private let byId: [String: A2UIComponent]

    public static let maxComponents = 80
    /// Real images are embedded as base64, so this is large; it is still a ceiling.
    public static let maxEncodedBytes = 6_000_000

    /// Parses and validates. Throws `A2UIError` naming the first violation.
    public static func parse(_ json: JSONValue) throws -> A2UISurface {
        guard case .object(let object) = json else { throw A2UIError("surface must be a JSON object") }
        if let size = try? json.encoded().count, size > maxEncodedBytes {
            throw A2UIError("surface exceeds the \(maxEncodedBytes)-byte limit")
        }
        guard let surfaceId = object["surfaceId"]?.string, !surfaceId.isEmpty else {
            throw A2UIError("surface.surfaceId must be a non-empty string")
        }
        guard case .array(let list)? = object["components"], !list.isEmpty else {
            throw A2UIError("surface.components must be a non-empty list")
        }
        guard list.count <= maxComponents else {
            throw A2UIError("surface.components exceeds the \(maxComponents)-component limit")
        }

        var dataModel: [String: JSONValue] = [:]
        if let model = object["dataModel"] {
            guard case .object(let entries) = model else { throw A2UIError("surface.dataModel must be a JSON object if present") }
            for (key, value) in entries {
                guard !key.isEmpty else { throw A2UIError("surface.dataModel keys must be non-empty strings") }
                let valid: Bool
                switch value {
                case .string, .bool, .number: valid = true
                case .array(let items): valid = items.allSatisfy { $0.string != nil }
                default: valid = false
                }
                guard valid else { throw A2UIError("surface.dataModel[\(key)] must be a string, boolean, number, or list of strings") }
            }
            dataModel = entries
        }

        var ordered: [A2UIComponent] = []
        var byId: [String: A2UIComponent] = [:]
        for item in list {
            guard case .object(let fields) = item else { throw A2UIError("each component must be a JSON object") }
            guard let id = fields["id"]?.string, !id.isEmpty else { throw A2UIError("every component needs a non-empty string 'id'") }
            guard byId[id] == nil else { throw A2UIError("duplicate component id: \(id)") }
            guard let type = fields["component"]?.string, schemas[type] != nil else {
                throw A2UIError("unsupported component type \(fields["component"]?.string ?? "?") on \(id)")
            }
            let component = A2UIComponent(id: id, type: type, fields: fields)
            ordered.append(component)
            byId[id] = component
        }
        guard byId["root"] != nil else { throw A2UIError("surface.components must include a component with id 'root'") }

        for component in ordered {
            let schema = schemas[component.type]!
            let allowed = schema.required.union(schema.optional).union(["id", "component", "weight"])
            let unknown = Set(component.fields.keys).subtracting(allowed)
            guard unknown.isEmpty else {
                throw A2UIError("component \(component.id) (\(component.type)) has unsupported field(s): \(unknown.sorted())")
            }
            let missing = schema.required.subtracting(component.fields.keys)
            guard missing.isEmpty else {
                throw A2UIError("component \(component.id) (\(component.type)) is missing required field(s): \(missing.sorted())")
            }
            try validate(component, in: byId)
        }
        try checkAcyclic(byId)

        return A2UISurface(surfaceId: surfaceId, components: ordered, dataModel: dataModel, byId: byId)
    }

    // MARK: per-type rules (mirror assistant/a2ui.py `_validate_component_fields`)

    struct Schema { var required: Set<String>; var optional: Set<String> }

    static let schemas: [String: Schema] = [
        "Text": Schema(required: ["text"], optional: ["variant"]),
        "Image": Schema(required: ["url"], optional: ["description", "fit", "variant"]),
        "Icon": Schema(required: ["name"], optional: []),
        "Video": Schema(required: ["url"], optional: []),
        "AudioPlayer": Schema(required: ["url"], optional: ["description"]),
        "Row": Schema(required: ["children"], optional: ["justify", "align"]),
        "Column": Schema(required: ["children"], optional: ["justify", "align"]),
        "List": Schema(required: ["children"], optional: ["direction", "align"]),
        "Card": Schema(required: ["child"], optional: []),
        "Tabs": Schema(required: ["tabs"], optional: []),
        "Modal": Schema(required: ["trigger", "content"], optional: []),
        "Divider": Schema(required: [], optional: ["axis"]),
        "Button": Schema(required: ["child", "action"], optional: ["variant", "checked"]),
        "TextField": Schema(required: ["label"], optional: ["value", "variant", "validationRegexp", "checked"]),
        "CheckBox": Schema(required: ["label", "value"], optional: ["checked"]),
        "ChoicePicker": Schema(required: ["options", "value"], optional: ["label", "variant", "displayStyle", "filterable", "checked"]),
        "Slider": Schema(required: ["value", "max"], optional: ["label", "min", "checked"]),
        "DateTimeInput": Schema(required: ["value"], optional: ["enableDate", "enableTime", "min", "max", "label", "checked"]),
        "Badge": Schema(required: ["text"], optional: []),
    ]

    static let iconNames: Set<String> = [
        "accountCircle", "add", "arrowBack", "arrowForward", "attachFile", "calendarToday", "call", "camera",
        "check", "close", "delete", "download", "edit", "event", "error", "fastForward", "favorite", "favoriteOff",
        "folder", "help", "home", "info", "locationOn", "lock", "lockOpen", "mail", "menu", "moreVert", "moreHoriz",
        "notificationsOff", "notifications", "pause", "payment", "person", "phone", "photo", "play", "print",
        "refresh", "rewind", "search", "send", "settings", "share", "shoppingCart", "skipNext", "skipPrevious",
        "star", "starHalf", "starOff", "stop", "upload", "visibility", "visibilityOff", "volumeDown", "volumeMute",
        "volumeOff", "volumeUp", "warning",
    ]

    private static let textVariants: Set<String> = ["h1", "h2", "h3", "h4", "h5", "caption", "body"]
    private static let imageFits: Set<String> = ["contain", "cover", "fill", "none", "scaleDown"]
    private static let imageVariants: Set<String> = ["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"]
    private static let justify: Set<String> = ["center", "end", "spaceAround", "spaceBetween", "spaceEvenly", "start", "stretch"]
    private static let align: Set<String> = ["start", "center", "end", "stretch"]
    private static let directions: Set<String> = ["vertical", "horizontal"]
    private static let buttonVariants: Set<String> = ["default", "primary", "borderless"]
    private static let textFieldVariants: Set<String> = ["longText", "number", "shortText", "obscured"]
    private static let pickerVariants: Set<String> = ["multipleSelection", "mutuallyExclusive"]
    private static let pickerStyles: Set<String> = ["checkbox", "chips"]

    private static func validate(_ c: A2UIComponent, in byId: [String: A2UIComponent]) throws {
        let f = c.fields
        func fail(_ message: String) -> A2UIError { A2UIError("component \(c.id).\(message)") }
        func enumeration(_ field: String, _ allowed: Set<String>) throws {
            if let v = f[field], !(v.string.map(allowed.contains) ?? false) { throw fail("\(field) must be one of \(allowed.sorted())") }
        }
        func knownId(_ value: JSONValue?, _ field: String) throws {
            guard let id = value?.string, byId[id] != nil else { throw fail("\(field) must reference a known component id") }
        }
        func dynamicString(_ field: String) throws {
            if let v = f[field], !v.isDynamicString { throw fail("\(field) must be a string or {'path': str}") }
        }

        if let w = f["weight"], w.double == nil { throw fail("weight must be a number") }
        if let v = f["checked"], !v.isDynamicBoolean { throw fail("checked must be a boolean or {'path': str}") }

        switch c.type {
        case "Text", "Badge":
            guard f["text"]?.isDynamicString == true else { throw fail("text must be a string or {'path': str}") }
            if c.type == "Text" { try enumeration("variant", textVariants) }
        case "Image":
            try dataURI(f["url"], c)
            try dynamicString("description")
            try enumeration("fit", imageFits)
            try enumeration("variant", imageVariants)
        case "Icon":
            let name = f["name"]
            if let s = name?.string {
                guard iconNames.contains(s) else { throw fail("name '\(s)' is not a known icon name") }
            } else if name?.isPathBinding != true {
                throw fail("name must be a known icon name or {'path': str}")
            }
        case "Video", "AudioPlayer":
            try dataURI(f["url"], c)
            if c.type == "AudioPlayer" { try dynamicString("description") }
        case "Column", "Row", "List":
            guard case .array(let children)? = f["children"], !children.isEmpty, children.allSatisfy({ $0.string != nil }) else {
                throw fail("children must be a non-empty list of component ids")
            }
            for child in children where byId[child.string!] == nil { throw fail("references unknown child id \(child.string!)") }
            try enumeration(c.type == "List" ? "direction" : "justify", c.type == "List" ? directions : justify)
            try enumeration("align", align)
        case "Card":
            try knownId(f["child"], "child")
        case "Tabs":
            guard case .array(let tabs)? = f["tabs"], !tabs.isEmpty else { throw fail("tabs must be a non-empty list") }
            for (i, tab) in tabs.enumerated() {
                guard case .object(let t) = tab, Set(t.keys) == ["title", "child"] else { throw fail("tabs[\(i)] must be exactly {'title', 'child'}") }
                guard t["title"]?.isDynamicString == true else { throw fail("tabs[\(i)].title must be a string or {'path': str}") }
                try knownId(t["child"], "tabs[\(i)].child")
            }
        case "Modal":
            try knownId(f["trigger"], "trigger")
            try knownId(f["content"], "content")
        case "Divider":
            try enumeration("axis", ["horizontal", "vertical"])
        case "Button":
            try knownId(f["child"], "child")
            try enumeration("variant", buttonVariants)
            // The security boundary for interactive surfaces: exactly {"name": <non-empty string>}.
            guard case .object(let action)? = f["action"], Set(action.keys) == ["name"],
                  let name = action["name"]?.string, !name.isEmpty
            else { throw fail("action must be exactly {'name': <non-empty string>}: no other keys are permitted") }
        case "TextField":
            guard f["label"]?.isDynamicString == true else { throw fail("label must be a string or {'path': str}") }
            try dynamicString("value")
            try enumeration("variant", textFieldVariants)
            if let v = f["validationRegexp"], v.string == nil { throw fail("validationRegexp must be a string") }
        case "CheckBox":
            guard f["label"]?.isDynamicString == true else { throw fail("label must be a string or {'path': str}") }
            guard f["value"]?.isDynamicBoolean == true else { throw fail("value must be a boolean or {'path': str}") }
        case "ChoicePicker":
            try dynamicString("label")
            guard case .array(let options)? = f["options"], !options.isEmpty else { throw fail("options must be a non-empty list") }
            for (i, option) in options.enumerated() {
                guard case .object(let o) = option, Set(o.keys) == ["label", "value"] else { throw fail("options[\(i)] must be exactly {'label', 'value'}") }
                guard o["label"]?.isDynamicString == true else { throw fail("options[\(i)].label must be a string or {'path': str}") }
                guard let value = o["value"]?.string, !value.isEmpty else { throw fail("options[\(i)].value must be a non-empty string") }
            }
            guard f["value"]?.isDynamicStringList == true else { throw fail("value must be a list of strings or {'path': str}") }
            try enumeration("variant", pickerVariants)
            try enumeration("displayStyle", pickerStyles)
            if let v = f["filterable"], v.bool == nil { throw fail("filterable must be a boolean") }
        case "Slider":
            guard f["value"]?.isDynamicNumber == true else { throw fail("value must be a number or {'path': str}") }
            guard f["max"]?.double != nil else { throw fail("max must be a number") }
            if let v = f["min"], v.double == nil { throw fail("min must be a number") }
            try dynamicString("label")
        case "DateTimeInput":
            guard f["value"]?.isDynamicString == true else { throw fail("value must be a string or {'path': str}") }
            for field in ["enableDate", "enableTime"] { if let v = f[field], v.bool == nil { throw fail("\(field) must be a boolean") } }
            for field in ["min", "max", "label"] { try dynamicString(field) }
        default:
            break
        }
    }

    /// Image/Video/Audio sources are base64 `data:` URIs only: no remote URL is
    /// ever fetched by the phone on a surface's say-so.
    private static func dataURI(_ value: JSONValue?, _ c: A2UIComponent) throws {
        guard let value, value.isDynamicString else { throw A2UIError("component \(c.id).url must be a string or {'path': str}") }
        if let url = value.string {
            guard url.hasPrefix("data:"), let comma = url.firstIndex(of: ","), url[..<comma].hasSuffix(";base64") else {
                throw A2UIError("component \(c.id): \(c.type).url must be a base64 data: URI (no remote URLs)")
            }
        }
    }

    /// A tree is a DAG: the same leaf may sit under two parents. Only a path
    /// back to an ancestor still being walked is a cycle.
    private static func checkAcyclic(_ byId: [String: A2UIComponent]) throws {
        var visiting: Set<String> = []
        var visited: Set<String> = []
        func walk(_ id: String) throws {
            if visited.contains(id) { return }
            if visiting.contains(id) { throw A2UIError("surface.components contains a cycle reachable from \(id)") }
            visiting.insert(id)
            for child in byId[id]!.childIds where byId[child] != nil { try walk(child) }
            visiting.remove(id)
            visited.insert(id)
        }
        try walk("root")
    }
}

public struct A2UIComponent: Sendable, Equatable {
    public let id: String
    public let type: String
    /// Every field as sent, `id` and `component` included.
    public let fields: [String: JSONValue]

    /// The ids of the components this one draws inside itself.
    public var childIds: [String] {
        switch type {
        case "Row", "Column", "List": return fields["children"]?.array?.compactMap(\.string) ?? []
        case "Card", "Button": return fields["child"]?.string.map { [$0] } ?? []
        case "Tabs": return fields["tabs"]?.array?.compactMap { $0["child"]?.string } ?? []
        case "Modal": return ["trigger", "content"].compactMap { fields[$0]?.string }
        default: return []
        }
    }

    /// For `Button`: the one thing it may report.
    public var actionName: String? { fields["action"]?["name"]?.string }
}

public struct A2UIError: Error, Equatable, CustomStringConvertible {
    public let description: String
    init(_ description: String) { self.description = description }
}

extension A2UISurface {
    /// `{"path": ...}`-aware lookups against the data model.
    public func string(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        if let s = value.string { return s }
        if let path = value.pathBinding { return dataModel[path]?.string }
        return nil
    }
}

extension JSONValue {
    var pathBinding: String? {
        guard case .object(let o) = self, Set(o.keys) == ["path"] else { return nil }
        return o["path"]?.string
    }
    var isPathBinding: Bool { pathBinding != nil }
    var isDynamicString: Bool { string != nil || isPathBinding }
    var isDynamicNumber: Bool { double != nil || isPathBinding }
    var isDynamicBoolean: Bool { bool != nil || isPathBinding }
    var isDynamicStringList: Bool {
        if case .array(let items) = self { return items.allSatisfy { $0.string != nil } }
        return isPathBinding
    }
}
