import OniCore
import SwiftUI

/// Which Oni the tab is talking to. Separate lists, no merging (PLAN.md Phase 31 D6).
enum OniSide: String {
    case mac, phone
}

/// The Oni tab: a switch between the Mac's Oni (real supervisor and
/// specialists) and the on-device Oni (Vault only, works offline from the Mac).
struct OniTabView: View {
    @AppStorage("oniSide") private var side: OniSide = .mac
    @Environment(ChatController.self) private var chat
    @Environment(MacController.self) private var mac
    @Environment(Navigator.self) private var nav

    var body: some View {
        Group {
            switch side {
            case .mac: MacThreadListView(switchToPhone: { side = .phone })
            case .phone: PhoneChatList()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("Oni", selection: $side) {
                Text("Mac").tag(OniSide.mac)
                Text("This iPhone").tag(OniSide.phone)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(.bar)
        }
        .navigationTitle("Oni")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    switch side {
                    case .phone: nav.path.append(.chat(chat.newChat()))
                    case .mac:
                        Task { if let id = await mac.newThread() { nav.path.append(.macThread(id)) } }
                    }
                } label: { Image(systemName: "square.and.pencil") }
                .accessibilityLabel("New chat")
            }
        }
    }
}

// MARK: - Mac thread list

struct MacThreadListView: View {
    let switchToPhone: () -> Void
    @Environment(MacController.self) private var mac

    private var ungrouped: [MacThread] { mac.threads.filter { $0.projectId == nil } }

    var body: some View {
        List {
            if case .unreachable(let why) = mac.link {
                Section {
                    Label("Can't reach your Mac", systemImage: "wifi.exclamationmark").font(.headline)
                    Text("\(why)\nCheck that Tailscale is on and the Mac is awake. The on-device Oni still works.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Try again") { Task { await mac.refresh() } }
                    Button("Use the Oni on this iPhone", action: switchToPhone)
                }
            }
            if mac.link == .connected, mac.threads.isEmpty {
                ContentUnavailableView(
                    "No conversations yet", systemImage: "bubble.left.and.bubble.right",
                    description: Text("Start one with the button above. It also shows up on your Mac."))
                    .listRowBackground(Color.clear)
            }
            ForEach(ungrouped) { MacThreadRow(thread: $0) }
            ForEach(mac.projects) { project in
                let inside = mac.threads.filter { $0.projectId == project.id }
                if !inside.isEmpty {
                    DisclosureGroup {
                        ForEach(inside) { MacThreadRow(thread: $0) }
                    } label: {
                        Label(project.name, systemImage: "folder")
                    }
                }
            }
        }
        .overlay { if mac.link == .unknown, mac.isLoading { ProgressView() } }
        .refreshable { await mac.refresh() }
        .task { await mac.refresh() }
    }
}

private struct MacThreadRow: View {
    let thread: MacThread
    @Environment(MacController.self) private var mac

    var body: some View {
        NavigationLink(value: Route.macThread(thread.id)) {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(thread.title ?? "New conversation").lineLimit(1)
                    if mac.existingSession(thread.id)?.isBusy == true { ProgressView().controlSize(.mini) }
                }
                if let date = MacDates.parse(thread.lastActiveAt) {
                    Text(date.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - A conversation with the Mac

struct MacChatView: View {
    let threadId: String
    @Environment(MacController.self) private var mac
    @State private var session: MacChatSession?
    @State private var unavailable = false
    @State private var draft = ""

    var body: some View {
        Group {
            if let session {
                MacChatContent(session: session, title: mac.threads.first { $0.id == threadId }?.title, draft: $draft)
            } else if unavailable {
                ContentUnavailableView("Not connected to a Mac", systemImage: "wifi.slash")
            } else {
                ProgressView()
            }
        }
        .task {
            guard let made = mac.session(threadId) else { unavailable = true; return }
            session = made
            await made.open()
        }
    }
}

private struct MacChatContent: View {
    let session: MacChatSession
    let title: String?
    @Binding var draft: String

    private var awaitingGate: Gate? {
        if case .awaitingApproval(let gate) = session.phase { gate } else { nil }
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            Divider()
            if session.isBusy { runningBar }
            if session.phase == .lostContact { lostContactBar }
            if let error = session.errorMessage { banner(error, systemImage: "exclamationmark.triangle", color: .red, dismiss: session.dismissError) }
            if let notice = session.notice { banner(notice, systemImage: "info.circle", color: .secondary, dismiss: session.dismissNotice) }
            composer
        }
        .navigationTitle(title ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(session.items) { item in
                        MacItemView(item: item).id(item.id)
                    }
                    if let pending = session.pendingUser { UserBubble(text: pending) }
                    if session.isBusy, !session.liveText.isEmpty {
                        MarkdownView(blocks: MarkdownBlocks.parse(markdown: session.liveText)).id("live")
                    }
                    if let gate = awaitingGate {
                        GateCardView(gate: gate) { session.answer(approved: $0) }.id("gate")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(16)
                .textSelection(.enabled)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: session.items.count) { _, _ in proxy.scrollTo("end") }
            .onChange(of: session.liveText) { _, _ in proxy.scrollTo("end") }
            .onChange(of: awaitingGate != nil) { _, _ in proxy.scrollTo("end") }
            .onAppear { proxy.scrollTo("end") }
        }
    }

    /// Always visible while a turn runs: what Oni is doing, and Stop.
    private var runningBar: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(session.activity ?? "Working…").font(.subheadline).lineLimit(1)
            Spacer()
            Button("Stop", role: .destructive) { Task { await session.stop() } }.buttonStyle(.bordered)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    private var lostContactBar: some View {
        HStack(alignment: .top, spacing: 10) {
            Label("Can't reach your Mac. If Oni was working, it still is.", systemImage: "wifi.exclamationmark")
                .font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            Button("Check again") { Task { await session.reattach() } }.buttonStyle(.bordered)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }

    private func banner(_ text: String, systemImage: String, color: Color, dismiss: @escaping () -> Void) -> some View {
        HStack(alignment: .top) {
            Label(text, systemImage: systemImage).font(.footnote).foregroundStyle(color)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { dismiss() } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
    }

    private var composer: some View {
        let blocked = session.isBusy || awaitingGate != nil
        return HStack(alignment: .bottom, spacing: 8) {
            TextField(awaitingGate != nil ? "Approve or decline above first" : "Ask Oni", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .disabled(awaitingGate != nil)
            Button {
                let text = draft
                draft = ""
                session.send(text)
            } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
            .disabled(blocked || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}

private struct UserBubble: View {
    let text: String

    var body: some View {
        Text(text)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private struct MacItemView: View {
    let item: MacTranscriptItem

    var body: some View {
        switch item {
        case .user(_, let text):
            UserBubble(text: text)
        case .assistant(_, let text, let surfaces, let skipped):
            VStack(alignment: .leading, spacing: 8) {
                if !text.isEmpty { MarkdownView(blocks: MarkdownBlocks.parse(markdown: text)) }
                // Generative-UI cards arrive in the next stage; say so rather than hide them.
                if !surfaces.isEmpty {
                    Label("Oni made \(surfaces.count == 1 ? "an interactive card" : "\(surfaces.count) interactive cards"). Open this conversation on your Mac to use \(surfaces.count == 1 ? "it" : "them").",
                          systemImage: "rectangle.on.rectangle")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if skipped > 0 {
                    Label("\(skipped) card\(skipped == 1 ? "" : "s") could not be shown safely and \(skipped == 1 ? "was" : "were") skipped.",
                          systemImage: "exclamationmark.shield")
                        .font(.footnote).foregroundStyle(.orange)
                }
            }
        }
    }
}
