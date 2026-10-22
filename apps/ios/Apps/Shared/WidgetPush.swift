import Foundation
import WidgetKit
import DeckKit

/// Hands the glance widget's WidgetKit push token to deck, which pushes it a
/// reload whenever a question, a finished turn or an answer changes what it
/// shows. Called by the widget when its token changes and by the app on each
/// launch, so a token first seen while signed out still reaches deck.
enum WidgetPush {
	static func register(_ info: WidgetPushInfo?, client: DeckClient? = nil) async {
		guard let info, let client = client ?? CredentialStore.load().map({ DeckClient(credentials: $0) }) else { return }
		#if DEBUG
		let env = "development"
		#else
		let env = "production"
		#endif
		let token = info.token.map { String(format: "%02x", $0) }.joined()
		try? await client.registerAPNs(token: token, platform: "widgets", env: env)
	}
}
