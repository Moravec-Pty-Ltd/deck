import Foundation

/// Reads a session id out of the links deck hands the app: a push's
/// `http://host/s/<id>` and a Live Activity's `deck://s/<id>`.
public enum DeckLink {
	/// The id only when `s` is the path's first segment, so a run's
	/// `/runs/<id>/s/<sid>` or any other nested `s` is not taken for a session.
	public static func sessionId(from urlString: String) -> String? {
		guard let components = URLComponents(string: urlString) else { return nil }
		var parts = components.path.split(separator: "/").map(String.init)
		// deck://s/<id> parses with `s` as the host, not part of the path.
		if components.scheme == "deck" {
			guard let host = components.host else { return nil }
			parts.insert(host, at: 0)
		}
		guard parts.count >= 2, parts[0] == "s", !parts[1].isEmpty else { return nil }
		return parts[1]
	}

	public static func sessionId(from url: URL) -> String? {
		sessionId(from: url.absoluteString)
	}
}

extension Notification.Name {
	/// Open a session (object: its id) or a run (object: its id) in whichever
	/// window is listening: posted by a notification tap, a link or a schedule.
	public static let deckOpenSession = Notification.Name("deck.openSession")
	public static let deckOpenRun = Notification.Name("deck.openRun")
}
