import Foundation
#if canImport(Security)
import Security
#endif

/// Keychain-backed storage for the deck server origin + shared token.
///
/// Kept in a shared access group so the share extension — a separate process
/// with its own bundle id — reaches the credentials the app signed in with.
/// `$(AppIdentifierPrefix)` resolves to the team prefix at build time, so the
/// team id stays out of the repo.
///
/// Every grouped query falls back to an ungrouped one. A target built without
/// the entitlement, or an install from before the group existed, would
/// otherwise fail outright rather than finding credentials that are sitting
/// exactly where they always were.
public enum CredentialStore {
	static let service = "tech.moravec.deck"
	static let account = "credentials"
	static let accessGroup = "$(AppIdentifierPrefix)tech.moravec.deck"

	#if canImport(Security)
	private static func query(group: Bool, extra: [String: Any] = [:]) -> [String: Any] {
		var q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account
		]
		if group { q[kSecAttrAccessGroup as String] = accessGroup }
		return q.merging(extra) { _, new in new }
	}

	/// Add-only, so the credentials the app is using are never at risk. A
	/// failure here just means the extension asks again next launch.
	private static func copyIntoGroup(_ credentials: Credentials) {
		guard let data = try? JSONEncoder().encode(credentials) else { return }
		let value: [String: Any] = [
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
			kSecValueData as String: data
		]
		SecItemAdd(query(group: true, extra: value) as CFDictionary, nil)
	}

	private static func read(_ query: [String: Any]) -> Credentials? {
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
			let data = item as? Data else { return nil }
		return try? JSONDecoder().decode(Credentials.self, from: data)
	}
	#endif

	public static func load() -> Credentials? {
		#if canImport(Security)
		let reading: [String: Any] = [
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne
		]
		if let shared = read(query(group: true, extra: reading)) { return shared }
		// Signed in before the group existed. Copy it into the group so the
		// extension finds it next time, but never by way of save(), which
		// deletes before it writes: if the write then failed for want of the
		// entitlement, that would sign the app out rather than migrate it.
		guard let legacy = read(query(group: false, extra: reading)) else { return nil }
		copyIntoGroup(legacy)
		return legacy
		#else
		return nil
		#endif
	}

	@discardableResult
	public static func save(_ credentials: Credentials) -> Bool {
		#if canImport(Security)
		guard let data = try? JSONEncoder().encode(credentials) else { return false }
		delete()
		let value: [String: Any] = [
			// Push handling and background refresh need the token after first unlock.
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
			kSecValueData as String: data
		]
		if SecItemAdd(query(group: true, extra: value) as CFDictionary, nil) == errSecSuccess { return true }
		// No entitlement for the group (an older build, or a target that doesn't
		// need sharing): keep working, ungrouped.
		return SecItemAdd(query(group: false, extra: value) as CFDictionary, nil) == errSecSuccess
		#else
		return false
		#endif
	}

	public static func delete() {
		#if canImport(Security)
		SecItemDelete(query(group: true) as CFDictionary)
		SecItemDelete(query(group: false) as CFDictionary)
		#endif
	}
}

/// Parses the URL encoded in deck's sign-in QR: `<origin>/?token=<token>`.
public enum DeckQR {
	public static func parse(_ string: String) -> Credentials? {
		guard let components = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
			let scheme = components.scheme, ["http", "https"].contains(scheme),
			let host = components.host,
			let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
			!token.isEmpty
		else { return nil }
		var origin = URLComponents()
		origin.scheme = scheme
		origin.host = host
		origin.port = components.port
		guard let baseURL = origin.url else { return nil }
		return Credentials(baseURL: baseURL, token: token)
	}
}
