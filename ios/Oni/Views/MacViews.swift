import OniCore
import PhotosUI
import SwiftUI

/// Which Oni the tab is talking to. Separate lists, no merging (PLAN.md Phase 31 D6).
enum OniSide: String {
    case mac, phone
}

/// The Oni home: a switch between the Mac's Oni (real supervisor and
/// specialists) and the on-device Oni (Vault only, works offline from the Mac),
/// the earbud-voice control, and the conversations. Everything scrolls with the
/// list under a plain inline title, nothing is pinned over it.
struct OniTabView: View {
    @AppStorage("oniSide") private var side: OniSide = .mac
    @Environment(ChatController.self) private var chat
    @Environment(MacController.self) private var mac
    @Environment(Navigator.self) private var nav

    var body: some View {
        Group {
            switch side {
            case .mac: MacThreadListView(switchToPhone: { side = .phone }) { header }
            case .phone: PhoneChatList { header }
            }
        }
        .navigationTitle("Oni")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { OniTitle() }
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

    private var header: some View {
        VStack(spacing: 14) {
            Picker("Oni", selection: $side) {
                Text("Mac").tag(OniSide.mac)
                Text("This iPhone").tag(OniSide.phone)
            }
            .pickerStyle(.segmented)
            // Earbud voice talks to the Mac's Oni, so it lives on that side.
            if side == .mac { EarbudVoiceCard() }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }
}

// MARK: - Mac thread list

struct MacThreadListView<Header: View>: View {
    let switchToPhone: () -> Void
    @ViewBuilder let header: Header
    @Environment(MacController.self) private var mac

    private var ungrouped: [MacThread] { mac.threads.filter { $0.projectId == nil } }

    var body: some View {
        List {
            Section { header }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
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
            if !ungrouped.isEmpty {
                Section("Conversations") {
                    ForEach(ungrouped) { MacThreadRow(thread: $0) }
                }
            }
            ForEach(mac.projects) { project in
                let inside = mac.threads.filter { $0.projectId == project.id }
                if !inside.isEmpty {
                    Section {
                        DisclosureGroup {
                            ForEach(inside) { MacThreadRow(thread: $0) }
                        } label: {
                            Label(project.name, systemImage: "folder")
                        }
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
    @State private var photos: [PreparedPhoto] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var preparing = 0
    @State private var photoProblem: String?

    private static let maxPhotos = 4

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
        .onChange(of: session.unsent) { _, unsent in
            // An upload failed and nothing was sent: put the message back.
            guard unsent != nil, let back = session.takeUnsent() else { return }
            draft = back.text
            photos = back.photos
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(session.items) { item in
                        MacItemView(item: item, locked: session.isBusy || awaitingGate != nil) { surfaceId, name, context in
                            session.pressButton(surfaceId: surfaceId, name: name, context: context)
                        }
                        .id(item.id)
                    }
                    if let pending = session.pendingUser { UserBubble(text: pending, photos: session.pendingPhotos) }
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
        let canSend = !blocked && preparing == 0 && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 6) {
            if !photos.isEmpty || preparing > 0 { attachmentStrip }
            if let problem = photoProblem {
                Label(problem, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.red)
            }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $pickerItems, maxSelectionCount: Self.maxPhotos - photos.count, matching: .images) {
                    Image(systemName: "photo.badge.plus").font(.title2)
                }
                .disabled(awaitingGate != nil || photos.count >= Self.maxPhotos)
                .accessibilityLabel("Attach a photo")
                .onChange(of: pickerItems) { _, items in
                    guard !items.isEmpty else { return }
                    pickerItems = []
                    load(items)
                }
                TextField(placeholder, text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .disabled(awaitingGate != nil)
                Button {
                    let text = draft
                    let attached = photos
                    draft = ""
                    photos = []
                    photoProblem = nil
                    session.send(text, photos: attached)
                } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private var placeholder: String {
        if awaitingGate != nil { return "Approve or decline above first" }
        return photos.isEmpty ? "Ask Oni" : "Say what to do with the photo"
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(photos) { photo in
                    PhotoThumb(data: photo.data, size: 64)
                        .overlay(alignment: .topTrailing) {
                            Button { photos.removeAll { $0.id == photo.id } } label: {
                                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.65))
                            }
                            .padding(3)
                            .accessibilityLabel("Remove photo")
                        }
                }
                if preparing > 0 { ProgressView().frame(width: 64, height: 64) }
            }
        }
    }

    /// Reads each picked item off the main thread and converts it to a JPEG, so a
    /// 12-megapixel HEIC never blocks the screen and a bad one is reported here.
    private func load(_ items: [PhotosPickerItem]) {
        photoProblem = nil
        let room = Self.maxPhotos - photos.count
        if items.count > room { photoProblem = "Up to \(Self.maxPhotos) photos per message." }
        for item in items.prefix(max(0, room)) {
            preparing += 1
            Task {
                defer { preparing -= 1 }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw PhotoPrepError.unreadable }
                    let name = item.itemIdentifier ?? "photo"
                    let prepared = try await Task.detached(priority: .userInitiated) {
                        try PhotoPrep.jpeg(from: data, filename: name)
                    }.value
                    photos.append(prepared)
                } catch {
                    photoProblem = (error as? PhotoPrepError)?.description ?? "A photo could not be loaded."
                }
            }
        }
    }
}

private struct UserBubble: View {
    let text: String
    var photos: [PreparedPhoto] = []

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !photos.isEmpty {
                HStack(spacing: 6) { ForEach(photos) { PhotoThumb(data: $0.data, size: 96) } }
            }
            Text(text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A small square preview, decoded once.
private struct PhotoThumb: View {
    let data: Data
    let size: CGFloat
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill() } else { Color.secondary.opacity(0.15) }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task { image = await Task.detached { UIImage(data: data) }.value }
    }
}

private struct MacItemView: View {
    let item: MacTranscriptItem
    /// True while a turn runs or a confirmation is open: cards cannot start a second turn.
    let locked: Bool
    let onPress: (String, String, [String: JSONValue]) -> Void

    var body: some View {
        switch item {
        case .user(_, let text):
            UserBubble(text: text)
        case .assistant(_, let text, let surfaces, let skipped):
            VStack(alignment: .leading, spacing: 10) {
                if !text.isEmpty { MarkdownView(blocks: MarkdownBlocks.parse(markdown: text)) }
                ForEach(surfaces, id: \.surfaceId) { surface in
                    A2UISurfaceView(surface: surface, disabled: locked, onPress: onPress)
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
