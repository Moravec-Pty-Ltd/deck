import Foundation
import WatchConnectivity
import DeckKit

/// Receives the shared token + server origin pushed from the iPhone app via
/// WatchConnectivity's application context, so the watch never needs its own
/// QR/pairing flow. Re-activated at app start regardless of sign-in state so
/// re-syncs and token rotations from the phone always apply.
@MainActor
final class PhoneSync: NSObject, WCSessionDelegate {
	private let store: DeckStore

	init(store: DeckStore) {
		self.store = store
		super.init()
	}

	func activate() {
		guard WCSession.isSupported() else { return }
		let session = WCSession.default
		session.delegate = self
		session.activate()
	}

	nonisolated func session(
		_ session: WCSession,
		activationDidCompleteWith activationState: WCSessionActivationState,
		error: Error?
	) {
		guard activationState == .activated else { return }
		// Context delivered before activation completed isn't redelivered via
		// the didReceive callback, so pick it up explicitly here too.
		let context = session.receivedApplicationContext
		Task { @MainActor [weak self] in
			self?.apply(context)
			self?.requestCredentialsIfNeeded(session)
		}
	}

	nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
		Task { @MainActor [weak self] in
			self?.apply(applicationContext)
		}
	}

	nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
		Task { @MainActor [weak self] in
			self?.requestCredentialsIfNeeded(session)
		}
	}

	// If the phone signed in before this watch app was installed, no context was
	// ever staged for us. Ask the phone directly once it is reachable.
	private func requestCredentialsIfNeeded(_ session: WCSession) {
		guard store.client == nil, session.isReachable else { return }
		session.sendMessage(
			["request": "credentials"],
			replyHandler: { reply in
				Task { @MainActor [weak self] in self?.apply(reply) }
			},
			errorHandler: { _ in })
	}

	private func apply(_ context: [String: Any]) {
		guard let baseURLString = context["baseURL"] as? String,
			let baseURL = URL(string: baseURLString),
			let token = context["token"] as? String, !token.isEmpty
		else { return }
		let credentials = Credentials(baseURL: baseURL, token: token)
		guard store.client?.credentials != credentials else { return }
		store.signIn(credentials)
	}
}
