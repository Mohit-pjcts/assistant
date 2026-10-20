import OniCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false
    @State private var error: String?

    var body: some View {
        List {
            Section("Sync") {
                LabeledContent("Mac", value: model.baseURL?.host() ?? "—")
                LabeledContent("Notes on this iPhone", value: "\(model.index.count)")
                SyncStatusRow()
                Button {
                    Task { await model.sync() }
                } label: {
                    Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(model.isSyncing)
                if !model.syncFailures.isEmpty {
                    DisclosureGroup("\(model.syncFailures.count) note\(model.syncFailures.count == 1 ? "" : "s") couldn't sync") {
                        ForEach(model.syncFailures, id: \.path) { failure in
                            VStack(alignment: .leading) {
                                Text(failure.path).font(.caption)
                                Text(failure.message).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            Section {
                NavigationLink(value: Route.conflicts) {
                    HStack {
                        Label("Conflicts", systemImage: "exclamationmark.triangle")
                        Spacer()
                        if !model.conflicts.isEmpty {
                            Text("\(model.conflicts.count)").foregroundStyle(.orange)
                        }
                    }
                }
                NavigationLink(value: Route.trash) {
                    Label("Trash", systemImage: "trash")
                }
            }

            Section {
                ForEach(model.folders) { folder in
                    Toggle(folder.name, isOn: Binding(
                        get: { folder.enabled },
                        set: { on in Task { await set(folder.name, on) } }))
                }
            } header: {
                Text("Folders on this iPhone")
            } footer: {
                Text("Turn a folder off to keep it only on the Mac. Switching one off removes its notes from this iPhone after they've synced.")
            }

            Section {
                Button("Disconnect and delete the copy on this iPhone", role: .destructive) {
                    confirmUnpair = true
                }
            } footer: {
                Text("The Vault on the Mac is not touched.")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Delete the Vault copy from this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Disconnect and delete", role: .destructive) { Task { await model.unpair() } }
        } message: {
            Text("Any changes that haven't synced to the Mac yet will be lost.")
        }
        .alert("Can't change that folder", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }

    private func set(_ name: String, _ enabled: Bool) async {
        do { try await model.setFolder(name, enabled: enabled) }
        catch { self.error = AppModel.describe(error) }
    }
}

/// A Note edited on both sides: the phone's version is kept as a Conflict copy
/// and the Mac's is the Note. The user picks which survives.
struct ConflictsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            if model.conflicts.isEmpty {
                ContentUnavailableView("No conflicts", systemImage: "checkmark.circle",
                                       description: Text("Nothing was edited on both the iPhone and the Mac."))
                    .listRowBackground(Color.clear)
            }
            ForEach(model.conflicts) { record in
                NavigationLink {
                    ConflictDetail(record: record)
                } label: {
                    VStack(alignment: .leading) {
                        Text(NotePath.title(of: record.originalPath))
                        Text(record.createdAt.formatted(.relative(presentation: .named)))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Conflicts")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ConflictDetail: View {
    let record: ConflictRecord
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?

    private var phoneText: String {
        model.replica.conflictCopy(id: record.id).flatMap { String(data: $0, encoding: .utf8) } ?? "(copy not available)"
    }

    var body: some View {
        List {
            Section {
                Text("You and the Mac both changed this note. Choose which version to keep. Nothing was thrown away.")
                    .font(.subheadline)
            }
            Section("On the Mac (now the note)") {
                Text(model.text(of: record.originalPath) ?? "(missing)")
                    .font(.system(.footnote, design: .monospaced)).lineLimit(30)
            }
            Section("From this iPhone") {
                Text(phoneText).font(.system(.footnote, design: .monospaced)).lineLimit(30)
            }
            Section {
                Button("Keep the Mac version") { resolve { try await model.resolveKeepingMac(record.id) } }
                Button("Keep the iPhone version") { resolve { try await model.resolveKeepingPhone(record.id) } }
            }
        }
        .navigationTitle(NotePath.title(of: record.originalPath))
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn't resolve", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }

    private func resolve(_ action: @escaping () async throws -> Void) {
        Task {
            do { try await action(); dismiss() }
            catch { self.error = AppModel.describe(error) }
        }
    }
}

/// Notes deleted from the iPhone (or the Mac's Oni) wait here until restored or emptied.
struct TrashView: View {
    @Environment(AppModel.self) private var model
    @State private var items: [StoredCopy] = []
    @State private var loaded = false
    @State private var offline = false
    @State private var confirmEmpty = false
    @State private var error: String?

    var body: some View {
        List {
            if offline {
                Label("The Mac isn't reachable.", systemImage: "icloud.slash").foregroundStyle(.orange)
            } else if loaded && items.isEmpty {
                ContentUnavailableView("Trash is empty", systemImage: "trash")
                    .listRowBackground(Color.clear)
            }
            ForEach(items, id: \.path) { item in
                HStack {
                    VStack(alignment: .leading) {
                        Text(NotePath.title(of: item.originalPath ?? item.path))
                        if let original = item.originalPath {
                            Text(original).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Restore") { restore(item) }.buttonStyle(.bordered)
                }
            }
        }
        .navigationTitle("Trash")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !items.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Button("Empty", role: .destructive) { confirmEmpty = true }
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Permanently delete everything in the Trash?", isPresented: $confirmEmpty, titleVisibility: .visible) {
            Button("Empty Trash", role: .destructive) {
                Task {
                    do { _ = try await model.server?.emptyTrash(); await load() }
                    catch { self.error = AppModel.describe(error) }
                }
            }
        } message: {
            Text("This can't be undone.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }

    private func load() async {
        guard let server = model.server else { return }
        do {
            items = try await server.listTrash()
            offline = false
        } catch {
            offline = true
        }
        loaded = true
    }

    private func restore(_ item: StoredCopy) {
        Task {
            do {
                _ = try await model.server?.restoreFromTrash(path: item.path)
                await model.sync()
                await load()
            } catch { self.error = AppModel.describe(error) }
        }
    }
}
