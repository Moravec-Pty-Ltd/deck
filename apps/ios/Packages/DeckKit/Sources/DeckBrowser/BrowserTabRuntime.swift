#if canImport(WebKit)
import Foundation
import WebKit

/// One tab's live WebKit state: its web view, what it is showing, and the
/// navigation rules that keep loopback traffic on the proxy.
///
/// There is one of these per tab rather than one shared web view, so a tab keeps
/// its history and scroll position while you are in another one. The tab's id
/// ties the two together, which is why `BrowserTabs` keeps ids stable across a
/// server refresh: a new id here means a new web view and a reload.
@MainActor
final class BrowserTabRuntime: NSObject, WKNavigationDelegate {
	let id: String
	private(set) var webView: WKWebView
	/// What the address bar shows, with the sentinel mapped back to localhost.
	private(set) var address = ""
	private(set) var isLoading = false
	private(set) var progress = 0.0
	private(set) var canGoBack = false
	private(set) var canGoForward = false
	private(set) var failure: String?

	/// Whether loopback hosts should be sent to the sentinel. Set by the model
	/// from the tunnel's state, since a rewrite only makes sense with a proxy up.
	var tunnelled: Bool

	private var observations: [NSKeyValueObservation] = []
	private var onChange: () -> Void

	init(id: String, proxy: ProxyConfiguration?, tunnelled: Bool, onChange: @escaping () -> Void) {
		self.id = id
		self.tunnelled = tunnelled
		self.onChange = onChange
		self.webView = Self.makeWebView(proxy: proxy)
		super.init()
		attach()
	}

	/// The proxy linchpin. A `ProxyConfiguration` on the data store routes every
	/// load in this web view through the in-app SOCKS5 listener, which is the
	/// WebKit equivalent of Electron's `session.setProxy`. It can only be set
	/// when the store is made, so changing the proxy means a new web view.
	private static func makeWebView(proxy: ProxyConfiguration?) -> WKWebView {
		let store = WKWebsiteDataStore.nonPersistent()
		if let proxy { store.proxyConfigurations = [proxy] }
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = store
		let webView = WKWebView(frame: .zero, configuration: configuration)
		webView.allowsBackForwardNavigationGestures = true
		return webView
	}

	/// Swap in a web view bound to a new proxy, keeping the address so the page
	/// comes back where it was.
	func rebuild(proxy: ProxyConfiguration?, tunnelled: Bool) {
		let was = address
		self.tunnelled = tunnelled
		observations = []
		webView = Self.makeWebView(proxy: proxy)
		attach()
		if !was.isEmpty { load(was) }
		onChange()
	}

	private func attach() {
		webView.navigationDelegate = self
		observations = [
			webView.observe(\.isLoading, options: [.initial, .new]) { [weak self] view, _ in
				MainActor.assumeIsolated { self?.isLoading = view.isLoading; self?.onChange() }
			},
			webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
				MainActor.assumeIsolated { self?.progress = view.estimatedProgress; self?.onChange() }
			},
			webView.observe(\.canGoBack, options: [.new]) { [weak self] view, _ in
				MainActor.assumeIsolated { self?.canGoBack = view.canGoBack; self?.onChange() }
			},
			webView.observe(\.canGoForward, options: [.new]) { [weak self] view, _ in
				MainActor.assumeIsolated { self?.canGoForward = view.canGoForward; self?.onChange() }
			}
		]
	}

	func load(_ text: String) {
		guard let url = LoopbackHost.resolve(text, tunnelled: tunnelled) else { return }
		failure = nil
		address = LoopbackHost.display(url.absoluteString)
		webView.load(URLRequest(url: url))
		onChange()
	}

	func reload() { webView.reload() }
	func stop() { webView.stopLoading() }
	func goBack() { webView.goBack() }
	func goForward() { webView.goForward() }

	// MARK: WKNavigationDelegate

	/// Catches loopback navigations that did not come from the address bar:
	/// redirects, link clicks, scripted loads. WKWebView would send those
	/// straight to this device's loopback instead of through the proxy, so they
	/// are cancelled and reloaded against the sentinel.
	func webView(
		_ webView: WKWebView,
		decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		guard tunnelled,
			let url = navigationAction.request.url,
			LoopbackHost.isLoopback(url.host),
			var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
		else {
			decisionHandler(.allow)
			return
		}
		components.host = LoopbackHost.sentinel
		guard let rewritten = components.url else {
			decisionHandler(.allow)
			return
		}
		decisionHandler(.cancel)
		webView.load(URLRequest(url: rewritten))
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		if let url = webView.url?.absoluteString { address = LoopbackHost.display(url) }
		failure = nil
		onChange()
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		record(error)
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		record(error)
	}

	private func record(_ error: Error) {
		guard !Self.isCancellation(error) else { return }
		let ns = error as NSError
		let failing = (ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String).map(LoopbackHost.display)
		failure = failing.map { "\(error.localizedDescription) — \($0)" } ?? error.localizedDescription
		onChange()
	}

	/// The rewrite above cancels a navigation on purpose, and WebKit reports
	/// that as an error. Not a failure worth showing.
	private static func isCancellation(_ error: Error) -> Bool {
		let ns = error as NSError
		if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return true }
		if ns.domain == "WebKitErrorDomain", ns.code == 102 { return true } // frame load interrupted
		return false
	}
}
#endif
