import ActivityKit
import AppIntents
import Foundation
import DeckKit

/// The Live Activity for a running session: what the lock screen and Dynamic
/// Island show, and the button they offer. Compiled into both the app (which
/// starts and updates the activity) and the widget extension (which renders
/// it). The attributes and content state live in DeckKit.
extension SessionActivityAttributes: @retroactive ActivityAttributes {}

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
