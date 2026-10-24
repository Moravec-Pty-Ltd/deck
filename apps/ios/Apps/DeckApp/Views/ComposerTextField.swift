import SwiftUI
import UIKit
import UniformTypeIdentifiers
import DeckUI

/// The session's message field. A SwiftUI text field only takes text, so an
/// image pasted into it (the edit menu, ⌘V, the keyboard's clipboard
/// suggestion) was lost; this one hands images to `onPasteImages` and
/// pastes everything else as text.
struct ComposerTextField: UIViewRepresentable {
	@Binding var text: String
	@Binding var isFocused: Bool
	var onPasteImages: ([NSItemProvider]) -> Void

	func makeUIView(context: Context) -> PasteTextView {
		let view = PasteTextView()
		view.delegate = context.coordinator
		view.font = .preferredFont(forTextStyle: .body)
		view.adjustsFontForContentSizeCategory = true
		view.backgroundColor = .clear
		view.textColor = .label
		view.textContainerInset = .zero
		view.textContainer.lineFragmentPadding = 0
		view.isScrollEnabled = false
		view.setContentHuggingPriority(.required, for: .vertical)
		view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		var types = view.pasteConfiguration?.acceptableTypeIdentifiers ?? [UTType.plainText.identifier]
		types.append(UTType.image.identifier)
		view.pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: types)
		view.accessibilityIdentifier = "sessionComposer"
		view.accessibilityLabel = "Message"
		return view
	}

	func updateUIView(_ view: PasteTextView, context: Context) {
		context.coordinator.parent = self
		view.onPasteImages = onPasteImages
		// .disabled() does not reach a UIKit view; a send in flight must not take edits it would then clear.
		// Edits are refused rather than isEditable turned off, which would drop the keyboard mid-send.
		view.acceptsEdits = context.environment.isEnabled
		view.alpha = view.acceptsEdits ? 1 : 0.5
		if view.text != text, view.markedTextRange == nil { view.text = text }
		view.wantsFocus = isFocused
		view.applyFocus()
	}

	func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PasteTextView, context: Context) -> CGSize? {
		let width = proposal.width ?? view.bounds.width
		guard width > 0, let font = view.font else { return nil }
		let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
		let cap = font.lineHeight * 5
		let scrolls = fitted > cap
		if view.isScrollEnabled != scrolls { DispatchQueue.main.async { view.isScrollEnabled = scrolls } }
		return CGSize(width: width, height: min(fitted, cap))
	}

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	final class Coordinator: NSObject, UITextViewDelegate {
		var parent: ComposerTextField
		init(_ parent: ComposerTextField) { self.parent = parent }

		func textViewDidChange(_ view: UITextView) {
			parent.text = view.text
			view.invalidateIntrinsicContentSize()
		}

		func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
			(view as? PasteTextView)?.acceptsEdits ?? true
		}

		func textViewDidBeginEditing(_ view: UITextView) { if !parent.isFocused { parent.isFocused = true } }
		func textViewDidEndEditing(_ view: UITextView) { if parent.isFocused { parent.isFocused = false } }
	}
}

final class PasteTextView: UITextView {
	var onPasteImages: ([NSItemProvider]) -> Void = { _ in }
	var wantsFocus = false
	var acceptsEdits = true

	/// Async, and again once in a window: a view that is not in one yet
	/// cannot become first responder.
	func applyFocus() {
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			if wantsFocus, !isFirstResponder, window != nil {
				becomeFirstResponder()
				// Focus asked for from SwiftUI (a tap beside the text, a restore) starts at the end; a tap on the text focuses the view first and keeps its caret.
				selectedRange = NSRange(location: (text as NSString).length, length: 0)
			} else if !wantsFocus, isFirstResponder {
				resignFirstResponder()
			}
		}
	}

	override func didMoveToWindow() {
		super.didMoveToWindow()
		applyFocus()
	}

	// hasImages only looks at the clipboard's types, so it does not raise "Allow Paste?".
	override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
		guard action == #selector(paste(_:)) else { return super.canPerformAction(action, withSender: sender) }
		return acceptsEdits && (super.canPerformAction(action, withSender: sender) || UIPasteboard.general.hasImages)
	}

	/// The edit menu's Paste and ⌘V.
	override func paste(_ sender: Any?) {
		guard acceptsEdits else { return }
		let providers = UIPasteboard.general.itemProviders
		if Self.isImagePaste(providers) { onPasteImages(providers) } else { super.paste(sender) }
	}

	/// Pastes and drops handed over as items rather than through the clipboard.
	override func paste(itemProviders: [NSItemProvider]) {
		guard acceptsEdits else { return }
		if Self.isImagePaste(itemProviders) { onPasteImages(itemProviders) } else { super.paste(itemProviders: itemProviders) }
	}

	/// The image wins over plain text (Safari copies an image with its
	/// link), but not over rich text: some apps copy a picture of a text
	/// selection beside it, and that should still paste as text.
	private static func isImagePaste(_ providers: [NSItemProvider]) -> Bool {
		providers.contains(where: ImagePaste.hasImage)
			&& !providers.contains { $0.hasItemConformingToTypeIdentifier(UTType.rtf.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.rtfd.identifier) }
	}
}
