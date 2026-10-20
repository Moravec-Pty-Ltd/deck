import SwiftUI
import DeckKit
import DeckUI

/// The dev servers configured for the session's project (the web Servers tab):
/// live state, ports, preview link, setup progress, start/stop/restart, and
/// each server's log pane.
/// A browser destination. Distinct from the logs destination, which is keyed
/// by the server's name as a bare String.
private struct BrowserRoute: Hashable {
	let focus: String?
}

struct ServersSheet: View {
	let sessionId: String
	let title: String

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	#if os(macOS)
	@Environment(\.openWindow) private var openWindow
	#endif

	@State private var servers: [ServerRuntime]?
	@State private var busy: Set<String> = []
	@State private var errorMessage: String?

	var body: some View {
		NavigationStack {
			Group {
				if let servers, servers.isEmpty {
					ContentUnavailableView(
						"No dev servers",
						systemImage: "server.rack",
						description: Text("This project has no dev-server config. Add one under the project's settings in deck on the web."))
				} else if let servers {
					List {
						ForEach(servers) { server in
							Section {
								serverRows(server)
							} header: {
								HStack {
									Text(server.name)
									Spacer()
									Chip(text: server.state, color: stateColor(server.state))
								}
							}
						}
					}
					.deckInsetGroupedList()
				} else {
					ProgressView()
				}
			}
			.navigationTitle("Dev servers")
			.deckInlineNavigationTitle()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Done") { dismiss() }
				}
				ToolbarItem(placement: .primaryAction) {
					browserLink(focus: nil) {
						Label("Browser", systemImage: "globe")
					}
				}
			}
			.navigationDestination(for: String.self) { name in
				ServerLogsView(sessionId: sessionId, name: name)
			}
			#if os(iOS)
			.navigationDestination(for: BrowserRoute.self) { route in
				BrowserView(sessionId: sessionId, focus: route.focus)
			}
			#endif
			.task { await poll() }
			.alert("Something went wrong", isPresented: Binding(
				get: { errorMessage != nil },
				set: { if !$0 { errorMessage = nil } })
			) {
				Button("OK", role: .cancel) {}
			} message: {
				Text(errorMessage ?? "")
			}
		}
	}

	@ViewBuilder
	private func serverRows(_ server: ServerRuntime) -> some View {
		if let ports = server.ports, !ports.isEmpty {
			HStack(spacing: 10) {
				ForEach(ports, id: \.port) { port in
					HStack(spacing: 4) {
						Circle()
							.fill(port.listening == true ? Color.green : Color.gray.opacity(0.4))
							.frame(width: 7, height: 7)
						Text(port.label.map { "\($0) :\(port.port)" } ?? ":\(port.port)")
							.font(.caption.monospaced())
					}
				}
				Spacer()
			}
		}
		if let preview = server.previewUrl {
			// Deliberately not openURL: that address is loopback on the deck
			// machine, so Safari here would resolve it to this device and find
			// nothing. deck's own browser tunnels it instead.
			browserLink(focus: preview) {
				Label(preview, systemImage: "globe")
					.font(.footnote)
					.lineLimit(1)
					.truncationMode(.middle)
			}
		}
		if let error = server.error, !error.isEmpty {
			Text(error).font(.caption).foregroundStyle(.red)
		}
		if let warning = server.warning, !warning.isEmpty {
			Label(warning, systemImage: "exclamationmark.triangle")
				.font(.caption)
				.foregroundStyle(.orange)
		}
		if let steps = server.setup, !steps.isEmpty {
			DisclosureGroup("Setup: \(steps.filter { $0.state == "ok" }.count)/\(steps.count) steps") {
				ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
					VStack(alignment: .leading, spacing: 2) {
						HStack(spacing: 6) {
							Image(systemName: stepIcon(step.state))
								.foregroundStyle(stepColor(step.state))
								.font(.caption)
							Text(step.label).font(.footnote)
							Spacer()
							if step.state == "failed" {
								Button("Re-run") {
									Task { await act(server.name, action: "step", step: index, label: step.label) }
								}
								.font(.caption)
								.buttonStyle(.bordered)
								.controlSize(.mini)
							}
						}
						if step.state == "failed", let output = step.output, !output.isEmpty {
							Text(output.suffix(400))
								.font(.caption2.monospaced())
								.foregroundStyle(.secondary)
								.lineLimit(6)
						}
					}
				}
			}
			.font(.footnote)
		}
		HStack(spacing: 8) {
			if server.canStop {
				Button("Stop") { Task { await act(server.name, action: "stop") } }
				Button("Restart") { Task { await act(server.name, action: "restart") } }
			} else {
				Button("Start") { Task { await act(server.name, action: "start") } }
			}
			Button("Re-run setup") { Task { await act(server.name, action: "resetup") } }
			Spacer()
			NavigationLink(value: server.name) {
				Label("Logs", systemImage: "doc.plaintext")
			}
		}
		.buttonStyle(.bordered)
		.controlSize(.small)
		.disabled(busy.contains(server.name))
	}

	private func act(_ name: String, action: String, step: Int? = nil, label: String? = nil) async {
		guard let client = store.client else { return }
		busy.insert(name)
		defer { busy.remove(name) }
		do {
			try await client.serverAction(sessionId: sessionId, name: name, action: action, step: step, label: label)
			await refresh()
		} catch {
			errorMessage = error.localizedDescription
		}
	}

	private func refresh() async {
		guard let client = store.client else { return }
		do {
			servers = try await client.servers(sessionId: sessionId)
		} catch {
			if servers == nil { errorMessage = error.localizedDescription; servers = [] }
		}
	}

	/// State changes as setup steps run and ports come up; poll while shown,
	/// the same cadence as the web tab.
	private func poll() async {
		while !Task.isCancelled {
			await refresh()
			try? await Task.sleep(for: .seconds(3))
		}
	}

	private func stateColor(_ state: String) -> Color {
		switch state {
		case "running": return .green
		case "setup", "starting": return .blue
		case "stalled": return .orange
		case "errored": return .red
		default: return .secondary
		}
	}

	private func stepIcon(_ state: String) -> String {
		switch state {
		case "ok": return "checkmark.circle.fill"
		case "failed": return "xmark.circle.fill"
		case "running": return "circle.inset.filled"
		default: return "circle"
		}
	}

	private func stepColor(_ state: String) -> Color {
		switch state {
		case "ok": return .green
		case "failed": return .red
		case "running": return .blue
		default: return .secondary
		}
	}
}

/// The tail of a dev server's tmux pane, ANSI colours and all, polled with
/// the same change tag the web log pane sends back.
extension ServersSheet {
	/// The dev browser: pushed here on iOS, its own window on the Mac (which
	/// shows every dev server's tab, so there is nothing to focus).
	@ViewBuilder
	fileprivate func browserLink(focus: String?, @ViewBuilder label: () -> some View) -> some View {
		#if os(iOS)
		NavigationLink(value: BrowserRoute(focus: focus), label: label)
		#else
		Button(action: { openWindow(id: "browser") }, label: label)
		#endif
	}
}

struct ServerLogsView: View {
	let sessionId: String
	let name: String

	@Environment(DeckStore.self) private var store
	@State private var poller: TerminalPoller?

	var body: some View {
		Group {
			if let poller {
				TerminalView(poller: poller, emptyText: "(no output)")
			} else {
				ProgressView()
			}
		}
		.safeAreaInset(edge: .bottom) {
			if poller?.dead == true {
				Text("Not running")
					.font(.footnote)
					.foregroundStyle(.secondary)
					.padding(8)
					.frame(maxWidth: .infinity)
					.deckGlass(in: Rectangle())
			}
		}
		.navigationTitle(name)
		.deckInlineNavigationTitle()
		.onAppear {
			if poller == nil, let client = store.client {
				poller = .serverLogs(client: client, sessionId: sessionId, name: name)
			}
		}
	}
}
