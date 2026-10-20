import OniCore
import SwiftUI

/// The Vault root: conflicts banner, recently edited, then folders and loose notes.
struct VaultView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        FolderList(folder: model.tree, isRoot: true)
            .navigationTitle("Vault")
    }
}

struct FolderView: View {
    let path: String
    @Environment(AppModel.self) private var model

    var body: some View {
        if let folder = NoteTree.node(at: path, in: model.tree) {
            FolderList(folder: folder, isRoot: false)
                .navigationTitle(folder.name)
                .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("Folder not found", systemImage: "folder.badge.questionmark")
        }
    }
}

private struct FolderList: View {
    let folder: FolderNode
    let isRoot: Bool
    @Environment(AppModel.self) private var model
    @Environment(Navigator.self) private var nav
    @State private var newTitle = ""
    @State private var showingNew = false
    @State private var error: String?

    private var recent: [NoteInfo] {
        model.index.notes.filter { $0.modified != nil }
            .sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }
            .prefix(6).map { $0 }
    }

    var body: some View {
        List {
            if isRoot {
                if !model.conflicts.isEmpty {
                    Section {
                        NavigationLink(value: Route.conflicts) {
                            Label("\(model.conflicts.count) note\(model.conflicts.count == 1 ? "" : "s") edited on both sides",
                                  systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                        }
                    }
                }
                if model.index.count == 0 {
                    emptyState
                } else if !recent.isEmpty {
                    Section("Recently edited") {
                        ForEach(recent) { note in NoteRow(note: note, showFolder: true) }
                    }
                }
            }
            if !folder.folders.isEmpty {
                Section(isRoot ? "Folders" : "") {
                    ForEach(folder.folders) { sub in
                        NavigationLink(value: Route.folder(sub.path)) {
                            HStack {
                                Label(sub.name, systemImage: "folder")
                                Spacer()
                                Text("\(sub.totalNotes)").foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                    }
                }
            }
            if !folder.notes.isEmpty {
                Section(isRoot ? "Notes" : "") {
                    ForEach(folder.notes) { note in NoteRow(note: note, showFolder: false) }
                }
            }
            Section { SyncStatusRow() }
        }
        .refreshable { await model.sync() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showingNew = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New note")
            }
        }
        .alert("New note", isPresented: $showingNew) {
            TextField("Title", text: $newTitle)
            Button("Create") { create() }
            Button("Cancel", role: .cancel) { newTitle = "" }
        } message: {
            Text(folder.path.isEmpty ? "In the Vault root" : "In \(folder.path)")
        }
        .alert("Couldn't create the note", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(model.isSyncing ? "Fetching your Vault…" : "No notes yet").font(.headline)
                Text(model.isOffline
                     ? "The Mac isn't reachable. Turn on Tailscale and open Oni on the Mac, then pull down to retry."
                     : "Pull down to sync with the Mac.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private func create() {
        let title = newTitle
        newTitle = ""
        Task {
            do {
                let path = try await model.createNote(title: title, in: folder.path)
                nav.path.append(.note(path))
            } catch {
                self.error = AppModel.describe(error)
            }
        }
    }
}

struct NoteRow: View {
    let note: NoteInfo
    let showFolder: Bool

    var body: some View {
        NavigationLink(value: Route.note(note.path)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(note.title)
                if showFolder, let folder = note.folder {
                    Text(folder).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// "Synced 2 min ago" / "Offline" / what went wrong, at the foot of the lists.
struct SyncStatusRow: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 8) {
            if model.isSyncing {
                ProgressView()
                Text("Syncing…")
            } else if model.authFailed {
                Image(systemName: "key.slash").foregroundStyle(.red)
                Text("Token rejected — pair again in Settings")
            } else if model.isOffline {
                Image(systemName: "icloud.slash").foregroundStyle(.orange)
                Text(model.lastSyncedAt.map { "Offline — last synced \($0.formatted(.relative(presentation: .named)))" }
                     ?? "Offline — not synced yet")
            } else if let error = model.lastError {
                Image(systemName: "exclamationmark.circle").foregroundStyle(.red)
                Text(error)
            } else if let at = model.lastSyncedAt {
                Image(systemName: "checkmark.circle").foregroundStyle(.green)
                Text("Synced \(at.formatted(.relative(presentation: .named)))")
            } else {
                Text("Not synced yet")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}
