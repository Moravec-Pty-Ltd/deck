import Foundation
#if canImport(Security)
import Security
#endif

/// How to reach the deck machine's SSH server. Everything but the password,
/// which lives in the keychain.
public struct TunnelSettings: Codable, Equatable, Sendable {
	public var host: String
	public var port: Int
	public var username: String
	/// The loopback port the SOCKS5 listener binds, or 0 to take any free one.
	///
	/// 0 by default, because only this app ever connects to it and a fixed
	/// number is a clash waiting to happen: the prototype this came from ships
	/// on the same phone, defaults to 1080 and connects on launch, so deck
	/// asking for 1080 too lost the race and failed to bind.
	public var localPort: Int
	public var autoConnect: Bool

	public init(host: String = "", port: Int = 22, username: String = "", localPort: Int = 0, autoConnect: Bool = true) {
		self.host = host
		self.port = port
		self.username = username
		self.localPort = localPort
		self.autoConnect = autoConnect
	}

	public var isComplete: Bool {
		!host.trimmingCharacters(in: .whitespaces).isEmpty
			&& !username.trimmingCharacters(in: .whitespaces).isEmpty
			&& port > 0
			&& localPort >= 0
	}

	static let defaultsKey = "deck.browser.tunnel"

	public static func load(from defaults: UserDefaults = .standard) -> TunnelSettings {
		guard let data = defaults.data(forKey: defaultsKey),
			var settings = try? JSONDecoder().decode(TunnelSettings.self, from: data)
		else { return TunnelSettings() }
		// 1080 was the old default rather than anyone's choice, and it is the
		// one number known to clash. Anything else was typed on purpose.
		if settings.localPort == 1080 { settings.localPort = 0 }
		return settings
	}

	public func save(to defaults: UserDefaults = .standard) {
		guard let data = try? JSONEncoder().encode(self) else { return }
		defaults.set(data, forKey: Self.defaultsKey)
	}

	/// Start the form off pointing at the machine deck itself is on, which is
	/// the machine the dev servers run on and so nearly always the right answer.
	/// The port and user still have to be filled in, because the deck origin
	/// says nothing about either.
	public func defaulting(toHostOf url: URL?) -> TunnelSettings {
		guard host.isEmpty, let inferred = url?.host, !inferred.isEmpty else { return self }
		var copy = self
		copy.host = inferred
		return copy
	}
}

/// The SSH password, kept out of UserDefaults.
///
/// Separate from DeckKit's `CredentialStore` on purpose. That one lives in a
/// shared access group so the share extension can read the deck token; nothing
/// outside the app has any business with this, so it stays ungrouped.
public enum TunnelSecret {
	static let service = "tech.moravec.deck.browser"
	static let account = "ssh-password"

	#if canImport(Security)
	private static func query(_ extra: [String: Any] = [:]) -> [String: Any] {
		let base: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account
		]
		return base.merging(extra) { _, new in new }
	}
	#endif

	public static func load() -> String {
		#if canImport(Security)
		var item: CFTypeRef?
		let reading: [String: Any] = [
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne
		]
		guard SecItemCopyMatching(query(reading) as CFDictionary, &item) == errSecSuccess,
			let data = item as? Data
		else { return "" }
		return String(data: data, encoding: .utf8) ?? ""
		#else
		return ""
		#endif
	}

	public static func save(_ password: String) {
		#if canImport(Security)
		SecItemDelete(query() as CFDictionary)
		guard !password.isEmpty else { return }
		let value: [String: Any] = [
			// The tunnel reconnects when the app comes back to the foreground, so
			// the password has to be readable without the device being unlocked
			// again right then.
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
			kSecValueData as String: Data(password.utf8)
		]
		SecItemAdd(query(value) as CFDictionary, nil)
		#endif
	}
}
