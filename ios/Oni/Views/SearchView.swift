import OniCore
import SwiftUI

/// Keyword search over the Replica (always works), plus the Mac's semantic
/// search when it's reachable. Offline, the screen says it is keyword-only.
struct SearchView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var local: [SearchResult] = []
    @State private var semantic: [NoteInfo] = []
    @State private var semanticState: SemanticState = .idle

    private enum SemanticState { case idle, searching, done, unavailable }

    var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView("Search your Vault", systemImage: "magnifyingglass",
                                       description: Text("Titles and note text, on this iPhone."))
                    .listRowBackground(Color.clear)
            } else {
                if local.isEmpty && semantic.isEmpty && semanticState != .searching {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                }
                if !local.isEmpty {
                    Section("Keyword") {
                        ForEach(local) { result in
                            NavigationLink(value: Route.note(result.path)) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(result.title)
                                    if !result.snippet.isEmpty {
                                        Text(result.snippet).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                                    }
                                }
                            }
                        }
                    }
                }
                if !semantic.isEmpty {
                    Section("Related (by meaning)") {
                        ForEach(semantic) { note in NoteRow(note: note, showFolder: true) }
                    }
                }
                Section { semanticFooter }
            }
        }
        .navigationTitle("Search")
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search notes")
        .autocorrectionDisabled()
        .onChange(of: model.revision) { _, _ in runLocal() }
        .task(id: query) {
            runLocal()
            await runSemantic()
        }
    }

    @ViewBuilder
    private var semanticFooter: some View {
        switch semanticState {
        case .searching:
            HStack(spacing: 8) { ProgressView(); Text("Asking the Mac for related notes…") }
        case .unavailable:
            Label("Mac unreachable — keyword search only", systemImage: "icloud.slash")
        default:
            EmptyView()
        }
    }

    private func runLocal() {
        local = model.index.search(query)
    }

    private func runSemantic() async {
        semantic = []
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2, let server = model.server else {
            semanticState = .idle
            return
        }
        // Debounce: typing restarts this task, which cancels the sleep.
        try? await Task.sleep(for: .milliseconds(450))
        guard !Task.isCancelled else { return }
        semanticState = .searching
        do {
            let hits = try await server.search(q)
            guard !Task.isCancelled else { return }
            let keyword = Set(local.map(\.path))
            let known = Dictionary(uniqueKeysWithValues: model.index.notes.map { ($0.path, $0) })
            semantic = hits.compactMap { known[$0.path] }.filter { !keyword.contains($0.path) }
            semanticState = .done
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            semanticState = .unavailable
        }
    }
}
