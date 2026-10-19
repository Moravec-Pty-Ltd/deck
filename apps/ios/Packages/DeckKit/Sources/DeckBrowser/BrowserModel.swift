#if canImport(WebKit)
import DeckKit
import Foundation
import Network
import Observation
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

	public var settings: TunnelSettings
	public var password: String

	/// Bumped whenever a tab's own WebKit state changes. `@Observable` cannot
	/// see inside the runtime objects, so this is what views read to re-render.
	public private(set) var revision = 0

	let tunnel: DevTunnel
	private var runtimes: [String: BrowserTabRuntime] = [:]
	private let defaults: UserDefaults

	/// The user wants the tunnel up, so a drop should be retried. Cleared by an
	/// explicit disconnect and by an auth failure, which retrying cannot fix.
	private var wantConnected = false
	private var reconnectAttempt = 0
	private var reconnectTask: Task<Void, Never>?

	public init(deckOrigin: URL?, defaults: UserDefaults = .standard) {
		self.defaults = defaults
		self.settings = TunnelSettings.load(from: defaults).defaulting(toHostOf: deckOrigin)
		self.password = TunnelSecret.load()
		// The app's one tunnel, not one of our own: tabs are per session, but the
		// SSH connection and its loopback port are per machine, and a second one
		// cannot bind a port the first is holding.
		self.tunnel = DevTunnel.shared
		wire()
		// It may already be up, from a browser opened earlier. No runtimes exist
		// yet, so they will be built against this state rather than rebuilt.
		adopt(tunnel.status)
	}

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

	public var isConnected: Bool {
		if case .connected = tunnelState { return true }
		return false
	}

	private var proxy: ProxyConfiguration? {
		guard case .connected(let localPort) = tunnelState,
			let port = NWEndpoint.Port(rawValue: UInt16(localPort))
		else { return nil }
		return ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))
	}

	public func connect() {
		guard let config = config() else {
			status = "Fill in the host, user and password first"
			return
		}
		// Tapping Connect while one is already in flight would queue a second
		// attempt behind it rather than doing anything useful.
		if case .connecting = tunnelState { return }
		settings.save(to: defaults)
		TunnelSecret.save(password)
		wantConnected = true
		reconnectAttempt = 0
		reconnectTask?.cancel()
		Task { await tunnel.start(config) }
	}

	public func disconnect() {
		wantConnected = false
		reconnectTask?.cancel()
		reconnectTask = nil
		Task { await tunnel.stop() }
	}

	/// iOS suspends sockets in the background, so coming back to the foreground
	/// usually means the tunnel needs re-establishing.
	public func reconnectIfNeeded() {
		guard wantConnected, settings.autoConnect else { return }
		switch tunnelState {
		case .connected, .connecting: return
		default: break
		}
		reconnectAttempt = 0
		reconnectTask?.cancel()
		if let config = config() { Task { await tunnel.start(config) } }
	}

	/// Accept the machine's current host key, then reconnect. The way out of a
	/// mismatch you know the reason for, like a rebuilt machine.
	public func forgetHostKey() {
		guard let config = config() else { return }
		tunnel.forgetHostKey(config)
		connect()
	}

	/// Bring the tunnel up on open when it has worked before, so the browser is
	/// usable without visiting a form first.
	public func connectIfConfigured() {
		guard settings.autoConnect, config() != nil else { return }
		switch tunnelState {
		case .connected, .connecting: return
		default: connect()
		}
	}

	private func config() -> DevTunnel.Config? {
		DevTunnel.Config(settings: settings, password: password)
	}

	private func wire() {
		tunnel.onStatus = { [weak self] state in self?.apply(state) }
		tunnel.onForward = { [weak self] host, port in
			self?.lastForward = "\(LoopbackHost.display(host)):\(port)"
		}
		tunnel.onForwardError = { [weak self] reason in self?.status = "Forward refused: \(reason)" }
	}

	/// Take on a tunnel state without acting on it. Used at init to inherit a
	/// tunnel that is already up, where scheduling a retry or rebuilding tabs
	/// that do not exist yet would be wrong.
	private func adopt(_ state: DevTunnel.Status) {
		tunnelState = state
		switch state {
		case .idle: status = "Not connected"
		case .connecting: status = "Connecting"
		case .connected(let port):
			status = "Tunnel on 127.0.0.1:\(port)"
			// Inheriting a live tunnel means inheriting the intent to keep it up.
			wantConnected = true
		case .failed(let reason): status = reason
		}
	}

	private func apply(_ state: DevTunnel.Status) {
		let was = proxy
		adopt(state)
		switch state {
		case .connected:
			reconnectAttempt = 0
			reconnectTask?.cancel()
		case .failed(let reason):
			scheduleReconnect(after: reason)
		default:
			break
		}
		// Only a proxy change costs a rebuild. Going from connecting to failed
		// leaves it nil both times and must not reload every tab.
		if (was == nil) != (proxy == nil) { rebuildTabs() }
	}

	private func rebuildTabs() {
		let tunnelled = proxy != nil
		for runtime in runtimes.values { runtime.rebuild(proxy: proxy, tunnelled: tunnelled) }
	}

	/// Back off on an unexpected drop. An auth or host-key failure stops
	/// retrying: both need something fixed first, and hammering would only
	/// repeat the rejection.
	private func scheduleReconnect(after reason: String) {
		guard wantConnected, settings.autoConnect else { return }
		let lower = reason.lowercased()
		if lower.contains("authentication") || lower.contains("password") || lower.contains("host key") {
			wantConnected = false
			return
		}
		let delays = [2, 5, 10, 20, 30]
		let delay = delays[min(reconnectAttempt, delays.count - 1)]
		reconnectAttempt += 1
		reconnectTask?.cancel()
		reconnectTask = Task { [weak self] in
			try? await Task.sleep(for: .seconds(delay))
			guard let self, !Task.isCancelled, self.wantConnected else { return }
			if let config = self.config() { await self.tunnel.start(config) }
		}
	}
}
#endif
