import Foundation

/// Vault-relative Note paths. The rules mirror `assistant/vault_sync.py`'s
/// `_clean_rel` so a path the phone would never send is also one it refuses
/// to write locally — a buggy or hostile server must not be able to place a
/// file outside the Replica.
public enum NotePath {
    /// Folders that exist on the Mac but are never part of the Replica.
    public static let reservedFolders: Set<String> = ["_conflicts", "_trash"]

    public static func isValid(_ path: String) -> Bool {
        guard !path.isEmpty, !path.contains("\0"), !path.contains("\\"),
              !path.hasPrefix("/"), path.hasSuffix(".md") else { return false }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        for part in parts {
            if part.isEmpty || part == "." || part == ".." || part.hasPrefix(".") { return false }
        }
        return !(parts.first.map { reservedFolders.contains(String($0)) } ?? false)
    }

    /// The first path component for a Note inside a folder, `nil` for a Note
    /// at the Vault root (root Notes are always synced; they have no switch).
    public static func topLevelFolder(of path: String) -> String? {
        guard let slash = path.firstIndex(of: "/") else { return nil }
        return String(path[..<slash])
    }

    public static func title(of path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name.hasSuffix(".md") ? String(name.dropLast(3)) : name
    }
}
