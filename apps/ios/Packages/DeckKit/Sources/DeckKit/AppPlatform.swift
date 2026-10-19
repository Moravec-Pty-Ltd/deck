import Foundation

/// Which system the app is running on, for the words a message uses: an iOS
/// requirement read on a Mac, or "Settings" where the app is called System
/// Settings, sends someone looking for the wrong thing.
public enum AppPlatform: Sendable, CaseIterable {
	case iOS, macOS, watchOS

	public static var current: AppPlatform {
		#if os(macOS)
		.macOS
		#elseif os(watchOS)
		.watchOS
		#else
		.iOS
		#endif
	}

	public var systemName: String {
		switch self {
		case .iOS: "iOS"
		case .macOS: "macOS"
		case .watchOS: "watchOS"
		}
	}

	public var settingsApp: String {
		self == .macOS ? "System Settings" : "Settings"
	}

	/// Where the microphone switch for deck lives.
	public var microphoneSetting: String {
		self == .macOS ? "System Settings > Privacy & Security > Microphone" : "Settings > deck"
	}

	/// Whether the operator listens for "hey deck". The Mac has no wake word:
	/// it is push-to-talk or typed.
	public var hasWakeWord: Bool { self == .iOS }
}
