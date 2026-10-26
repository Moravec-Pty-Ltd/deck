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
		if view.text != text, view.markedTextRange == nil {
			view.text = text
			UIView.performWithoutAnimation { view.scrollRangeToVisible(view.selectedRange) }
		}
		view.wantsFocus = isFocused
		view.applyFocus()
	}

	func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PasteTextView, context: Context) -> CGSize? {
		let width = proposal.width ?? view.bounds.width
		guard width > 0 else { return nil }
		return CGSize(width: width, height: min(view.fittedHeight(width: width), view.cap))
	}

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	final class Coordinator: NSObject, UITextViewDelegate {
		var parent: ComposerTextField
		init(_ parent: ComposerTextField) { self.parent = parent }

		func textViewDidChange(_ view: UITextView) {
			parent.text = view.text
			view.invalidateIntrinsicContentSize()
			(view as? PasteTextView)?.fitScrolling()
			// Under the cap the field grows to the caret instead; scrolling there moves the first line until the resize lands.
			if view.isScrollEnabled { UIView.performWithoutAnimation { view.scrollRangeToVisible(view.selectedRange) } }
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
				UIView.performWithoutAnimation { self.scrollRangeToVisible(self.selectedRange) }
			} else if !wantsFocus, isFirstResponder {
				resignFirstResponder()
			}
		}
	}

	/// Five laid-out lines, measured: TextKit lines are taller than the font's lineHeight, so five of those cut the fifth line short.
	var cap: CGFloat {
		if let capCache, capCache.font == font { return capCache.height }
		let probe = UITextView()
		probe.font = font
		probe.textContainerInset = textContainerInset
		probe.textContainer.lineFragmentPadding = textContainer.lineFragmentPadding
		probe.text = "1\n2\n3\n4\n5"
		let height = ceil(probe.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).height)
		capCache = (font, height)
		return height
	}

	private var capCache: (font: UIFont?, height: CGFloat)?

	func fittedHeight(width: CGFloat) -> CGFloat {
		sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
	}

	/// Scrolls only past the cap, since a scrolling text view shows no edit menu on a long press.
	/// Set on an edit or a resize rather than while SwiftUI sizes the field: flipped during layout, it re-entered layout and made the height bounce.
	func fitScrolling() {
		guard bounds.width > 0 else { return }
		let scrolls = fittedHeight(width: bounds.width) > cap
		guard scrolls != isScrollEnabled else { return }
		isScrollEnabled = scrolls
		UIView.performWithoutAnimation {
			if !scrolls { contentOffset = .zero; return }
			// The field is already at the cap, so no resize follows to bring the caret line in; lay out with scrolling on, then reveal it.
			layoutIfNeeded()
			scrollRangeToVisible(selectedRange)
		}
	}

	private var laidOut: (size: CGSize, content: CGFloat) = (.zero, 0)

	// The caret scroll runs before the field grows to fit, so a field that now fits its text drops the leftover offset.
	// Not on every pass: layoutSubviews also runs on every scroll, and clamping there kills the bounce.
	override func layoutSubviews() {
		super.layoutSubviews()
		guard !isTracking, !isDecelerating, bounds.size != laidOut.size || contentSize.height != laidOut.content else { return }
		let resized = bounds.height != laidOut.size.height
		laidOut = (bounds.size, contentSize.height)
		fitScrolling()
		let maxY = max(0, contentSize.height + adjustedContentInset.bottom - bounds.height)
		UIView.performWithoutAnimation {
			if contentOffset.y > maxY { contentOffset.y = maxY }
			// contentSize is TextKit 2's estimate, so the clamp can cut the caret line; this lays it out for real.
			if resized { scrollRangeToVisible(selectedRange) }
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
