import Foundation
import Security

/// Secrets live in the iPhone Keychain, never in UserDefaults or a file in the
/// app's container (ADR 0004). `ThisDeviceOnly`: not synced to iCloud, not
/// restored onto another device from a backup.
enum Keychain {
    private static let service = "dev.mohitvuyyuru.oni"

    enum Account: String {
        case vaultToken = "vault-token"
        case anthropicKey = "anthropic-key"
    }

    static func get(_ account: Account) -> String? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func set(_ value: String, for account: Account) -> Bool {
        delete(account)
        var item = base(account)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: Account) {
        SecItemDelete(base(account) as CFDictionary)
    }

    private static func base(_ account: Account) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account.rawValue]
    }
}
