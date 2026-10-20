import OniCore
import SwiftUI

/// The Oni tab: phone-local chats with the on-device Oni.
struct ChatListView: View {
    @Environment(ChatController.self) private var chat
    @Environment(Navigator.self) private var nav

    var body: some View {
        List {
            if !chat.hasKey {
                Section {
                    NavigationLink(value: Route.chatSetup) {
                        Label("Add your Anthropic API key to start", systemImage: "key")
                    }
                }
            }
            if chat.chats.isEmpty {
                ContentUnavailableView(
                    "No chats yet", systemImage: "bubble.left.and.bubble.right",
                    description: Text("Ask Oni about your Vault, or tell it something worth saving."))
                    .listRowBackground(Color.clear)
            }
            ForEach(chat.chats) { item in
                NavigationLink(value: Route.chat(item.id)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).lineLimit(1)
                        HStack(spacing: 6) {
                            Text(item.updatedAt.formatted(.relative(presentation: .named)))
                            if item.cost > 0 { Text("· " + Cost.format(item.cost)) }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .onDelete { offsets in
                for i in offsets { chat.delete(chat.chats[i].id) }
            }
            if chat.totalCost > 0 {
                Section {
                    LabeledContent("Spent on this iPhone", value: Cost.format(chat.totalCost))
                } footer: {
                    Text("An estimate from Anthropic's published prices, not an invoice.")
                }
            }
        }
        .navigationTitle("Oni")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    nav.path.append(.chat(chat.newChat()))
                } label: { Image(systemName: "square.and.pencil") }
                .accessibilityLabel("New chat")
            }
        }
    }
}

enum Cost {
    static func format(_ dollars: Double) -> String {
        dollars < 0.01 ? String(format: "$%.4f", dollars) : String(format: "$%.2f", dollars)
    }
}

struct ChatView: View {
    let id: UUID
    @Environment(ChatController.self) private var chat
    @Environment(Navigator.self) private var nav
    @Environment(AppModel.self) private var app
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var current: Chat? { chat.chat(id) }

    var body: some View {
        VStack(spacing: 0) {
            if let current {
                transcript(current)
            } else {
                ContentUnavailableView("Chat not found", systemImage: "bubble.left")
            }
            Divider()
            if chat.isRunning { runningBar }
            if let error = chat.errorMessage { errorBar(error) }
            composer
        }
        .navigationTitle(current?.title ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Model", selection: Binding(get: { chat.model }, set: { chat.model = $0 })) {
                        ForEach(ClaudeModel.allCases) { Text($0.displayName).tag($0) }
                    }
                    if let cost = current?.cost, cost > 0 {
                        Text("This chat: " + Cost.format(cost))
                    }
                } label: { Image(systemName: "slider.horizontal.3") }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard let link = WikiLinks.parse(url: url), let path = app.index.resolve(link.target) else {
                return WikiLinks.parse(url: url) != nil ? .handled : .systemAction
            }
            nav.path.append(.note(path))
            return .handled
        })
    }

    private func transcript(_ current: Chat) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(Transcript.items(from: current.messages)) { item in
                        row(item).id(item.id)
                    }
                    if chat.isRunning, !chat.liveText.isEmpty {
                        MarkdownView(blocks: MarkdownBlocks.parse(markdown: chat.liveText)).id("live")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(16)
                .textSelection(.enabled)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: current.messages.count) { _, _ in proxy.scrollTo("end") }
            .onChange(of: chat.liveText) { _, _ in proxy.scrollTo("end") }
            .onAppear { proxy.scrollTo("end") }
        }
    }

    @ViewBuilder
    private func row(_ item: TranscriptItem) -> some View {
        switch item {
        case .user(_, let text):
            Text(text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: .infinity, alignment: .trailing)
        case .assistant(_, let text):
            MarkdownView(blocks: MarkdownBlocks.parse(markdown: text))
        case .tool(_, let name, let detail, let failed):
            Label {
                Text(toolLabel(name, detail)).lineLimit(1)
            } icon: {
                Image(systemName: failed ? "exclamationmark.circle" : toolIcon(name))
            }
            .font(.caption)
            .foregroundStyle(failed ? Color.red : Color.secondary)
        }
    }

    private func toolLabel(_ name: String, _ detail: String) -> String {
        let verb = switch name {
        case "search_vault": "Searched"
        case "read_vault_note": "Read"
        case "write_vault_note": "Saved note"
        case "update_vault_note": "Updated"
        case "delete_vault_note": "Deleted"
        default: name
        }
        return detail.isEmpty ? verb : "\(verb) “\(detail)”"
    }

    private func toolIcon(_ name: String) -> String {
        switch name {
        case "search_vault": "magnifyingglass"
        case "read_vault_note": "doc.text"
        case "write_vault_note": "square.and.pencil"
        case "update_vault_note": "pencil"
        case "delete_vault_note": "trash"
        default: "wrench"
        }
    }

    /// Always visible while a turn is running: what Oni is doing, and Stop.
    private var runningBar: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(chat.activity ?? "Working…").font(.subheadline)
            Spacer()
            Button("Stop", role: .destructive) { chat.stop() }
                .buttonStyle(.bordered)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    private func errorBar(_ message: String) -> some View {
        HStack(alignment: .top) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
            if chat.canRetry(id) {
                Button("Retry") { chat.retry(in: id) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(chat.hasKey ? "Ask Oni" : "Add your API key in Settings first", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .disabled(!chat.hasKey)
            Button {
                let text = draft
                draft = ""
                chat.send(text, in: id)
            } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
            }
            .disabled(chat.isRunning || !chat.hasKey || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}

/// Where the Anthropic key is pasted (Keychain). ADR 0004: the Mac's own key,
/// no app lock, by the user's choice.
struct ChatSetupView: View {
    @Environment(ChatController.self) private var chat
    @State private var key = ""

    var body: some View {
        Form {
            Section {
                SecureField("sk-ant-…", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Save key") {
                    chat.saveKey(key)
                    key = ""
                }
                .disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
            } header: {
                Text("Anthropic API key")
            } footer: {
                Text("""
                Stored in this iPhone's Keychain and sent only to api.anthropic.com. It is the same key the \
                Mac uses, so spend on the phone counts against it. If the phone is lost, rotate the key in \
                the Anthropic Console.
                """)
            }
            if chat.hasKey {
                Section {
                    Label("A key is saved", systemImage: "checkmark.circle").foregroundStyle(.green)
                    Button("Remove key", role: .destructive) { chat.removeKey() }
                }
            }
            Section("Model") {
                Picker("Model", selection: Binding(get: { chat.model }, set: { chat.model = $0 })) {
                    ForEach(ClaudeModel.allCases) { Text($0.displayName).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
        }
        .navigationTitle("Oni on this iPhone")
        .navigationBarTitleDisplayMode(.inline)
    }
}
