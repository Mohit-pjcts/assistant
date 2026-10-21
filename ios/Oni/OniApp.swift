import SwiftUI

@main
struct OniApp: App {
    @State private var model: AppModel
    @State private var chat: ChatController
    @State private var mac: MacController
    // Owned here, not by a screen, so arming survives leaving the Oni tab (Phase 32).
    @State private var earbud: EarbudVoice
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        _chat = State(initialValue: ChatController(app: model))
        let mac = MacController(app: model)
        _mac = State(initialValue: mac)
        _earbud = State(initialValue: EarbudVoice(mac: mac))
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if model.isPaired {
                    RootView()
                } else {
                    PairingView()
                }
            }
            .environment(model)
            .environment(chat)
            .environment(mac)
            .environment(earbud)
        }
        .onChange(of: scenePhase) { _, phase in
            // Foreground-only sync (PLAN.md Phase 30, decision 10).
            if phase == .active {
                Task { await model.sync() }
                // A turn running on the Mac when the phone locked is picked up again.
                Task { await mac.foreground() }
            }
        }
    }
}

/// Where a screen can push to. One path per tab.
enum Route: Hashable {
    case folder(String)
    case note(String)
    case conflicts
    case trash
    case chat(UUID)
    case macThread(String)
    case macBoard
    case macMemory
    case chatSetup
    case earbudLog
}

@Observable @MainActor
final class Navigator {
    var path: [Route] = []
}

/// The whole app: one screen at a time, chosen from the menu at the top left
/// (the Mac app's own navigation rail, as a slide-in menu).
struct RootView: View {
    @State private var menu = AppMenu()

    var body: some View {
        ZStack(alignment: .leading) {
            screen
                // A new screen starts at its own root, not wherever the last one was.
                .id(menu.selection)
                .disabled(menu.isOpen)
            if menu.isOpen {
                Color.black.opacity(0.45)
                    .ignoresSafeArea()
                    .onTapGesture { menu.isOpen = false }
                    .accessibilityLabel("Close menu")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
                MenuDrawer()
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.snappy(duration: 0.25), value: menu.isOpen)
        .environment(menu)
    }

    @ViewBuilder private var screen: some View {
        switch menu.selection {
        case .oni: TabRoot { OniTabView() }
        case .calendar: TabRoot { CalendarView() }
        case .board: TabRoot { MacBoardView() }
        case .memory: TabRoot { MacMemoryView() }
        case .vault: TabRoot { VaultView() }
        case .search: TabRoot { SearchView() }
        case .settings: TabRoot { SettingsView() }
        }
    }
}

/// A screen with its own navigation stack, so wikilinks push within it, and the
/// menu button at the top left of its root.
struct TabRoot<Content: View>: View {
    @State private var navigator = Navigator()
    @ViewBuilder var content: Content

    var body: some View {
        NavigationStack(path: $navigator.path) {
            content
                .toolbar { ToolbarItem(placement: .topBarLeading) { MenuButton() } }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .folder(let path): FolderView(path: path)
                    case .note(let path): NoteView(path: path)
                    case .conflicts: ConflictsView()
                    case .trash: TrashView()
                    case .chat(let id): ChatView(id: id)
                    case .macThread(let id): MacChatView(threadId: id)
                    case .macBoard: MacBoardView()
                    case .macMemory: MacMemoryView()
                    case .chatSetup: ChatSetupView()
                    case .earbudLog: EarbudLogView()
                    }
                }
        }
        .environment(navigator)
    }
}
