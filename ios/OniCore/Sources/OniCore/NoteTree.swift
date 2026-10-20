import Foundation

/// The Vault as folders and Notes, for browsing.
public struct FolderNode: Identifiable, Sendable, Equatable {
    public var name: String
    /// Vault-relative folder path; empty for the root.
    public var path: String
    public var folders: [FolderNode]
    public var notes: [NoteInfo]
    public var id: String { path }

    /// Notes in this folder and every folder below it.
    public var totalNotes: Int { notes.count + folders.reduce(0) { $0 + $1.totalNotes } }
}

public enum NoteTree {
    /// "Semester 2" sorts before "Semester 10" (Finder-style), and Notes by title.
    public static func build(_ notes: [NoteInfo]) -> FolderNode {
        var root = FolderNode(name: "", path: "", folders: [], notes: [])
        for note in notes { insert(note, components: note.path.split(separator: "/").dropLast().map(String.init), into: &root, prefix: "") }
        sort(&root)
        return root
    }

    private static func insert(_ note: NoteInfo, components: [String], into node: inout FolderNode, prefix: String) {
        guard let first = components.first else {
            node.notes.append(note)
            return
        }
        let path = prefix.isEmpty ? first : prefix + "/" + first
        let rest = Array(components.dropFirst())
        if let index = node.folders.firstIndex(where: { $0.name == first }) {
            insert(note, components: rest, into: &node.folders[index], prefix: path)
        } else {
            var child = FolderNode(name: first, path: path, folders: [], notes: [])
            insert(note, components: rest, into: &child, prefix: path)
            node.folders.append(child)
        }
    }

    private static func sort(_ node: inout FolderNode) {
        node.folders.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        node.notes.sort { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
        for i in node.folders.indices { sort(&node.folders[i]) }
    }

    public static func node(at path: String, in root: FolderNode) -> FolderNode? {
        if path.isEmpty { return root }
        var current = root
        for part in path.split(separator: "/") {
            guard let next = current.folders.first(where: { $0.name == part }) else { return nil }
            current = next
        }
        return current
    }
}
