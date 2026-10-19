import DeckBrowser
import DeckKit
import SwiftUI
import WebKit

/// A browser for the dev servers running on the deck machine.
///
/// The machine deck runs on is never this one, so `http://localhost:5173` means
/// nothing here. Every load goes through an SSH tunnel to that machine instead,
/// which is why this is a web view of our own rather than a link out to Safari:
/// only a web view we configure can be pointed at a proxy.
///
/// Tabs come from the session's dev config, so opening this on a project with
/// servers up lands on the right pages without typing an address.
struct BrowserView: View {
	/// Whose dev servers to show, or nil for every session's. The tunnel reaches
	/// the whole machine, so a browser opened from the tab bar is not about one
	/// session; one opened from a session is.
	var sessionId: String?
	/// An address to land on, from a server's preview link. Nil opens on whatever
	/// the dev config says is primary.
	var focus: String?
	/// Presented as a sheet rather than pushed, so it needs its own way out.
	var isModal = false

	@Environment(DeckStore.self) private var store
	@Environment(\.scenePhase) private var scenePhase
	@State private var model: BrowserModel?
	@State private var address = ""
	@State private var showingTunnel = false
	@State private var focused = false
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		Group {
			if let model {
				content(model)
			} else {
				ProgressView()
			}
		}
		.navigationTitle("Browser")
		#if !targetEnvironment(macCatalyst)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await begin() }
		.onChange(of: scenePhase) { _, phase in
			// iOS suspends sockets in the background, so the tunnel is usually
			// dead by the time you come back to it.
			if phase == .active { model?.reconnectIfNeeded() }
		}
		.toolbar {
			if isModal {
				ToolbarItem(placement: .cancellationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
		.sheet(isPresented: $showingTunnel) {
			if let model { TunnelSheet(model: model) }
		}
	}

	@ViewBuilder
	private func content(_ model: BrowserModel) -> some View {
		Group {
			if let tab = model.current {
				page(model, tab)
			} else {
				ContentUnavailableView(
					"Nothing to show",
					systemImage: "globe",
					description: Text(
						"Start a dev server for this session and its ports open here, or add a tab for any address."))
			}
		}
		// The tunnel's state belongs on screen, not buried in a sheet: a page
		// that will not load is nearly always the tunnel, and the last forwarded
		// target is the proof it is carrying traffic rather than merely up.
		.safeAreaInset(edge: .top) { statusStrip(model) }
		#if targetEnvironment(macCatalyst)
			.toolbar {
				ToolbarItemGroup(placement: .primaryAction) { controls(model) }
			}
			.safeAreaInset(edge: .top) { tabStrip(model) }
		#else
			.safeAreaInset(edge: .bottom) {
				VStack(spacing: 6) {
					tabStrip(model)
					controls(model)
				}
				.padding(.vertical, 8)
				.background(.bar)
			}
		#endif
	}

	@ViewBuilder
	private func statusStrip(_ model: BrowserModel) -> some View {
		HStack(spacing: 8) {
			Circle().fill(statusColour(model)).frame(width: 7, height: 7)
			Text(model.status)
				.font(.caption2.monospaced())
				.foregroundStyle(.secondary)
				.lineLimit(1)
				.truncationMode(.middle)
			Spacer(minLength: 8)
			if !model.lastForward.isEmpty {
				Text(model.lastForward)
					.font(.caption2.monospaced())
					.foregroundStyle(.tertiary)
					.lineLimit(1)
			}
		}
		.padding(.horizontal, 14)
		.padding(.vertical, 6)
		.background(.bar)
		.contentShape(Rectangle())
		.onTapGesture { showingTunnel = true }
	}

	private func statusColour(_ model: BrowserModel) -> Color {
		if case .failed = model.tunnelState { return .red }
		return model.isConnected ? .green : .secondary
	}

	@ViewBuilder
	private func page(_ model: BrowserModel, _ tab: BrowserTab) -> some View {
		// Reading `revision` here is what makes the view follow a tab's own
		// WebKit state: @Observable cannot see inside the runtime objects.
		let _ = model.revision
		ZStack(alignment: .bottom) {
			WebViewHost(webView: model.webView(for: tab))
			if model.isLoading(for: tab) {
				GeometryReader { geometry in
					Rectangle()
						.fill(Color.accentColor)
						.frame(width: geometry.size.width * model.progress(for: tab))
						.animation(.easeOut(duration: 0.15), value: model.progress(for: tab))
				}
				.frame(height: 2)
				.frame(maxHeight: .infinity, alignment: .bottom)
			}
			if let failure = model.failure(for: tab) {
				VStack(spacing: 12) {
					Text(failure)
						.font(.callout)
						.multilineTextAlignment(.center)
						.foregroundStyle(.secondary)
					if !model.isConnected {
						Button("Set up the tunnel") { showingTunnel = true }
							.buttonStyle(.borderedProminent)
					} else {
						Button("Try again") { model.reload(tab) }
							.buttonStyle(.bordered)
					}
				}
				.padding(24)
				.background(.background)
			}
		}
		.onChange(of: model.selected) { _, _ in address = model.address(for: tab) }
		.onAppear { address = model.address(for: tab) }
	}

	@ViewBuilder
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
				Button {
					model.open()
					address = ""
				} label: {
					Image(systemName: "plus")
				}
				.buttonStyle(.bordered)
				.controlSize(.small)
				.accessibilityLabel("New tab")
			}
			.padding(.horizontal, 12)
		}
		.scrollIndicators(.hidden)
	}

	@ViewBuilder
	private func controls(_ model: BrowserModel) -> some View {
		HStack(spacing: 10) {
			if let tab = model.current {
				Button { model.goBack(tab) } label: { Image(systemName: "chevron.left") }
					.disabled(!model.canGoBack(tab))
					.accessibilityLabel("Back")
				Button { model.goForward(tab) } label: { Image(systemName: "chevron.right") }
					.disabled(!model.canGoForward(tab))
					.accessibilityLabel("Forward")

				HStack(spacing: 6) {
					// Whether this page is going through the tunnel, where a
					// browser would normally show whether it is encrypted.
					Image(systemName: model.isConnected ? "lock.shield.fill" : "globe")
						.font(.caption2)
						.foregroundStyle(model.isConnected ? Color.accentColor : Color.secondary)
					TextField("Address", text: $address)
						.font(.callout.monospaced())
						.keyboardType(.URL)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.submitLabel(.go)
						.onSubmit { model.load(address, in: tab) }
						.accessibilityIdentifier("browser.address")
				}
				.padding(.horizontal, 8)
				.padding(.vertical, 6)
				.background(Color.secondary.opacity(0.12))
				.clipShape(RoundedRectangle(cornerRadius: 8))

				if model.isLoading(for: tab) {
					Button { model.stop(tab) } label: { Image(systemName: "xmark") }
						.accessibilityLabel("Stop loading")
				} else {
					Button { model.reload(tab) } label: { Image(systemName: "arrow.clockwise") }
						.accessibilityLabel("Reload")
				}
			}
			Button { showingTunnel = true } label: {
				Image(systemName: model.isConnected ? "lock.fill" : "lock.slash")
					.foregroundStyle(model.isConnected ? Color.green : .orange)
			}
			.accessibilityLabel("Tunnel")
			.accessibilityIdentifier("browser.tunnel")
		}
		.buttonStyle(.plain)
		.padding(.horizontal, 12)
	}

	private func begin() async {
		if model == nil {
			model = BrowserModel(deckOrigin: store.client?.credentials.baseURL)
			model?.connectIfConfigured()
		}
		await poll()
	}

	/// Same cadence as the servers sheet: ports come up while you watch.
	private func poll() async {
		while !Task.isCancelled {
			if let servers = await currentServers() {
				model?.refresh(servers: servers)
				// Only once: a later poll must not drag you back to where you
				// came in, after you have changed tabs.
				if let focus, !focused {
					focused = true
					model?.focus(on: focus)
				}
				if address.isEmpty, let tab = model?.current { address = model?.address(for: tab) ?? "" }
			}
			try? await Task.sleep(for: .seconds(3))
		}
	}

	private func currentServers() async -> [ServerRuntime]? {
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

private struct TabChip: View {
	let tab: BrowserTab
	let isSelected: Bool
	let select: () -> Void
	let close: () -> Void

	var body: some View {
		HStack(spacing: 5) {
			if tab.isDerived {
				Circle()
					.fill(tab.listening ? Color.green : Color.gray.opacity(0.4))
					.frame(width: 6, height: 6)
			}
			Text(tab.title).font(.caption.monospaced()).lineLimit(1)
			if isSelected {
				Button(action: close) {
					Image(systemName: "xmark").font(.caption2)
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Close \(tab.title)")
			}
		}
		.padding(.horizontal, 10)
		.padding(.vertical, 6)
		.background(isSelected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
		.clipShape(Capsule())
		.onTapGesture(perform: select)
	}
}

/// Hosts a WKWebView, swapping it when the tab changes or the proxy forces a
/// rebuild. The container stays put so SwiftUI keeps one view to lay out.
private struct WebViewHost: UIViewRepresentable {
	let webView: WKWebView

	func makeUIView(context: Context) -> UIView { UIView() }

	func updateUIView(_ container: UIView, context: Context) {
		guard webView.superview !== container else { return }
		container.subviews.forEach { $0.removeFromSuperview() }
		webView.translatesAutoresizingMaskIntoConstraints = false
		container.addSubview(webView)
		NSLayoutConstraint.activate([
			webView.topAnchor.constraint(equalTo: container.topAnchor),
			webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
			webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
			webView.trailingAnchor.constraint(equalTo: container.trailingAnchor)
		])
	}
}
