import SwiftUI

#if os(macOS)
/// A short Mac dialog: heading, optional line of explanation, controls, then the
/// buttons at the bottom right, all sized to its content.
public struct MacDialog<Content: View, Actions: View>: View {
	let title: String
	let message: String?
	let content: Content
	let actions: Actions

	public init(
		title: String,
		message: String? = nil,
		@ViewBuilder content: () -> Content,
		@ViewBuilder actions: () -> Actions
	) {
		self.title = title
		self.message = message
		self.content = content()
		self.actions = actions()
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Text(title).font(.headline)
				.fixedSize(horizontal: false, vertical: true)
			if let message {
				Text(message)
					.foregroundStyle(.secondary)
					.fixedSize(horizontal: false, vertical: true)
			}
			Form { content }
				.formStyle(.columns)
			HStack {
				Spacer()
				actions
			}
			.padding(.top, 8)
		}
		.padding(20)
		.frame(width: 400)
	}
}

/// Dialog content that can outgrow a screen, such as a long list of models. It
/// sizes to its content up to 360 pt, then scrolls.
public struct MacDialogList<Content: View>: View {
	let content: Content

	public init(@ViewBuilder content: () -> Content) {
		self.content = content()
	}

	public var body: some View {
		ViewThatFits(in: .vertical) {
			content
			ScrollView { content }
		}
		.frame(maxHeight: 360)
	}
}

/// The dialog's way out, on Esc.
public struct MacCancelButton: View {
	let label: String
	@Environment(\.dismiss) private var dismiss

	public init(_ label: String = "Cancel") {
		self.label = label
	}

	public var body: some View {
		Button(label, role: .cancel) { dismiss() }
			.keyboardShortcut(.cancelAction)
	}
}
#endif

/// A long form in a sheet, with its Cancel and confirm buttons as `.toolbar`
/// items. The phone puts them in a navigation bar; a Mac sheet with no
/// navigation stack puts them at the bottom right, where a Mac dialog has them.
public struct DeckFormSheet<Content: View>: View {
	let title: String
	var width: CGFloat
	var height: CGFloat
	let content: Content

	public init(_ title: String, width: CGFloat = 520, height: CGFloat = 560, @ViewBuilder content: () -> Content) {
		self.title = title
		self.width = width
		self.height = height
		self.content = content()
	}

	public var body: some View {
		#if os(macOS)
		VStack(alignment: .leading, spacing: 0) {
			Text(title).font(.headline)
				.padding([.top, .horizontal], 20)
			content.formStyle(.grouped)
		}
		// A form has no height of its own: without one the sheet opens collapsed.
		.frame(width: width)
		.frame(minHeight: min(height, 320), idealHeight: height)
		#else
		NavigationStack {
			content
				.navigationTitle(title)
				.deckInlineNavigationTitle()
		}
		#endif
	}
}
