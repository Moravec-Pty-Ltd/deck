import SwiftUI
import DeckKit

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
					.listStyle(.insetGrouped)
				} else {
					ProgressView()
				}
			}
			.navigationTitle("Dev servers")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Done") { dismiss() }
				}
				ToolbarItem(placement: .primaryAction) {
					NavigationLink(value: BrowserRoute(focus: nil)) {
						Label("Browser", systemImage: "globe")
					}
				}
			}
			.navigationDestination(for: String.self) { name in
				ServerLogsView(sessionId: sessionId, name: name)
			}
			.navigationDestination(for: BrowserRoute.self) { route in
				BrowserView(sessionId: sessionId, focus: route.focus)
			}
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
			NavigationLink(value: BrowserRoute(focus: preview)) {
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

/// The tail of a dev server's tmux pane, refreshed every couple of seconds
/// using the same change tag the web log pane sends back.
struct ServerLogsView: View {
	let sessionId: String
	let name: String

	@Environment(DeckStore.self) private var store
	@State private var text = ""
	@State private var tag: String?
	@State private var dead = false
	@State private var loaded = false

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView([.vertical, .horizontal]) {
				Text(text.isEmpty && loaded ? "(no output)" : text)
					.font(.caption.monospaced())
					.textSelection(.enabled)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding()
					.id("logs")
			}
			.onChange(of: text) { _, _ in proxy.scrollTo("logs", anchor: .bottom) }
		}
		.overlay {
			if !loaded { ProgressView() }
		}
		.safeAreaInset(edge: .bottom) {
			if dead {
				Text("Not running")
					.font(.footnote)
					.foregroundStyle(.secondary)
					.padding(8)
					.frame(maxWidth: .infinity)
					.background(.thinMaterial)
			}
		}
		.navigationTitle(name)
		.navigationBarTitleDisplayMode(.inline)
		.task { await poll() }
	}

	private func poll() async {
		guard let client = store.client else { return }
		while !Task.isCancelled {
			if let logs = try? await client.serverLogs(sessionId: sessionId, name: name, tag: tag) {
				if logs.unchanged != true {
					text = logs.text ?? ""
					tag = logs.h
				}
				dead = logs.dead ?? false
				loaded = true
			}
			try? await Task.sleep(for: .seconds(2))
		}
	}
}
