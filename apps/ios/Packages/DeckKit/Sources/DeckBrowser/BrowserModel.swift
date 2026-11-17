#if canImport(WebKit)
import DeckKit
import Foundation
import Network
import Observation
import Security
import WebKit

/// The dev browser: tabs for the dev servers running on the deck machine, and
/// the tunnel that makes them reachable from this one.
///
/// Reaching them needs a proxy on this side rather than a published origin per
/// port on deck's: the point is that any port works, including ones nobody
/// declared. See DevTunnel.
@MainActor
@Observable
public final class BrowserModel {
	public private(set) var tabs: [BrowserTab] = []
	public var selected: String?
	public private(set) var tunnelState: DevTunnel.Status = .idle
	/// One line for the status strip: the tunnel, or the last failure.
	public private(set) var status = "Not connected"
	/// The last target a request went to, which is the proof the tunnel is doing
	/// something rather than merely being up.
	public private(set) var lastForward = ""

	/// Deck, and so its dev servers, are on this machine: pages load straight
	/// from loopback and the tunnel is never used.
	public let isDirect: Bool

	/// Bumped whenever a tab's own WebKit state changes. `@Observable` cannot
	/// see inside the runtime objects, so this is what views read to re-render.
	public private(set) var revision = 0

	let tunnel: DevTunnel
	private let config: DevTunnel.Config?
	private var runtimes: [String: BrowserTabRuntime] = [:]

	/// `sessionId` routes the tunnel through that session's host when it runs
	/// on a remote one; nil is the deck machine itself.
	public init(credentials: Credentials?, sessionId: String? = nil) {
		_ = Self.forgetSSHTunnel
		self.config = credentials.map { DevTunnel.Config(credentials: $0, sessionId: sessionId) }
		self.tunnel = DevTunnel.shared(for: sessionId)
		self.isDirect = LoopbackHost.isDirect(deckOrigin: credentials?.baseURL)
		if isDirect {
			status = "Direct: deck runs on this machine"
			return
		}
		wire()
		// It may already be up, from a browser opened earlier. No runtimes exist
		// yet, so they will be built against this state rather than rebuilt.
		adopt(tunnel.status)
	}

	/// What the SSH tunnel this replaced left behind: its settings, its trusted
	/// host keys and the password in the keychain. Once per launch, and a no-op
	/// once they are gone.
	private static let forgetSSHTunnel: Void = {
		UserDefaults.standard.removeObject(forKey: "deck.browser.tunnel")
		UserDefaults.standard.removeObject(forKey: "deck.browser.knownHosts")
		SecItemDelete(
			[
				kSecClass as String: kSecClassGenericPassword,
				kSecAttrService as String: "tech.moravec.deck.browser",
				kSecAttrAccount as String: "ssh-password"
			] as CFDictionary)
	}()

	// MARK: Tabs

	/// Fold a fresh server list in. Called on appear and on every poll, so it
	/// must not disturb a tab you are reading or one you opened yourself.
	public func refresh(servers: [ServerRuntime]) {
		tabs = BrowserTabs.merge(current: tabs, servers: servers)
		let live = Set(tabs.map(\.id))
		runtimes = runtimes.filter { live.contains($0.key) }
		if selected == nil || !live.contains(selected!) { selected = tabs.first?.id }
	}

	public func open(_ url: String = "") {
		let tab = BrowserTabs.opened(url)
		tabs.append(tab)
		selected = tab.id
	}

	/// Show this address. Prefers the tab already open on that port, so tapping
	/// a server's preview link lands on its tab rather than opening a second
	/// one, and falls back to a new tab for an address no server declared.
	public func focus(on address: String) {
		let wanted = URLComponents(string: address)?.port
		let match =
			tabs.first { $0.url == address }
			?? tabs.first { wanted != nil && $0.port == wanted }
		if let match {
			selected = match.id
		} else {
			open(address)
		}
	}

	public func close(_ id: String) {
		tabs.removeAll { $0.id == id }
		runtimes[id] = nil
		if selected == id { selected = tabs.first?.id }
	}

	public var current: BrowserTab? {
		tabs.first { $0.id == selected }
	}

	/// The web view for a tab, made on first use so a tab that is never opened
	/// never loads. Its first load is the tab's URL.
	public func webView(for tab: BrowserTab) -> WKWebView {
		runtime(for: tab).webView
	}

	public func address(for tab: BrowserTab) -> String {
		let runtime = runtime(for: tab)
		return runtime.address.isEmpty ? tab.url : runtime.address
	}

	public func failure(for tab: BrowserTab) -> String? { runtime(for: tab).failure }
	public func isLoading(for tab: BrowserTab) -> Bool { runtime(for: tab).isLoading }
	public func canGoBack(_ tab: BrowserTab) -> Bool { runtime(for: tab).canGoBack }
	public func canGoForward(_ tab: BrowserTab) -> Bool { runtime(for: tab).canGoForward }

	public func load(_ text: String, in tab: BrowserTab) {
		runtime(for: tab).load(text)
		if let index = tabs.firstIndex(where: { $0.id == tab.id }) {
			tabs[index].url = text
			if !tabs[index].isDerived { tabs[index].title = BrowserTabs.title(for: text) }
		}
	}

	public func reload(_ tab: BrowserTab) { runtime(for: tab).reload() }
	public func stop(_ tab: BrowserTab) { runtime(for: tab).stop() }
	public func progress(for tab: BrowserTab) -> Double { runtime(for: tab).progress }
	public func goBack(_ tab: BrowserTab) { runtime(for: tab).goBack() }
	public func goForward(_ tab: BrowserTab) { runtime(for: tab).goForward() }

	private func runtime(for tab: BrowserTab) -> BrowserTabRuntime {
		if let existing = runtimes[tab.id] { return existing }
		let fresh = BrowserTabRuntime(
			id: tab.id,
			proxy: proxy,
			tunnelled: proxy != nil,
			onChange: { [weak self] in self?.revision += 1 })
		runtimes[tab.id] = fresh
		if !tab.url.isEmpty { fresh.load(tab.url) }
		return fresh
	}

	// MARK: Tunnel

	public var isConnected: Bool { proxyPort != nil }

	private var proxyPort: Int? {
		if case .connected(let localPort) = tunnelState { return localPort }
		return nil
	}

	private var proxy: ProxyConfiguration? {
		guard let localPort = proxyPort, let port = NWEndpoint.Port(rawValue: UInt16(localPort))
		else { return nil }
		// Only the sentinel goes through deck. A dev page's CDN scripts and fonts
		// load directly, since the tunnel refuses anything but loopback.
		var config = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))
		config.matchDomains = [LoopbackHost.sentinel]
		return config
	}

	/// Bring the listener up, or rebind it. Called on open and on every return
	/// to the foreground, since iOS reclaims listening sockets while suspended.
	public func connect() {
		guard !isDirect, let config else { return }
		if case .connecting = tunnelState { return }
		Task { await tunnel.start(config) }
	}

	private func wire() {
		tunnel.onStatus = { [weak self] state in self?.apply(state) }
		tunnel.onForward = { [weak self] host, port in
			self?.lastForward = "\(LoopbackHost.display(host)):\(port)"
		}
		tunnel.onForwardError = { [weak self] reason in self?.status = "Forward refused: \(reason)" }
	}

	/// Take on a tunnel state without acting on it. Used at init to inherit a
	/// tunnel that is already up, where rebuilding tabs that do not exist yet
	/// would be wrong.
	private func adopt(_ state: DevTunnel.Status) {
		tunnelState = state
		switch state {
		case .idle: status = "Not connected"
		case .connecting: status = "Connecting"
		case .connected(let port): status = "Tunnel on 127.0.0.1:\(port)"
		case .failed(let reason): status = reason
		}
	}

	private func apply(_ state: DevTunnel.Status) {
		let was = proxyPort
		adopt(state)
		// Only a proxy change costs a rebuild. A rebind onto the same port, or
		// going from connecting to failed, must not reload every tab.
		if was != proxyPort { rebuildTabs() }
	}

	private func rebuildTabs() {
		let tunnelled = proxy != nil
		for runtime in runtimes.values { runtime.rebuild(proxy: proxy, tunnelled: tunnelled) }
	}
}
#endif
