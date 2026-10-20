import DeckKit
import Foundation

/// The dev servers a browser shows tabs for, shared by the phone and Mac views.
@MainActor
public enum BrowserServers {
	/// One session's servers, or with no session every session's. Nil when the
	/// server cannot say, so a failed poll leaves the tabs as they were.
	public static func current(store: DeckStore, sessionId: String?) async -> [ServerRuntime]? {
		guard let client = store.client, store.supports(.servers) else { return nil }
		if let sessionId { return try? await client.servers(sessionId: sessionId) }

		// Across every session: one call says which have anything running, and
		// only those are asked for their ports. A port can only be listening
		// once on the machine, so the union needs no reconciling.
		guard let states = try? await client.serverStates() else { return nil }
		let live = states.filter { $0.value.contains(where: BrowserTabs.previewable.contains) }.keys
		var all: [ServerRuntime] = []
		for id in live {
			if let servers = try? await client.servers(sessionId: id) { all.append(contentsOf: servers) }
		}
		return all
	}
}
