import AppIntents
import DeckIntents

// Compiled into each app target (DeckApp and DeckWatch) rather than the
// package: App Intents metadata is extracted per app, so the shortcuts
// provider and the package bridge have to live in the app's own sources.

/// Pulls the package-hosted intents into this app's App Intents metadata.
struct DeckAppIntentsPackage: AppIntentsPackage {
	static var includedPackages: [any AppIntentsPackage.Type] {
		[DeckIntentsPackage.self]
	}
}

/// What Siri will match. App Shortcuts match these phrases close to verbatim:
/// there is no assistant schema domain for coding-agent sessions (Apple ships
/// them for mail, photos, documents and the like), so nothing here is composed
/// or paraphrased on our behalf. A phrasing that is not written down does not
/// work, which is why each intent carries several, in the words someone would
/// actually use rather than the one the intent happens to be named after.
///
/// Every phrase has to contain `\(.applicationName)`.
struct DeckShortcuts: AppShortcutsProvider {
	static var appShortcuts: [AppShortcut] {
		AppShortcut(
			intent: ListSessionsIntent(),
			phrases: [
				"Show my \(.applicationName) sessions",
				"List my \(.applicationName) sessions",
				"What sessions are in \(.applicationName)",
				"What is running in \(.applicationName)",
				"Search \(.applicationName) sessions",
				"Find a session in \(.applicationName)",
				"\(.applicationName) sessions"
			],
			shortTitle: "List sessions",
			systemImageName: "list.bullet.rectangle")
		AppShortcut(
			intent: CheckAttentionIntent(),
			phrases: [
				"What needs my attention in \(.applicationName)",
				"Check \(.applicationName)",
				"Does \(.applicationName) need me",
				"Is anything waiting in \(.applicationName)",
				"Anything blocked in \(.applicationName)"
			],
			shortTitle: "Needs attention",
			systemImageName: "bell.badge")
		AppShortcut(
			intent: SessionStatusIntent(),
			phrases: [
				"How is \(.applicationName) going",
				"What is \(.applicationName) doing",
				"\(.applicationName) status",
				"What did \(.applicationName) say",
				"Read me the latest from \(.applicationName)",
				"Catch me up on \(.applicationName)"
			],
			shortTitle: "Session status",
			systemImageName: "info.circle")
		AppShortcut(
			intent: StartSessionIntent(),
			phrases: [
				"Start a session in \(.applicationName)",
				"Get \(.applicationName) working on something",
				"New \(.applicationName) session",
				"Have \(.applicationName) do something",
				"Open a new session in \(.applicationName)"
			],
			shortTitle: "Start a session",
			systemImageName: "plus.bubble")
		AppShortcut(
			intent: StartWorkIntent(),
			phrases: [
				"Start work in \(.applicationName)",
				"Work on an issue in \(.applicationName)",
				"Pick up an issue in \(.applicationName)"
			],
			shortTitle: "Start work",
			systemImageName: "hammer")
		AppShortcut(
			intent: StartReviewIntent(),
			phrases: [
				"Start a review in \(.applicationName)",
				"Review a pull request in \(.applicationName)",
				"Review a PR in \(.applicationName)"
			],
			shortTitle: "Start review",
			systemImageName: "text.magnifyingglass")
		AppShortcut(
			intent: AnswerIntent(),
			phrases: [
				"Answer \(.applicationName)",
				"Reply to \(.applicationName)",
				"Tell \(.applicationName) yes",
				"Respond in \(.applicationName)"
			],
			shortTitle: "Answer",
			systemImageName: "bubble.left.and.text.bubble.right")
		AppShortcut(
			intent: SendPromptIntent(),
			phrases: [
				"Tell \(.applicationName) to do something",
				"Send a message in \(.applicationName)",
				"Send an instruction to \(.applicationName)"
			],
			shortTitle: "Send a message",
			systemImageName: "paperplane")
		AppShortcut(
			intent: StopSessionIntent(),
			phrases: [
				"Stop \(.applicationName)",
				"Interrupt \(.applicationName)",
				"Cancel what \(.applicationName) is doing"
			],
			shortTitle: "Stop a turn",
			systemImageName: "stop.circle")
	}
}
