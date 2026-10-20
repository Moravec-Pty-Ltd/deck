import AppKit
import SwiftUI
import DeckKit

/// Opens deck's windows from outside them: the menu bar and notification taps.
@MainActor
struct MacOpener {
	/// Every main window that has appeared; weak, so a closed one drops out.
	private static let tracked = NSHashTable<NSWindow>.weakObjects()

	static func track(_ window: NSWindow) { tracked.add(window) }

	/// The main windows open right now, read from AppKit at the moment of use
	/// rather than counted from SwiftUI's appear and disappear. Unhides the app
	/// first, since a hidden app's windows all read as not visible.
	static func mainWindows() -> [NSWindow] {
		if NSApp.isHidden { NSApp.unhide(nil) }
		return tracked.allObjects.filter { $0.isVisible || $0.isMiniaturized }
	}

	let openWindow: OpenWindowAction

	/// Focuses a main window, or opens one when none is left. openWindow on a
	/// plain WindowGroup always adds a window, so it is only used for the second.
	func showMain() {
		NSApp.activate()
		guard let window = Self.mainWindows().first else {
			openWindow(id: MacWindow.main)
			return
		}
		if window.isMiniaturized { window.deminiaturize(nil) }
		window.makeKeyAndOrderFront(nil)
	}

	/// Selects the session in the main window, or with none open gives it a
	/// window of its own (focusing the one it already has).
	func open(session id: String) {
		guard !Self.mainWindows().isEmpty else {
			NSApp.activate()
			openWindow(id: MacWindow.session, value: id)
			return
		}
		showMain()
		NotificationCenter.default.post(name: .deckOpenSession, object: id)
	}

	/// Shows the run in the main window's inbox; with none open, its phase
	/// session's window when it has one.
	func open(run id: String, phaseSession: String?) {
		if !Self.mainWindows().isEmpty {
			showMain()
			NotificationCenter.default.post(name: .deckOpenRun, object: id)
		} else if let phaseSession {
			open(session: phaseSession)
		} else {
			showMain()
		}
	}
}

extension View {
	/// Marks this view's window as a main window for MacOpener.
	func macMainWindow() -> some View {
		background(MainWindowTracker())
	}
}

private struct MainWindowTracker: NSViewRepresentable {
	func makeNSView(context: Context) -> NSView { TrackingView() }
	func updateNSView(_ nsView: NSView, context: Context) {}

	private final class TrackingView: NSView {
		override func viewDidMoveToWindow() {
			super.viewDidMoveToWindow()
			if let window { MacOpener.track(window) }
		}
	}
}

/// The menu bar icon: a count when something needs you.
struct MenuBarIcon: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		let badge = MenuBarDigest(asks: store.asks, sessions: store.sessions, runs: store.runs).badge
		HStack(spacing: 2) {
			Image(systemName: badge == nil ? "rectangle.stack" : "questionmark.bubble.fill")
			if let badge { Text(badge) }
		}
		.task { MacPushManager.shared.configure(store: store, opener: MacOpener(openWindow: openWindow)) }
		.accessibilityLabel(badge.map { "deck, \($0) waiting" } ?? "deck")
	}
}

struct MenuBarContent: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openWindow) private var openWindow
	@State private var answering: Set<String> = []
	@State private var failure: String?

	var body: some View {
		let digest = MenuBarDigest(asks: store.asks, sessions: store.sessions, runs: store.runs)
		VStack(alignment: .leading, spacing: 0) {
			if !store.isSignedIn {
				placeholder("Open deck to sign in.")
			} else if digest.isEmpty {
				placeholder("Nothing needs you, and nothing is running.")
			} else {
				ScrollView {
					sections(digest).padding(12)
				}
				.frame(maxHeight: 480)
			}
			if case .offline(let reason) = store.connection {
				Label(reason, systemImage: "wifi.exclamationmark")
					.font(.caption)
					.foregroundStyle(.orange)
					.padding(.horizontal, 12)
					.padding(.bottom, 8)
			}
			Divider()
			footer
		}
		.frame(width: 340)
	}

	@ViewBuilder
	private func sections(_ digest: MenuBarDigest) -> some View {
		VStack(alignment: .leading, spacing: 14) {
			if let failure {
				Text(failure).font(.caption).foregroundStyle(.red)
			}
			if !digest.questions.isEmpty {
				section("Waiting for an answer") {
					ForEach(digest.questions) { waitingRow($0) }
				}
			}
			if !digest.blockedRuns.isEmpty {
				section("Blocked runs") {
					ForEach(digest.blockedRuns) { waitingRow($0) }
				}
			}
			if !digest.running.isEmpty {
				section("Running") {
					ForEach(digest.running) { session in
						Button { open(session.id) } label: {
							Label(MenuBarDigest.title(of: session), systemImage: "circle.fill")
								.labelStyle(RunningLabelStyle())
								.frame(maxWidth: .infinity, alignment: .leading)
								.contentShape(Rectangle())
						}
						.buttonStyle(.plain)
					}
				}
			}
		}
	}

	private func section(_ title: String, @ViewBuilder rows: () -> some View) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
			rows()
		}
	}

	private func waitingRow(_ item: MenuBarDigest.Waiting) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(alignment: .firstTextBaseline) {
				Text(item.title).font(.headline).lineLimit(1)
				Spacer()
				if let sessionId = item.sessionId {
					Button("Open") { open(sessionId) }
						.controlSize(.small)
				}
			}
			if let question = item.question {
				Text(question).font(.callout).foregroundStyle(.secondary).lineLimit(3)
			}
			if !item.quickOptions.isEmpty {
				VStack(alignment: .leading, spacing: 4) {
					ForEach(item.quickOptions, id: \.self) { label in
						Button(label) { Task { await answer(item, with: label) } }
							.controlSize(.small)
							.disabled(answering.contains(item.id))
					}
				}
			}
		}
	}

	private var footer: some View {
		HStack {
			Button("Open deck") {
				dismiss()
				MacOpener(openWindow: openWindow).showMain()
			}
			Spacer()
			Button("Quit") { NSApp.terminate(nil) }
		}
		.padding(10)
	}

	private func placeholder(_ text: String) -> some View {
		Text(text)
			.foregroundStyle(.secondary)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(12)
	}

	private func open(_ sessionId: String) {
		dismiss()
		MacOpener(openWindow: openWindow).open(session: sessionId)
	}

	/// Answers as the ask card does with that one option picked.
	private func answer(_ item: MenuBarDigest.Waiting, with label: String) async {
		answering.insert(item.id)
		defer { answering.remove(item.id) }
		var draft = AskAnswerDraft(questions: item.ask.questions)
		draft.toggle(label, question: 0)
		do {
			try await store.answer(ask: item.ask, text: draft.text, answers: draft.answers)
			failure = nil
		} catch {
			failure = DeckError.message(for: error)
		}
	}
}

private struct RunningLabelStyle: LabelStyle {
	func makeBody(configuration: Configuration) -> some View {
		HStack(spacing: 6) {
			configuration.icon.font(.system(size: 6)).foregroundStyle(.green)
			configuration.title.lineLimit(1)
		}
	}
}
