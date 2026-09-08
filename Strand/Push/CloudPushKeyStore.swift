import Foundation
import Security

/// Keychain wrapper for the FRWHOOP cloud push bearer token.
enum CloudPushKeyStore {
    private static let service = "com.noop.cloudpush"
    private static let tokenAccount = "bearer-token"

    private static var tokenQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
        ]
    }

    @discardableResult
    static func saveToken(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { clearToken(); return true }
        guard let data = trimmed.data(using: .utf8) else { return false }
        SecItemDelete(tokenQuery as CFDictionary)
        var attrs = tokenQuery
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
    }

    static func readToken() -> String? {
        var query = tokenQuery
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let str = String(data: data, encoding: .utf8),
              !str.isEmpty else { return nil }
        return str
    }

    static func clearToken() {
        SecItemDelete(tokenQuery as CFDictionary)
    }

    static var hasToken: Bool { readToken() != nil }
}
