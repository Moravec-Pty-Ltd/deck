import SwiftUI
import DeckKit

/// The control that focuses the app on one project group, showing the current
/// one. A dot says another group has something waiting. Add it only where
/// `store.groupEntries` is not empty: with no groups it has nothing to offer.
public struct GroupSwitcher: View {
	@Environment(DeckStore.self) private var store
	@PickedGroup private var picked

	public init() {}

	public var body: some View {
		let entries = store.groupEntries
		let selected = GroupSwitch.resolved(picked: picked, in: entries)
		Menu {
			Picker("Group", selection: Binding(get: { selected ?? "" }, set: { picked = $0 })) {
				ForEach(entries) { Text($0.menuTitle).tag($0.storedValue) }
			}
			.pickerStyle(.inline)
			.labelsHidden()
		} label: {
			HStack(spacing: 4) {
				Text(selected ?? "All")
					.font(.headline)
					.lineLimit(1)
				if GroupSwitch.waitingElsewhere(entries, selected: selected) {
					Circle()
						.fill(.orange)
						.frame(width: 7, height: 7)
						.accessibilityLabel("Another group has something waiting")
				}
				Image(systemName: "chevron.down")
					.font(.caption.weight(.semibold))
					.foregroundStyle(.secondary)
					.accessibilityHidden(true)
			}
			.foregroundStyle(.primary)
		}
		.menuIndicator(.hidden)
		.tint(.primary)
		.accessibilityIdentifier("groupSwitcher")
	}
}

/// Brings a session's group along when it opens, by whatever route (a
/// notification, a link, the palette, a search hit). Waits for the data a cold
/// open doesn't have yet. Reacts only to the session changing or a link naming it
/// again, so picking another group while one stays open sticks.
private struct FollowsSessionGroup: ViewModifier {
	let sessionId: String?
	@Environment(DeckStore.self) private var store
	@Environment(\.opensHere) private var opensHere
	@PickedGroup private var picked
	@State private var opening: String?

	func body(content: Content) -> some View {
		content
			.onChange(of: sessionId, initial: true) { _, id in
				opening = id
				follow()
			}
			.onReceive(NotificationCenter.default.publisher(for: .deckOpenSession)) { note in
				guard opensHere(note) else { return }
				opening = note.object as? String
				follow()
			}
			.onChange(of: store.sessions) { _, _ in follow() }
			.onChange(of: store.projects) { _, _ in follow() }
	}

	private func follow() {
		guard let opening, !store.projects.isEmpty,
			let session = store.sessions.first(where: { $0.id == opening })
		else { return }
		self.opening = nil
		let selected = store.selectedGroup(picked: picked)
		if let next = GroupSwitch.afterOpening(session, projects: store.projects, selected: selected), next != selected {
			picked = next
		}
	}
}

extension View {
	/// Gives this window its own group: kept with the scene, so it survives a
	/// relaunch, and starting from the last group picked in any window.
	public func keepsGroupPerWindow() -> some View {
		modifier(WindowGroupPick())
	}

	public func followsGroup(ofSession sessionId: String?) -> some View {
		modifier(FollowsSessionGroup(sessionId: sessionId))
	}
}

extension EnvironmentValues {
	/// The window's group, from `keepsGroupPerWindow`. Nil outside one.
	@Entry public var windowGroup: Binding<String>? = nil
	/// Whether a `.deckOpenSession` or `.deckOpenRun` post is for this window.
	/// Every window hears it; the Mac aims it at one.
	@Entry public var opensHere: (Notification) -> Bool = { _ in true }
}

/// The group picked in this window, as stored under `GroupSwitch.storageKey`.
/// Outside a `keepsGroupPerWindow` view it is the app-wide last pick.
@propertyWrapper
public struct PickedGroup: DynamicProperty {
	@Environment(\.windowGroup) private var window
	@AppStorage(GroupSwitch.storageKey) private var lastPicked = ""

	public init() {}

	public var wrappedValue: String {
		get { window?.wrappedValue ?? lastPicked }
		nonmutating set {
			if let window { window.wrappedValue = newValue } else { lastPicked = newValue }
		}
	}
}

private struct WindowGroupPick: ViewModifier {
	@SceneStorage(GroupSwitch.storageKey) private var picked: String?
	@AppStorage(GroupSwitch.storageKey) private var lastPicked = ""

	func body(content: Content) -> some View {
		let current = picked ?? lastPicked
		content
			.environment(\.windowGroup, Binding(get: { current }, set: { picked = $0; lastPicked = $0 }))
			// Pinned at once, so a window that never picks stops following the others.
			.onAppear { if picked == nil { picked = lastPicked } }
	}
}
