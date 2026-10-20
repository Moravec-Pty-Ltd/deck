import DeckBrowser
import DeckKit
import SwiftUI

/// The dev browser in its own window: a tab per dev-server port across every
/// session, an address bar, and the SSH tunnel to the deck machine. When deck
/// runs on this Mac there is no tunnel; pages load straight from loopback.
struct MacBrowserView: View {
	@Environment(DeckStore.self) private var store
	@State private var model: BrowserModel?
	@State private var modelOrigin: URL?
	@State private var address = ""
	@State private var showingTunnel = false

	var body: some View {
		Group {
			if !store.isSignedIn {
				ContentUnavailableView("Not signed in", systemImage: "globe", description: Text("Sign in to deck first."))
			} else if let model {
				content(model)
			} else {
				ProgressView()
			}
		}
		.frame(minWidth: 640, minHeight: 420)
		.navigationTitle("Browser")
		.task(id: store.client?.credentials.baseURL) { await begin() }
		.sheet(isPresented: $showingTunnel) {
			if let model {
				TunnelSheet(model: model).frame(minWidth: 420, minHeight: 440)
			}
		}
	}

	@ViewBuilder
	private func content(_ model: BrowserModel) -> some View {
		VStack(spacing: 0) {
			tabStrip(model)
			Divider()
			if let tab = model.current {
				page(model, tab)
			} else {
				ContentUnavailableView(
					"Nothing to show",
					systemImage: "globe",
					description: Text("Start a dev server in a session and its ports open here, or add a tab for any address."))
			}
			Divider()
			statusStrip(model)
		}
		.toolbar { toolbar(model) }
	}

	@ToolbarContentBuilder
	private func toolbar(_ model: BrowserModel) -> some ToolbarContent {
		ToolbarItemGroup(placement: .navigation) {
			if let tab = model.current {
				Button { model.goBack(tab) } label: { Label("Back", systemImage: "chevron.left") }
					.disabled(!model.canGoBack(tab))
					.keyboardShortcut("[", modifiers: .command)
				Button { model.goForward(tab) } label: { Label("Forward", systemImage: "chevron.right") }
					.disabled(!model.canGoForward(tab))
					.keyboardShortcut("]", modifiers: .command)
			}
		}
		ToolbarItem(placement: .principal) {
			if let tab = model.current {
				TextField("Address", text: $address)
					.textFieldStyle(.roundedBorder)
					.font(.callout.monospaced())
					.frame(minWidth: 320, idealWidth: 480)
					.onSubmit { model.load(address, in: tab) }
			}
		}
		ToolbarItemGroup(placement: .primaryAction) {
			if let tab = model.current {
				if model.isLoading(for: tab) {
					Button { model.stop(tab) } label: { Label("Stop", systemImage: "xmark") }
				} else {
					Button { model.reload(tab) } label: { Label("Reload", systemImage: "arrow.clockwise") }
						.keyboardShortcut("r", modifiers: .command)
				}
			}
			Button {
				model.open()
				address = ""
			} label: {
				Label("New Tab", systemImage: "plus")
			}
			.keyboardShortcut("t", modifiers: .command)
			if !model.isDirect {
				Button { showingTunnel = true } label: {
					Label("Tunnel", systemImage: model.isConnected ? "lock.fill" : "lock.slash")
				}
			}
		}
	}

	private func tabStrip(_ model: BrowserModel) -> some View {
		ScrollView(.horizontal) {
			HStack(spacing: 6) {
				ForEach(model.tabs) { tab in
					TabChip(
						tab: tab,
						isSelected: tab.id == model.selected,
						select: { model.selected = tab.id },
						close: { model.close(tab.id) })
				}
			}
			.padding(.horizontal, 10)
			.padding(.vertical, 6)
		}
		.scrollIndicators(.hidden)
	}

	@ViewBuilder
	private func page(_ model: BrowserModel, _ tab: BrowserTab) -> some View {
		// Reading `revision` is what makes the view follow a tab's own WebKit
		// state: @Observable cannot see inside the runtime objects.
		let _ = model.revision
		ZStack(alignment: .top) {
			WebViewHost(webView: model.webView(for: tab))
			if model.isLoading(for: tab) {
				ProgressView(value: model.progress(for: tab))
					.progressViewStyle(.linear)
			}
			if let failure = model.failure(for: tab) {
				failureCard(model, tab, failure)
					.frame(maxHeight: .infinity)
			}
		}
		.onChange(of: model.selected, initial: true) { _, _ in address = model.address(for: tab) }
	}

	private func failureCard(_ model: BrowserModel, _ tab: BrowserTab, _ failure: String) -> some View {
		VStack(spacing: 12) {
			Text(failure)
				.multilineTextAlignment(.center)
				.foregroundStyle(.secondary)
			if !model.isConnected, !model.isDirect {
				Button("Set Up the Tunnel") { showingTunnel = true }
					.buttonStyle(.borderedProminent)
			} else {
				Button("Try Again") { model.reload(tab) }
			}
		}
		.padding(24)
		.background(.background, in: RoundedRectangle(cornerRadius: 10))
	}

	private func statusStrip(_ model: BrowserModel) -> some View {
		HStack(spacing: 8) {
			Circle().fill(BrowserStatus.colour(model)).frame(width: 7, height: 7)
			Text(model.status)
				.lineLimit(1)
				.truncationMode(.middle)
			Spacer(minLength: 8)
			if !model.lastForward.isEmpty {
				Text(model.lastForward).foregroundStyle(.tertiary)
			}
		}
		.font(.caption.monospaced())
		.foregroundStyle(.secondary)
		.padding(.horizontal, 10)
		.padding(.vertical, 5)
	}

	private func begin() async {
		guard let origin = store.client?.credentials.baseURL else { return }
		// Signing in to another deck can change whether it is on this machine.
		if model == nil || modelOrigin != origin {
			model = BrowserModel(deckOrigin: origin)
			modelOrigin = origin
			address = ""
			model?.connectIfConfigured()
		}
		while !Task.isCancelled {
			if let servers = await BrowserServers.current(store: store, sessionId: nil) {
				model?.refresh(servers: servers)
				if address.isEmpty, let tab = model?.current { address = model?.address(for: tab) ?? "" }
			}
			try? await Task.sleep(for: .seconds(3))
		}
	}
}
