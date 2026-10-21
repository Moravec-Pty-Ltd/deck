import Foundation
import WatchConnectivity
import DeckKit

/// Pushes the signed-in credentials to the paired watch via application
/// context so DeckWatch can adopt them without its own QR/sign-in flow.
@MainActor
final class WatchSync: NSObject, WCSessionDelegate {
	private weak var store: DeckStore?

	func activate(store: DeckStore) {
		self.store = store
		guard WCSession.isSupported() else { return }
		let session = WCSession.default
		session.delegate = self
		session.activate()
	}

	func sync() {
		guard WCSession.isSupported(),
			WCSession.default.activationState == .activated,
			let payload = credentialsPayload() else { return }
		try? WCSession.default.updateApplicationContext(payload)
	}

	private func credentialsPayload() -> [String: Any]? {
		guard let client = store?.client else { return nil }
		return [
			"baseURL": client.credentials.baseURL.absoluteString,
			"token": client.credentials.token
		]
	}

	nonisolated func session(
		_ session: WCSession,
		activationDidCompleteWith activationState: WCSessionActivationState,
		error: Error?
	) {
		Task { @MainActor in self.sync() }
	}

	// The watch app can be installed/paired after this app already signed in;
	// re-push credentials whenever the watch state or reachability changes so a
	// freshly installed watch app picks them up.
	nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
		Task { @MainActor in self.sync() }
	}

	nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
		Task { @MainActor in self.sync() }
	}

	// The watch asks for credentials on its first launch; answer directly and
	// also stage them via application context.
	nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
		Task { @MainActor in self.sync() }
	}

	nonisolated func session(
		_ session: WCSession,
		didReceiveMessage message: [String: Any],
		replyHandler: @escaping ([String: Any]) -> Void
	) {
		Task { @MainActor in
			self.sync()
			replyHandler(self.credentialsPayload() ?? [:])
		}
	}

	nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

	nonisolated func sessionDidDeactivate(_ session: WCSession) {
		session.activate()
	}
}
