import OniCore
import SwiftUI
import UIKit

/// Draws a validated generative-UI surface (PLAN.md Phase 31 D5). Everything
/// reaching here already passed `A2UISurface.parse`: a `Button` can only report
/// `{name}`, and images are inline base64, so nothing here fetches or runs
/// anything. Inputs edit a local `A2UIFormState`; only a pressed `Button`
/// sends it (as an ordinary turn, through the same confirmation gates).
/// Video and AudioPlayer are placeholders: open the conversation on the Mac.
struct A2UISurfaceView: View {
    let surface: A2UISurface
    let disabled: Bool
    /// (surface id, action name, the whole local data model).
    let onPress: (String, String, [String: JSONValue]) -> Void
    @State private var form: A2UIFormState

    init(surface: A2UISurface, disabled: Bool, onPress: @escaping (String, String, [String: JSONValue]) -> Void) {
        self.surface = surface
        self.disabled = disabled
        self.onPress = onPress
        _form = State(initialValue: A2UIFormState(surface))
    }

    var body: some View {
        A2UINode(id: "root", ctx: A2UIContext(surface: surface, disabled: disabled, press: { name, context in
            onPress(surface.surfaceId, name, context)
        }), form: $form, depth: 0)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct A2UIContext {
    let surface: A2UISurface
    let disabled: Bool
    let press: (String, [String: JSONValue]) -> Void
}

/// One component, and (recursively) its children. Depth is capped as a second
/// line of defence behind the parser's cycle check.
struct A2UINode: View {
    let id: String
    let ctx: A2UIContext
    @Binding var form: A2UIFormState
    let depth: Int

    private static let maxDepth = 32

    var body: some View {
        if depth < Self.maxDepth, let component = ctx.surface.component(id) {
            content(component)
        }
    }

    private func child(_ id: String) -> A2UINode { A2UINode(id: id, ctx: ctx, form: $form, depth: depth + 1) }

    private func children(_ c: A2UIComponent) -> some View {
        ForEach(Array(c.childIds.enumerated()), id: \.offset) { _, childId in child(childId) }
    }

    private func alignment(_ c: A2UIComponent) -> HorizontalAlignment {
        switch c.fields["align"]?.string {
        case "center": .center
        case "end": .trailing
        default: .leading
        }
    }

    private func flowAlignment(_ c: A2UIComponent) -> FlowLayout.Justify {
        switch c.fields["justify"]?.string {
        case "center", "spaceAround", "spaceEvenly": .center
        case "end": .end
        default: .start
        }
    }

    @ViewBuilder
    private func content(_ c: A2UIComponent) -> some View {
        switch c.type {
        case "Text": textView(c)
        case "Badge":
            Text(form.string(c.fields["text"]))
                .font(.caption).fontWeight(.medium)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(.secondary.opacity(0.18), in: Capsule())
        case "Divider":
            if c.fields["axis"]?.string == "vertical" {
                Rectangle().fill(.secondary.opacity(0.3)).frame(width: 1)
            } else {
                Divider()
            }
        case "Image": A2UIImageView(c: c, form: form)
        case "Icon":
            if let name = form.iconName(c.fields["name"]) { Image(systemName: A2UIIcons.symbol(name)).imageScale(.large) }
        case "Video": placeholder("Video", "play.rectangle", c)
        case "AudioPlayer": placeholder("Audio", "speaker.wave.2", c)
        case "Column":
            VStack(alignment: alignment(c), spacing: 8) { children(c) }
                .frame(maxWidth: .infinity, alignment: .leading)
        case "Row":
            FlowLayout(justify: flowAlignment(c)) { children(c) }
        case "List":
            if c.fields["direction"]?.string == "horizontal" {
                FlowLayout(justify: .start) { children(c) }
            } else {
                VStack(alignment: alignment(c), spacing: 6) { children(c) }.frame(maxWidth: .infinity, alignment: .leading)
            }
        case "Card":
            VStack(alignment: .leading, spacing: 8) { children(c) }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
        case "Tabs": A2UITabs(c: c, ctx: ctx, form: $form, depth: depth)
        case "Modal": A2UIModal(c: c, ctx: ctx, form: $form, depth: depth)
        case "TextField": textField(c)
        case "CheckBox":
            let path = form.path(c.fields["value"])
            Toggle(form.string(c.fields["label"]), isOn: Binding(
                get: { form.bool(c.fields["value"]) }, set: { form.set(path, bool: $0) }))
                .disabled(path == nil)
        case "ChoicePicker": A2UIChoicePicker(c: c, form: $form)
        case "Slider": slider(c)
        case "DateTimeInput": A2UIDateField(c: c, form: $form)
        case "Button": button(c)
        default: EmptyView()
        }
    }

    // MARK: pieces

    private func textView(_ c: A2UIComponent) -> some View {
        let text = form.string(c.fields["text"])
        return Group {
            switch c.fields["variant"]?.string ?? "body" {
            case "h1": Text(text).font(.title).fontWeight(.bold)
            case "h2": Text(text).font(.title2).fontWeight(.semibold)
            case "h3": Text(text).font(.title3).fontWeight(.semibold)
            case "h4": Text(text).font(.headline)
            case "h5": Text(text).font(.subheadline).fontWeight(.semibold)
            case "caption": Text(text).font(.caption).foregroundStyle(.secondary)
            default: Text(text)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func placeholder(_ kind: String, _ symbol: String, _ c: A2UIComponent) -> some View {
        let note = c.fields["description"].map { form.string($0) }.flatMap { $0.isEmpty ? nil : " (\($0))" } ?? ""
        return Label("\(kind)\(note): open this conversation on your Mac to play it.", systemImage: symbol)
            .font(.footnote).foregroundStyle(.secondary)
            .padding(10)
            .background(.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func textField(_ c: A2UIComponent) -> some View {
        let path = form.path(c.fields["value"])
        let binding = Binding(get: { form.string(c.fields["value"]) }, set: { form.set(path, string: $0) })
        VStack(alignment: .leading, spacing: 3) {
            Text(form.string(c.fields["label"])).font(.caption).foregroundStyle(.secondary)
            Group {
                switch c.fields["variant"]?.string {
                case "longText": TextField("", text: binding, axis: .vertical).lineLimit(3...8)
                case "number": TextField("", text: binding).keyboardType(.decimalPad)
                case "obscured": SecureField("", text: binding)
                default: TextField("", text: binding)
                }
            }
            .textFieldStyle(.roundedBorder)
            .disabled(path == nil)
        }
    }

    @ViewBuilder
    private func slider(_ c: A2UIComponent) -> some View {
        let path = form.path(c.fields["value"])
        let low = c.fields["min"]?.double ?? 0
        let high = c.fields["max"]?.double ?? 100
        let value = form.number(c.fields["value"], fallback: low)
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(c.fields["label"].map { form.string($0) } ?? "Value").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(A2UIFormState.text(of: value)).font(.caption).monospacedDigit()
            }
            if high > low {
                Slider(value: Binding(get: { min(max(value, low), high) }, set: { form.set(path, number: $0) }), in: low...high)
                    .disabled(path == nil)
            }
        }
    }

    @ViewBuilder
    private func button(_ c: A2UIComponent) -> some View {
        let name = c.actionName
        let label = Button {
            if let name { ctx.press(name, form.context) }
        } label: { children(c) }
        .disabled(name == nil || ctx.disabled)
        switch c.fields["variant"]?.string {
        case "primary": label.buttonStyle(.borderedProminent)
        case "borderless": label.buttonStyle(.plain).foregroundStyle(Color.accentColor)
        default: label.buttonStyle(.bordered)
        }
    }
}

// MARK: - Components with their own state

private struct A2UIImageView: View {
    let c: A2UIComponent
    let form: A2UIFormState
    @State private var image: UIImage?
    @State private var failed = false

    private static let maxSize: [String: CGFloat] = [
        "icon": 24, "avatar": 40, "smallFeature": 120, "mediumFeature": 240, "largeFeature": 400,
    ]

    var body: some View {
        let uri = form.string(c.fields["url"])
        let limit = Self.maxSize[c.fields["variant"]?.string ?? "mediumFeature"]
        Group {
            if let image {
                if c.fields["fit"]?.string == "cover" {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(maxWidth: limit ?? .infinity, maxHeight: limit ?? 320).clipped()
                } else {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: limit ?? .infinity)
                }
            } else if failed {
                Label("An image could not be shown.", systemImage: "photo.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(c.fields["description"].map { form.string($0) } ?? "")
        .task(id: uri) {
            guard !uri.isEmpty else { return }
            let decoded = await Task.detached { () -> UIImage? in
                A2UIMedia.decode(uri).flatMap { UIImage(data: $0.data) }
            }.value
            image = decoded
            failed = decoded == nil
        }
    }
}

private struct TabPickerStyle: ViewModifier {
    let segmented: Bool
    func body(content: Content) -> some View {
        if segmented { content.pickerStyle(.segmented) } else { content.pickerStyle(.menu) }
    }
}

private struct A2UITabs: View {
    let c: A2UIComponent
    let ctx: A2UIContext
    @Binding var form: A2UIFormState
    let depth: Int
    @State private var active = 0

    var body: some View {
        let tabs = c.fields["tabs"]?.array ?? []
        VStack(alignment: .leading, spacing: 8) {
            if tabs.count > 1 {
                Picker("", selection: $active) {
                    ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in
                        Text(form.string(tab["title"])).tag(index)
                    }
                }
                .modifier(TabPickerStyle(segmented: tabs.count <= 3))
            }
            if tabs.indices.contains(active), let childId = tabs[active]["child"]?.string {
                A2UINode(id: childId, ctx: ctx, form: $form, depth: depth + 1)
            }
        }
    }
}

/// `trigger` (usually a Button) opens the sheet; it does NOT also fire its own
/// action, the same reading the dashboard takes.
private struct A2UIModal: View {
    let c: A2UIComponent
    let ctx: A2UIContext
    @Binding var form: A2UIFormState
    let depth: Int
    @State private var open = false

    var body: some View {
        if let triggerId = c.fields["trigger"]?.string, let contentId = c.fields["content"]?.string,
           let trigger = ctx.surface.component(triggerId) {
            Button { open = true } label: {
                if trigger.type == "Button" {
                    ForEach(Array(trigger.childIds.enumerated()), id: \.offset) { _, id in
                        A2UINode(id: id, ctx: ctx, form: $form, depth: depth + 2)
                    }
                } else {
                    A2UINode(id: triggerId, ctx: ctx, form: $form, depth: depth + 1)
                }
            }
            .buttonStyle(.bordered)
            .sheet(isPresented: $open) {
                ScrollView {
                    A2UINode(id: contentId, ctx: ctx, form: $form, depth: depth + 1).padding(20)
                }
                .presentationDetents([.medium, .large])
            }
        }
    }
}

private struct Choice: Identifiable {
    let label: String
    let value: String
    var id: String { value }
}

private struct A2UIChoicePicker: View {
    let c: A2UIComponent
    @Binding var form: A2UIFormState
    @State private var filter = ""

    @ViewBuilder
    private func chip(_ option: Choice, on: Bool, path: String?, multiple: Bool) -> some View {
        let button = Button(option.label) { form.choose(path, value: option.value, multiple: multiple) }
        if on { button.buttonStyle(.borderedProminent).disabled(path == nil) }
        else { button.buttonStyle(.bordered).disabled(path == nil) }
    }

    var body: some View {
        let path = form.path(c.fields["value"])
        let multiple = c.fields["variant"]?.string == "multipleSelection"
        let chips = c.fields["displayStyle"]?.string == "chips"
        let selected = form.stringList(c.fields["value"])
        let options = (c.fields["options"]?.array ?? []).compactMap { option -> Choice? in
            guard let value = option["value"]?.string else { return nil }
            return Choice(label: form.string(option["label"]), value: value)
        }
        let shown: [Choice] = c.fields["filterable"]?.bool == true && !filter.isEmpty
            ? options.filter { $0.label.localizedCaseInsensitiveContains(filter) } : options
        VStack(alignment: .leading, spacing: 6) {
            if let label = c.fields["label"] { Text(form.string(label)).font(.caption).foregroundStyle(.secondary) }
            if c.fields["filterable"]?.bool == true {
                TextField("Filter options", text: $filter).textFieldStyle(.roundedBorder)
            }
            if chips {
                FlowLayout(justify: .start) {
                    ForEach(shown) { option in
                        let on = selected.contains(option.value)
                        chip(option, on: on, path: path, multiple: multiple)
                    }
                }
            } else {
                ForEach(shown) { option in
                    let on = selected.contains(option.value)
                    Button { form.choose(path, value: option.value, multiple: multiple) } label: {
                        HStack {
                            Image(systemName: on ? (multiple ? "checkmark.square.fill" : "largecircle.fill.circle")
                                                 : (multiple ? "square" : "circle"))
                            Text(option.label).foregroundStyle(.primary)
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(path == nil)
                }
            }
        }
    }
}

private struct A2UIDateField: View {
    let c: A2UIComponent
    @Binding var form: A2UIFormState

    var body: some View {
        let path = form.path(c.fields["value"])
        let parts = A2UIDateTime.parts(enableDate: c.fields["enableDate"]?.bool ?? false,
                                       enableTime: c.fields["enableTime"]?.bool ?? false)
        let components: DatePickerComponents = parts.date && parts.time ? [.date, .hourAndMinute]
            : parts.time ? [.hourAndMinute] : [.date]
        let current = A2UIDateTime.parse(form.string(c.fields["value"]))
        let low = c.fields["min"].flatMap { A2UIDateTime.parse(form.string($0)) } ?? .distantPast
        let high = c.fields["max"].flatMap { A2UIDateTime.parse(form.string($0)) } ?? .distantFuture
        VStack(alignment: .leading, spacing: 3) {
            Text(c.fields["label"].map { form.string($0) } ?? "Value").font(.caption).foregroundStyle(.secondary)
            if let current {
                DatePicker("", selection: Binding(
                    get: { current },
                    set: { form.set(path, string: A2UIDateTime.format($0, parts: parts)) }),
                    in: low...max(low, high), displayedComponents: components)
                    .labelsHidden().disabled(path == nil)
            } else {
                Button("Choose…") { form.set(path, string: A2UIDateTime.format(.now, parts: parts)) }
                    .buttonStyle(.bordered).disabled(path == nil)
            }
        }
    }
}

// MARK: - Layout and icons

/// Wraps children onto new lines, like the dashboard's `flex-wrap` rows.
struct FlowLayout: Layout {
    enum Justify { case start, center, end }
    var justify: Justify = .start
    var spacing: CGFloat = 8

    private func lines(_ subviews: Subviews, width: CGFloat) -> [[Int]] {
        var result: [[Int]] = [[]]
        var x: CGFloat = 0
        for (index, view) in subviews.enumerated() {
            let w = view.sizeThatFits(.unspecified).width
            if x > 0, x + w > width { result.append([]); x = 0 }
            result[result.count - 1].append(index)
            x += w + spacing
        }
        return result
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var height: CGFloat = 0
        var widest: CGFloat = 0
        for line in lines(subviews, width: width) {
            let sizes = line.map { subviews[$0].sizeThatFits(.unspecified) }
            height += (sizes.map(\.height).max() ?? 0) + spacing
            widest = max(widest, sizes.map(\.width).reduce(0, +) + spacing * CGFloat(max(0, sizes.count - 1)))
        }
        return CGSize(width: proposal.width ?? widest, height: max(0, height - spacing))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in lines(subviews, width: bounds.width) {
            let sizes = line.map { subviews[$0].sizeThatFits(.unspecified) }
            let used = sizes.map(\.width).reduce(0, +) + spacing * CGFloat(max(0, sizes.count - 1))
            var x = switch justify {
            case .start: bounds.minX
            case .center: bounds.minX + (bounds.width - used) / 2
            case .end: bounds.maxX - used
            }
            let rowHeight = sizes.map(\.height).max() ?? 0
            for (offset, index) in line.enumerated() {
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sizes[offset]))
                x += sizes[offset].width + spacing
            }
            y += rowHeight + spacing
        }
    }
}

/// A2UI's fixed icon names as SF Symbols. Not one-to-one for every name.
enum A2UIIcons {
    static func symbol(_ name: String) -> String {
        map[name] ?? "questionmark.circle"
    }

    private static let map: [String: String] = [
        "accountCircle": "person.crop.circle", "add": "plus", "arrowBack": "arrow.left", "arrowForward": "arrow.right",
        "attachFile": "paperclip", "calendarToday": "calendar", "call": "phone", "camera": "camera", "check": "checkmark",
        "close": "xmark", "delete": "trash", "download": "arrow.down.to.line", "edit": "pencil", "event": "calendar.badge.clock",
        "error": "exclamationmark.circle", "fastForward": "forward", "favorite": "heart.fill", "favoriteOff": "heart",
        "folder": "folder", "help": "questionmark.circle", "home": "house", "info": "info.circle",
        "locationOn": "mappin.and.ellipse", "lock": "lock", "lockOpen": "lock.open", "mail": "envelope", "menu": "line.3.horizontal",
        "moreVert": "ellipsis", "moreHoriz": "ellipsis", "notificationsOff": "bell.slash", "notifications": "bell",
        "pause": "pause", "payment": "creditcard", "person": "person", "phone": "phone", "photo": "photo", "play": "play",
        "print": "printer", "refresh": "arrow.clockwise", "rewind": "backward", "search": "magnifyingglass", "send": "paperplane",
        "settings": "gearshape", "share": "square.and.arrow.up", "shoppingCart": "cart", "skipNext": "forward.end",
        "skipPrevious": "backward.end", "star": "star.fill", "starHalf": "star.leadinghalf.filled", "starOff": "star",
        "stop": "stop", "upload": "arrow.up.to.line", "visibility": "eye", "visibilityOff": "eye.slash",
        "volumeDown": "speaker.wave.1", "volumeMute": "speaker", "volumeOff": "speaker.slash", "volumeUp": "speaker.wave.3",
        "warning": "exclamationmark.triangle",
    ]
}
