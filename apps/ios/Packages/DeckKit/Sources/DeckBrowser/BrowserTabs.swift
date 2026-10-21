import Foundation
import DeckKit

/// One tab in the dev browser.
///
/// `port` separates the two kinds. A tab derived from a dev server's declared
/// port carries it, and keeps its identity across refreshes so polling the
/// server list never reloads the page you are looking at. A tab you opened by
/// hand has no port and is never touched by a refresh.
public struct BrowserTab: Identifiable, Hashable, Sendable {
	public let id: String
	public var title: String
	public var url: String
	/// False greys the tab: the port is declared but nothing is answering yet.
	public var listening: Bool
	public var port: Int?

	public var isDerived: Bool { port != nil }
}

/// Builds the tab strip from what deck already knows. A session's dev config
/// declares its ports with labels, and the live view says which are listening,
/// so the browser opens the right tabs without being told.
public enum BrowserTabs {
	/// Server states that get tabs. The same rule deck's web UI uses to decide
	/// whether to show a preview link at all: running, or running and since
	/// gone quiet, but not starting, stopped, dead or errored.
	public static let previewable: Set<String> = ["running", "stalled"]

	public static func derived(from servers: [ServerRuntime]) -> [BrowserTab] {
		var tabs: [BrowserTab] = []
		var seen: Set<Int> = []
		for server in servers where previewable.contains(server.state) {
			for port in ordered(server.ports ?? []) where !seen.contains(port.port) {
				seen.insert(port.port)
				tabs.append(
					BrowserTab(
						id: "port:\(port.port)",
						title: port.label ?? ":\(port.port)",
						url: url(for: port, of: server),
						listening: port.listening ?? false,
						port: port.port
					))
			}
		}
		return tabs
	}

	/// A tab the user asked for. Empty opens with nothing loaded, so the address
	/// bar is the next thing they touch.
	public static func opened(_ url: String = "") -> BrowserTab {
		BrowserTab(id: "tab:\(UUID().uuidString)", title: title(for: url), url: url, listening: true, port: nil)
	}

	/// Fold a fresh server list into the tabs already on screen.
	///
	/// A derived tab keeps the URL it is currently showing, because the user may
	/// have navigated inside the app since it opened, and takes the fresh label
	/// and listening state. A port that has appeared gets a new tab; a port that
	/// has left the list loses its tab. Hand-opened tabs come through untouched,
	/// after the derived ones.
	public static func merge(current: [BrowserTab], servers: [ServerRuntime]) -> [BrowserTab] {
		let existing = Dictionary(
			current.filter(\.isDerived).map { ($0.id, $0) },
			uniquingKeysWith: { first, _ in first })
		var merged = derived(from: servers).map { fresh -> BrowserTab in
			guard var kept = existing[fresh.id] else { return fresh }
			kept.title = fresh.title
			kept.listening = fresh.listening
			if kept.url.isEmpty { kept.url = fresh.url }
			return kept
		}
		merged.append(contentsOf: current.filter { !$0.isDerived })
		return merged
	}

	/// The primary port first, then the rest in the order the project declared
	/// them. `primary` is what deck's own preview link follows, so the front tab
	/// is the one the dev config calls the main one.
	private static func ordered(_ ports: [PortStatus]) -> [PortStatus] {
		let primary = ports.filter { $0.primary == true }
		return primary.isEmpty ? ports : primary + ports.filter { $0.primary != true }
	}

	/// Prefer the URL deck captured from the server's own output for its primary
	/// port: a dev server that prints where it is listening knows better than we
	/// do. Every other port is synthesised.
	private static func url(for port: PortStatus, of server: ServerRuntime) -> String {
		let isPrimary = port.primary == true || server.ports?.first?.port == port.port
		if isPrimary, let preview = server.previewUrl, !preview.isEmpty { return preview }
		return "http://localhost:\(port.port)"
	}

	/// Host and port of whatever is loaded, which is what identifies a tab to a
	/// developer. Falls back to the raw text, then to a placeholder.
	static func title(for url: String) -> String {
		guard !url.isEmpty else { return "New tab" }
		guard let components = URLComponents(string: url), let host = components.host else { return url }
		let shown = LoopbackHost.display(host)
		return components.port.map { "\(shown):\($0)" } ?? shown
	}
}
