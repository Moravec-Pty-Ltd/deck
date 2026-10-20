import SwiftUI
import DeckKit

/// What the window can do from the keyboard, published by its root view with
/// `.focusedSceneValue(\.deckScene, …)`.
public struct DeckSceneActions {
	public var openPalette: () -> Void
	public var newSession: () -> Void
	public var focusSearch: () -> Void
	public var previousSession: () -> Void
	public var nextSession: () -> Void

	public init(
		openPalette: @escaping () -> Void,
		newSession: @escaping () -> Void,
		focusSearch: @escaping () -> Void,
		previousSession: @escaping () -> Void,
		nextSession: @escaping () -> Void
	) {
		self.openPalette = openPalette
		self.newSession = newSession
		self.focusSearch = focusSearch
		self.previousSession = previousSession
		self.nextSession = nextSession
	}
}

/// What the open session can do from the keyboard, published by its view with
/// `.focusedSceneValue(\.deckSession, …)`. Nil means not right now: nothing to
/// send, no turn running, or nothing to compact.
public struct DeckSessionActions {
	public var send: (() -> Void)?
	public var stop: (() -> Void)?
	public var compact: (() -> Void)?

	public init(send: (() -> Void)?, stop: (() -> Void)?, compact: (() -> Void)? = nil) {
		self.send = send
		self.stop = stop
		self.compact = compact
	}
}

private struct DeckSceneKey: FocusedValueKey {
	typealias Value = DeckSceneActions
}

private struct DeckSessionKey: FocusedValueKey {
	typealias Value = DeckSessionActions
}

extension FocusedValues {
	public var deckScene: DeckSceneActions? {
		get { self[DeckSceneKey.self] }
		set { self[DeckSceneKey.self] = newValue }
	}

	public var deckSession: DeckSessionActions? {
		get { self[DeckSessionKey.self] }
		set { self[DeckSessionKey.self] = newValue }
	}
}

/// deck's keyboard shortcuts as menu commands, so iPadOS lists them when ⌘ is
/// held and a Mac shows them in its menu bar. Add with `.commands { DeckCommands() }`.
public struct DeckCommands: Commands {
	@FocusedValue(\.deckScene) private var scene
	@FocusedValue(\.deckSession) private var session

	public init() {}

	public var body: some Commands {
		// A new session rather than a new window: deck is one window.
		CommandGroup(replacing: .newItem) {
			Button("New Session") { scene?.newSession() }
				.keyboardShortcut("n")
				.disabled(scene == nil)
		}
		CommandMenu("Session") {
			Button("Send") { session?.send?() }
				.keyboardShortcut(.return)
				.disabled(session?.send == nil)
			Button("Stop") { session?.stop?() }
				.keyboardShortcut(".")
				.disabled(session?.stop == nil)
			Button("Compact Context") { session?.compact?() }
				.keyboardShortcut("k", modifiers: [.command, .shift])
				.disabled(session?.compact == nil)
		}
		CommandMenu("Go") {
			Button("Command Palette") { scene?.openPalette() }
				.keyboardShortcut("k")
				.disabled(scene == nil)
			Button("Search Sessions") { scene?.focusSearch() }
				.keyboardShortcut("f")
				.disabled(scene == nil)
			Divider()
			Button("Previous Session") { scene?.previousSession() }
				.keyboardShortcut("[")
				.disabled(scene == nil)
			Button("Next Session") { scene?.nextSession() }
				.keyboardShortcut("]")
				.disabled(scene == nil)
		}
	}
}
