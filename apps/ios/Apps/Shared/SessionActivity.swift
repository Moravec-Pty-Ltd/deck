import ActivityKit
import AppIntents
import Foundation
import DeckKit

/// The Live Activity for a running session: what the lock screen and Dynamic
/// Island show, and the button they offer. Compiled into both the app (which
/// starts and updates the activity) and the widget extension (which renders
/// it). `ContentState` mirrors the `content-state` deck pushes, key for key.
struct SessionActivityAttributes: ActivityAttributes {
	struct ContentState: Codable, Hashable {
		var status: String
		var awaitingInput: Bool
		var lastText: String
		var costUsd: Double
		var turns: Int
		var updatedAt: Double
	}

	let sessionId: String
	let title: String
	let startedAt: Date
}

/// Runs in the app's process when tapped on the card: interrupts the session's
/// turn through the same route the Stop button uses.
struct StopSessionActivityIntent: LiveActivityIntent {
	static var title: LocalizedStringResource = "Stop deck session"
	static var description = IntentDescription("Interrupts the session's current turn.")

	@Parameter(title: "Session")
	var sessionId: String

	init() {}

	init(sessionId: String) {
		self.sessionId = sessionId
	}

	func perform() async throws -> some IntentResult {
		guard let credentials = CredentialStore.load() else { return .result() }
		_ = try? await DeckClient(credentials: credentials).stop(sessionId: sessionId)
		return .result()
	}
}
