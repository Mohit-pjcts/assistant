import SwiftUI

@main
struct OniApp: App {
    @State private var model: AppModel
    @State private var chat: ChatController
    @State private var mac: MacController
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        _chat = State(initialValue: ChatController(app: model))
        _mac = State(initialValue: MacController(app: model))
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
    case chatSetup
}

@Observable @MainActor
final class Navigator {
    var path: [Route] = []
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(ChatController.self) private var chat
    @Environment(MacController.self) private var mac

    var body: some View {
        TabView {
            TabRoot { VaultView() }
                .tabItem { Label("Vault", systemImage: "books.vertical") }
            TabRoot { OniTabView() }
                .tabItem { Label("Oni", systemImage: "sparkles") }
                // A turn running is never invisible, even from another tab.
                .badge(chat.isRunning || mac.anyBusy ? "●" : nil)
            TabRoot { SearchView() }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
            TabRoot { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .badge(model.conflicts.count)
        }
    }
}

/// A tab with its own navigation stack, so wikilinks push within the tab.
struct TabRoot<Content: View>: View {
    @State private var navigator = Navigator()
    @ViewBuilder var content: Content

    var body: some View {
        NavigationStack(path: $navigator.path) {
            content
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .folder(let path): FolderView(path: path)
                    case .note(let path): NoteView(path: path)
                    case .conflicts: ConflictsView()
                    case .trash: TrashView()
                    case .chat(let id): ChatView(id: id)
                    case .macThread(let id): MacChatView(threadId: id)
                    case .chatSetup: ChatSetupView()
                    }
                }
        }
        .environment(navigator)
    }
}
