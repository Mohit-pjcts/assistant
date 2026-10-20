import OniCore
import SwiftUI

struct NoteView: View {
    let path: String
    @Environment(AppModel.self) private var model
    @Environment(Navigator.self) private var nav
    @State private var text: String?
    @State private var blocks: [MDBlock] = []
    @State private var properties: [NoteProperty] = []
    @State private var backlinks: [NoteInfo] = []
    @State private var oniAuthored = false
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var missingLink: String?
    @State private var error: String?

    var body: some View {
        Group {
            if let text {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if oniAuthored || !properties.isEmpty { propertiesView }
                        MarkdownView(blocks: blocks)
                        if !backlinks.isEmpty { backlinksView }
                    }
                    .padding(16)
                    .textSelection(.enabled)
                }
                .id(text.count)  // jump to the top when the content changes under us
            } else {
                ContentUnavailableView("Note not found", systemImage: "doc.questionmark",
                                       description: Text("It may have been deleted or its folder switched off."))
            }
        }
        .navigationTitle(NotePath.title(of: path))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if text != nil {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { editing = true } label: { Label("Edit", systemImage: "pencil") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            guard let link = WikiLinks.parse(url: url) else { return .systemAction }
            if let target = model.index.resolve(link.target) {
                nav.path.append(.note(target))
            } else {
                missingLink = link.target
            }
            return .handled
        })
        .task(id: model.revision) { await load() }
        .sheet(isPresented: $editing) {
            NoteEditor(path: path, initial: text ?? "")
        }
        .confirmationDialog("Delete this note?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    do {
                        try await model.deleteNote(path: path)
                        nav.path.removeAll { $0 == .note(path) }
                    } catch { self.error = AppModel.describe(error) }
                }
            }
        } message: {
            Text("It moves to the Vault's _trash folder on the Mac, where you can restore it from Settings.")
        }
        .alert("No such note", isPresented: Binding(get: { missingLink != nil }, set: { if !$0 { missingLink = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("There's no note called “\(missingLink ?? "")” on this iPhone.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }

    private var propertiesView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if oniAuthored {
                Label("Written by Oni", systemImage: "sparkles").font(.caption).foregroundStyle(.tint)
            }
            ForEach(properties.filter { $0.key != "oni" }, id: \.key) { property in
                HStack(alignment: .firstTextBaseline) {
                    Text(property.key).foregroundStyle(.secondary)
                    Text(property.value)
                }
                .font(.caption)
            }
        }
    }

    private var backlinksView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Linked from").font(.footnote).foregroundStyle(.secondary)
            ForEach(backlinks) { note in
                Button(note.title) { nav.path.append(.note(note.path)) }
                    .font(.subheadline)
            }
        }
    }

    private func load() async {
        let fresh = model.text(of: path)
        text = fresh
        guard let fresh else { return }
        let index = model.index
        let path = self.path
        let parsed = await Task.detached {
            (MarkdownBlocks.parse(note: fresh), Frontmatter.properties(in: fresh),
             Frontmatter.isOniAuthored(fresh), index.backlinks(to: path))
        }.value
        (blocks, properties, oniAuthored, backlinks) = parsed
    }
}

struct NoteEditor: View {
    let path: String
    let initial: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            TextEditor(text: $draft)
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 8)
                .autocorrectionDisabled()
                .navigationTitle(NotePath.title(of: path))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            Task {
                                do {
                                    try await model.saveNote(path: path, text: draft)
                                    dismiss()
                                } catch { self.error = AppModel.describe(error) }
                            }
                        }
                        .disabled(draft == initial)
                    }
                }
        }
        .onAppear { draft = initial }
        .interactiveDismissDisabled(draft != initial)
        .alert("Couldn't save", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
    }
}
