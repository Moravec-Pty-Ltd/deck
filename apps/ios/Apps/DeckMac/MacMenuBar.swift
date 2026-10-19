import AppKit
import SwiftUI
import Observation
import DeckKit

/// A session something outside the main window asked to show, and whether a
/// sessions window is on screen to show it.
@MainActor
@Observable
final class MacOpenRequest {
	static let shared = MacOpenRequest()
	var sessionId: String?
	var openWindows = 0
}

@MainActor
enum MacOpener {
	static func open(session id: String) {
		MacOpenRequest.shared.sessionId = id
		showMain()
	}

	/// Bring the sessions window forward, reopening one if it was closed. The
	/// main window group has no scene id to open by, so a reopen goes through
	/// Launch Services, which hands SwiftUI the same event as a Dock click.
	static func showMain() {
		NSApp.activate()
		if MacOpenRequest.shared.openWindows > 0 {
			NSApp.windows.filter(\.isMiniaturized).forEach { $0.deminiaturize(nil) }
			return
		}
		NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: NSWorkspace.OpenConfiguration())
	}
}

extension View {
	/// Lets the menu bar and notifications pick this window's session.
	func macOpenTarget(selection: Binding<MacPane?>) -> some View {
		modifier(MacOpenTarget(selection: selection))
	}
}

private struct MacOpenTarget: ViewModifier {
	@Environment(DeckStore.self) private var store
	@Binding var selection: MacPane?

	func body(content: Content) -> some View {
		content
			.onAppear {
				MacOpenRequest.shared.openWindows += 1
				MacPushManager.shared.configure(store: store)
			}
			.onDisappear { MacOpenRequest.shared.openWindows -= 1 }
			.onChange(of: MacOpenRequest.shared.sessionId, initial: true) { _, id in
				guard let id else { return }
				selection = .session(id)
				MacOpenRequest.shared.sessionId = nil
			}
	}
}

/// The menu bar icon: a count when something needs you.
struct MenuBarIcon: View {
	@Environment(DeckStore.self) private var store

	var body: some View {
		let badge = MenuBarDigest(asks: store.asks, sessions: store.sessions, runs: store.runs).badge
		HStack(spacing: 2) {
			Image(systemName: badge == nil ? "rectangle.stack" : "questionmark.bubble.fill")
			if let badge { Text(badge) }
		}
		.task { MacPushManager.shared.configure(store: store) }
		.accessibilityLabel(badge.map { "deck, \($0) waiting" } ?? "deck")
	}
}

struct MenuBarContent: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
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
				MacOpener.showMain()
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
		MacOpener.open(session: sessionId)
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
