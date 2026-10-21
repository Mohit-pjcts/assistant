import Foundation

/// One line of a confirmation card. The card is built from these and nothing
/// else, so what the person is asked to approve is exactly what is in here.
public enum GateRow: Sendable, Equatable {
    /// A short labelled value.
    case field(label: String, value: String)
    /// Free text shown whole and monospaced: a message body, a file's
    /// contents, a command. Never shortened, summarised or reflowed.
    case block(id: String, label: String, text: String)
    /// A caption introducing the rows that follow ("Current", "Requested changes").
    case section(String)
    /// Something that must not be missed (a Gmail filter that forwards mail).
    case warning(id: String, text: String)
    /// One step of a multi-step workflow, with its own leftovers.
    case step(index: Int, action: String, specialist: String?, summary: String, extras: [GateRow])
}

/// A pending confirmation, parsed from the `interrupt` frame's payload.
///
/// This is the phone's counterpart of the dashboard's `InterruptGate.tsx`, and
/// carries the same contract (CLAUDE.md, Security model; PLAN.md Phase 31 D3,
/// D4): every field of the real payload is shown as it is, never summarised.
///
/// - A known action gets a layout with a slot per field the server sends.
/// - A field with no slot, or whose type is not the one the slot expects, is
///   never dropped: it is listed under `otherDetails`, in full.
/// - An action with no layout gets the generic layout: every key and value.
/// - A payload that is not a JSON object at all cannot be shown, so `parse`
///   returns nil and the caller declines it.
public struct Gate: Sendable, Equatable {
    public let action: String?
    /// Whether this action has a dedicated layout.
    public let isRecognised: Bool
    /// Fixed text per action, never derived from the payload's own content.
    public let heading: String
    /// Which system the action touches ("Gmail", "Apple Calendar"...).
    public let source: String?
    public let rows: [GateRow]
    /// Everything the layout had no slot for. Empty in normal use.
    public let otherDetails: [GateRow]
    /// The payload exactly as received.
    public let raw: JSONValue

    public static func parse(_ payload: JSONValue) -> Gate? {
        guard case .object(let object) = payload else { return nil }
        var rest = Remaining(object)
        let action = rest.string("action")
        let upfrontSummary = object["summary"]?.string

        // An upfront confirmation carries the supervisor's own summary and
        // none of the action's real fields (the specialist builds those after
        // approval); showing the action's layout would show empty fields.
        // Mirrors InterruptGate.tsx's `isUpfront`.
        if let summary = upfrontSummary, action != "propose_workflow" {
            _ = rest.string("summary")
            rest.discard("voice_approvable")
            var rows: [GateRow] = []
            if let action { rows.append(.field(label: "Action", value: action)) }
            rows.append(.block(id: "upfront-summary", label: "What will happen (the assistant's own description)", text: summary))
            return Gate(
                action: action, isRecognised: true,
                heading: action.flatMap { Self.headings[$0] } ?? "The assistant wants your approval before it acts:",
                source: action.flatMap { Self.sources[$0] },
                rows: rows, otherDetails: rest.leftovers(), raw: payload)
        }

        guard let action, let layout = Self.layouts[action] else {
            // No layout: the generic card shows every key and value, the
            // action name included.
            let rows = object.keys.sorted().map { Remaining.detail(key: $0, value: object[$0]!) }
            let spoken = object["spoken_prompt"]?.string
            return Gate(
                action: action, isRecognised: false,
                heading: spoken ?? "Unrecognised action: \(action ?? "none given")",
                source: nil, rows: rows, otherDetails: [], raw: payload)
        }

        rest.discard("voice_approvable")
        rest.discard("spoken_prompt")  // derived from the fields shown below
        var rows: [GateRow] = []
        layout(&rest, &rows)
        return Gate(
            action: action, isRecognised: true,
            heading: Self.headings[action] ?? "The assistant wants to do this:",
            source: Self.sources[action],
            rows: rows, otherDetails: rest.leftovers(), raw: payload)
    }

    // MARK: Fixed text (never derived from the payload)

    static let headings: [String: String] = [
        "send_email": "The assistant wants to send this email:",
        "modify_gmail_labels": "The assistant wants to change labels on this email:",
        "create_calendar_event": "The assistant wants to create this calendar event:",
        "update_calendar_event": "The assistant wants to update this calendar event:",
        "delete_calendar_event": "The assistant wants to delete this calendar event:",
        "create_gmail_filter": "The assistant wants to create this Gmail filter — a STANDING rule that will keep acting on every future matching email:",
        "delete_gmail_filter": "The assistant wants to delete this Gmail filter:",
        "run_shortcut": "The assistant wants to run this Shortcut:",
        "calendar_create_event": "The assistant wants to create this Apple Calendar event:",
        "calendar_update_event": "The assistant wants to update this Apple Calendar event:",
        "send_imessage": "The assistant wants to send this iMessage:",
        "write_disk_file": "The assistant wants to write this file OUTSIDE the workspace:",
        "delete_disk_file": "The assistant wants to DELETE this file OUTSIDE the workspace:",
        "propose_workflow": "The assistant wants to run this multi-step workflow:",
        "execute_shell_command": "The assistant wants to run this inline interpreter code:",
        "send_test_notification": "The assistant wants to send this notification:",
    ]

    static let sources: [String: String] = [
        "send_email": "Gmail", "modify_gmail_labels": "Gmail",
        "create_calendar_event": "Google Calendar", "update_calendar_event": "Google Calendar",
        "delete_calendar_event": "Google Calendar",
        "create_gmail_filter": "Gmail", "delete_gmail_filter": "Gmail",
        "run_shortcut": "Mac Control",
        "calendar_create_event": "Apple Calendar", "calendar_update_event": "Apple Calendar",
        "send_imessage": "Messages",
        "write_disk_file": "Full-disk access", "delete_disk_file": "Full-disk access",
        "execute_shell_command": "Shell",
    ]

    // MARK: Layouts, one per action the server can gate

    typealias Layout = @Sendable (inout Remaining, inout [GateRow]) -> Void

    static let layouts: [String: Layout] = [
        "send_email": { r, rows in
            rows.append(r.addresses("To", "to"))
            rows.append(r.addresses("Cc", "cc"))
            // Bcc is always shown, even empty: a recipient smuggled into it
            // must never be hidden by the row being absent.
            rows.append(r.addresses("Bcc", "bcc"))
            rows.append(r.field("Subject", "subject"))
            rows.append(r.block("email-body", "Body", "body"))
            r.appendField(&rows, "Format", "body_format")
        },
        "modify_gmail_labels": { r, rows in
            r.appendField(&rows, "Message ID", "message_id")
            if var message = r.object("message") {
                rows.append(.field(label: "From", value: message.string("from") ?? message.string("raw") ?? "(unknown)"))
                rows.append(message.field("Subject", "subject"))
                r.adopt(message.leftovers(prefix: "message."))
            }
            rows.append(r.addresses("Add labels", "add_label_ids"))
            rows.append(r.addresses("Remove labels", "remove_label_ids"))
        },
        "create_calendar_event": { r, rows in
            r.appendField(&rows, "Calendar", "calendar_id")
            googleEvent(&r, &rows, idPrefix: "event")
        },
        "update_calendar_event": { r, rows in
            r.appendField(&rows, "Calendar", "calendar_id")
            r.appendField(&rows, "Event ID", "event_id")
            if var current = r.object("current") {
                rows.append(.section("Current"))
                googleEvent(&current, &rows, idPrefix: "current")
                r.adopt(current.leftovers(prefix: "current."))
            }
            rows.append(.section("Requested changes"))
            rows.append(r.jsonBlock("event-changes", "Changes", "changes"))
        },
        "delete_calendar_event": { r, rows in
            r.appendField(&rows, "Calendar", "calendar_id")
            r.appendField(&rows, "Event ID", "event_id")
            if var event = r.object("event") {
                googleEvent(&event, &rows, idPrefix: "event")
                r.adopt(event.leftovers(prefix: "event."))
            }
        },
        "create_gmail_filter": { r, rows in
            rows.append(r.jsonBlock("filter-criteria", "Matches mail where", "criteria"))
            if var result = r.object("resulting_action") {
                rows.append(result.addresses("Add labels", "add_labels"))
                rows.append(result.addresses("Remove labels", "remove_labels"))
                // The exfiltration field: loud and unconditional when set.
                if let target = result.string("forward_to") {
                    rows.append(.warning(id: "filter-forward", text: "⚠ Forwards matching mail to: \(target)"))
                }
                result.discardNull("forward_to")
                r.adopt(result.leftovers(prefix: "resulting_action."))
            }
        },
        "delete_gmail_filter": { r, rows in
            r.appendField(&rows, "Filter ID", "filter_id")
            rows.append(r.block("filter-verbatim", "Filter", "filter"))
        },
        "run_shortcut": { r, rows in
            rows.append(r.field("Shortcut", "name", fallback: "(unnamed)"))
        },
        "calendar_create_event": { r, rows in
            appleEvent(&r, &rows, idPrefix: "apple-event")
        },
        "calendar_update_event": { r, rows in
            r.appendField(&rows, "Event ID", "event_id")
            if var current = r.object("current") {
                rows.append(.section("Current"))
                appleEvent(&current, &rows, idPrefix: "apple-current")
                r.adopt(current.leftovers(prefix: "current."))
            }
            rows.append(.section("Requested changes"))
            rows.append(r.jsonBlock("apple-event-changes", "Changes", "changes"))
        },
        "send_imessage": { r, rows in
            rows.append(r.field("To", "recipient", fallback: "(unknown)"))
            rows.append(r.block("imessage-body", "Message", "message"))
        },
        "write_disk_file": { r, rows in
            rows.append(r.field("Path", "path", fallback: "(unknown)"))
            let existed = r.bool("existed") ?? false
            rows.append(.field(label: "Already exists", value: existed ? "Yes — will be OVERWRITTEN" : "No — new file"))
            if let previous = r.string("previous_content"), existed {
                rows.append(.block(id: "disk-file-previous", label: "Current content", text: previous))
            }
            r.discardNull("previous_content")
            rows.append(r.block("disk-file-new", "New content", "new_content"))
        },
        "delete_disk_file": { r, rows in
            rows.append(r.field("Path", "path", fallback: "(unknown)"))
            rows.append(r.block("disk-file-delete-content", "Current content", "content"))
        },
        "execute_shell_command": { r, rows in
            rows.append(r.block("shell-command", "Command", "command"))
        },
        "send_test_notification": { r, rows in
            rows.append(r.block("notification-message", "Message", "message"))
        },
        "propose_workflow": { r, rows in
            rows.append(r.field("Goal", "goal", fallback: "(none)"))
            guard let steps = r.array("steps") else { return }
            for (index, value) in steps.enumerated() {
                guard case .object(let object) = value else {
                    rows.append(.step(index: index, action: "(unreadable step)", specialist: nil,
                                      summary: Remaining.text(value), extras: []))
                    continue
                }
                var step = Remaining(object)
                let action = step.string("action") ?? "(unknown action)"
                let specialist = step.string("specialist")
                let summary = step.string("summary") ?? ""
                rows.append(.step(index: index, action: action, specialist: specialist, summary: summary,
                                  extras: step.leftovers()))
            }
        },
    ]

    /// Google Calendar's event fields (title, times, attendees...).
    private static func googleEvent(_ r: inout Remaining, _ rows: inout [GateRow], idPrefix: String) {
        rows.append(r.field("Title", "title", fallback: "(no title)"))
        rows.append(r.field("Start", "start", fallback: "(unknown)"))
        rows.append(r.field("End", "end", fallback: "(unknown)"))
        rows.append(r.field("Timezone", "timezone", fallback: "(unspecified)"))
        if let location = r.string("location"), !location.isEmpty { rows.append(.field(label: "Location", value: location)) }
        r.discardNull("location")
        rows.append(r.attendees())
        if let description = r.string("description"), !description.isEmpty {
            rows.append(.block(id: "\(idPrefix)-description", label: "Description", text: description))
        }
        r.discardNull("description")
    }

    /// Apple Calendar's event fields: no attendees, and a calendar name.
    private static func appleEvent(_ r: inout Remaining, _ rows: inout [GateRow], idPrefix: String) {
        let calendar = r.string("calendar_name") ?? r.string("calendar") ?? "(unspecified)"
        rows.append(.field(label: "Calendar", value: calendar))
        rows.append(r.field("Title", "title", fallback: "(no title)"))
        rows.append(r.field("Start", "start", fallback: "(unknown)"))
        rows.append(r.field("End", "end", fallback: "(unknown)"))
        rows.append(r.field("Timezone", "timezone", fallback: "(unspecified)"))
        if let location = r.string("location"), !location.isEmpty { rows.append(.field(label: "Location", value: location)) }
        r.discardNull("location")
        if let description = r.string("description"), !description.isEmpty {
            rows.append(.block(id: "\(idPrefix)-description", label: "Description", text: description))
        }
        r.discardNull("description")
    }
}

/// The keys of a payload (or a nested object in it) that no row has claimed
/// yet. A slot claims a key only when the value has the type the slot
/// expects, so a wrongly-typed value is never swallowed: it stays here and is
/// listed under "Other details" by `leftovers`.
struct Remaining {
    private var values: [String: JSONValue]
    private var adopted: [GateRow] = []

    init(_ values: [String: JSONValue]) { self.values = values }

    // MARK: claiming

    mutating func string(_ key: String) -> String? {
        guard case .string(let s)? = values[key] else { return nil }
        values[key] = nil
        return s
    }

    mutating func bool(_ key: String) -> Bool? {
        guard case .bool(let b)? = values[key] else { return nil }
        values[key] = nil
        return b
    }

    mutating func array(_ key: String) -> [JSONValue]? {
        guard case .array(let a)? = values[key] else { return nil }
        values[key] = nil
        return a
    }

    mutating func object(_ key: String) -> Remaining? {
        guard case .object(let o)? = values[key] else { return nil }
        values[key] = nil
        return Remaining(o)
    }

    /// Drops a key that carries no information of its own (the metadata the
    /// card does not show), whatever its type.
    mutating func discard(_ key: String) { values[key] = nil }

    /// Claims an explicit JSON null (an absent optional) so it is not listed.
    mutating func discardNull(_ key: String) {
        if case .null? = values[key] { values[key] = nil }
    }

    mutating func adopt(_ rows: [GateRow]) { adopted.append(contentsOf: rows) }

    // MARK: rows

    /// A labelled string; a missing key shows the fallback, a wrongly-typed
    /// one is left for "Other details".
    mutating func field(_ label: String, _ key: String, fallback: String = "(not provided)") -> GateRow {
        .field(label: label, value: string(key) ?? (values[key] == nil ? fallback : "(see Other details)"))
    }

    mutating func appendField(_ rows: inout [GateRow], _ label: String, _ key: String) {
        if let s = string(key) { rows.append(.field(label: label, value: s)) }
    }

    mutating func block(_ id: String, _ label: String, _ key: String) -> GateRow {
        if let s = string(key) { return .block(id: id, label: label, text: s) }
        return .field(label: label, value: values[key] == nil ? "(not provided)" : "(see Other details)")
    }

    /// An object shown whole as sorted, indented JSON, so nothing in it is
    /// ever left out.
    mutating func jsonBlock(_ id: String, _ label: String, _ key: String) -> GateRow {
        guard let value = values[key] else { return .field(label: label, value: "(not provided)") }
        values[key] = nil
        return .block(id: id, label: label, text: Self.text(value))
    }

    /// A list of strings joined with commas. Always a row, "(none)" when
    /// empty or absent.
    mutating func addresses(_ label: String, _ key: String) -> GateRow {
        guard let value = values[key] else { return .field(label: label, value: "(none)") }
        if case .array(let items) = value, items.allSatisfy({ $0.string != nil }) {
            values[key] = nil
            let joined = items.compactMap(\.string).joined(separator: ", ")
            return .field(label: label, value: joined.isEmpty ? "(none)" : joined)
        }
        return .field(label: label, value: "(see Other details)")
    }

    /// Google's attendees: strings, or objects. An object that is just an
    /// email shows the address; any other object shows in full.
    mutating func attendees() -> GateRow {
        guard case .array(let items)? = values["attendees"] else {
            let present = values["attendees"] != nil
            return .field(label: "Attendees", value: present ? "(see Other details)" : "(none)")
        }
        values["attendees"] = nil
        let shown = items.map { item -> String in
            if case .string(let s) = item { return s }
            if case .object(let o) = item, o.count == 1, let email = o["email"]?.string { return email }
            return Self.text(item)
        }
        return .field(label: "Attendees", value: shown.isEmpty ? "(none)" : shown.joined(separator: ", "))
    }

    // MARK: leftovers

    /// Every unclaimed key, in full, plus anything adopted from nested
    /// objects. A nested object's leftovers carry a `prefix`.
    func leftovers(prefix: String = "") -> [GateRow] {
        values.keys.sorted().map { Self.detail(key: prefix + $0, value: values[$0]!) } + adopted
    }

    static func detail(key: String, value: JSONValue) -> GateRow {
        let shown = text(value)
        if shown.contains("\n") || shown.count > 80 { return .block(id: "detail-\(key)", label: key, text: shown) }
        return .field(label: key, value: shown)
    }

    /// A value as the person should read it: a string as it is, anything else
    /// as sorted, indented JSON.
    static func text(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n.rounded() == n && abs(n) < 9e15 ? String(Int(n)) : String(n)
        case .array, .object:
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
            guard let data = try? encoder.encode(value), let s = String(data: data, encoding: .utf8) else { return "(unprintable)" }
            return s
        }
    }
}
