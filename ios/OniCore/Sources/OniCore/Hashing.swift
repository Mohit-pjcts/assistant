import CryptoKit
import Foundation

/// Lower-case hex SHA-256 — the identity of a Note's exact bytes. The Mac
/// decides conflicts by comparing these, never timestamps.
public func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { byte in
        let hex = String(byte, radix: 16)
        return hex.count == 1 ? "0" + hex : hex
    }.joined()
}

public func sha256Hex(_ text: String) -> String {
    sha256Hex(Data(text.utf8))
}
