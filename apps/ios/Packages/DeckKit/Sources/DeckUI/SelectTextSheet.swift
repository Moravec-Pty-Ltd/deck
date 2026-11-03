import SwiftUI
import DeckKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// What a Select Text sheet shows. Build it with `SelectableMarkdown`.
public struct SelectTextItem: Identifiable {
	public let id = UUID()
	public let text: AttributedString

	public init(_ text: AttributedString) {
		self.text = text
	}
}

/// The context-menu entry that opens a Select Text sheet.
public struct SelectTextButton: View {
	let action: () -> Void

	public init(action: @escaping () -> Void) {
		self.action = action
	}

	public var body: some View {
		Button(action: action) {
			Label("Select Text", systemImage: "text.cursor")
		}
	}
}

extension View {
	/// Presents a message in a native text view, where any range can be selected
	/// with handles (iOS) or a drag across paragraphs (Mac). SwiftUI's own
	/// `textSelection` copies a whole `Text` on iOS and stops at each block's edge.
	public func selectTextSheet(_ item: Binding<SelectTextItem?>) -> some View {
		sheet(item: item) { SelectTextSheet(text: $0.text) }
	}
}

private struct SelectTextSheet: View {
	let text: AttributedString
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			SelectableTextView(text: text)
				.navigationTitle("Select Text")
				#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
				#endif
				.toolbar {
					ToolbarItem(placement: .confirmationAction) {
						Button("Done") { dismiss() }
					}
				}
		}
		#if os(macOS)
		.frame(minWidth: 520, minHeight: 420)
		#endif
	}
}

#if canImport(UIKit)
private struct SelectableTextView: UIViewRepresentable {
	let text: AttributedString

	func makeUIView(context: Context) -> UITextView {
		let view = UITextView()
		view.isEditable = false
		view.isSelectable = true
		view.backgroundColor = .clear
		view.accessibilityIdentifier = "selectText"
		view.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12)
		view.attributedText = styled(text, body: .preferredFont(forTextStyle: .body), color: .label)
		return view
	}

	func updateUIView(_ view: UITextView, context: Context) {}
}
#elseif canImport(AppKit)
private struct SelectableTextView: NSViewRepresentable {
	let text: AttributedString

	func makeNSView(context: Context) -> NSScrollView {
		let scroll = NSTextView.scrollableTextView()
		let view = scroll.documentView as! NSTextView
		view.isEditable = false
		view.isSelectable = true
		view.drawsBackground = false
		view.textContainerInset = NSSize(width: 12, height: 16)
		view.textStorage?.setAttributedString(
			styled(text, body: .preferredFont(forTextStyle: .body), color: .labelColor))
		return scroll
	}

	func updateNSView(_ view: NSScrollView, context: Context) {}
}
#endif

#if canImport(UIKit)
private typealias PlatformFont = UIFont
private typealias PlatformColor = UIColor
#elseif canImport(AppKit)
private typealias PlatformFont = NSFont
private typealias PlatformColor = NSColor
#endif

/// Turns inline presentation intents into fonts, which the text views don't
/// do themselves. Links keep their `link` attribute and stay tappable.
private func styled(_ text: AttributedString, body: PlatformFont, color: PlatformColor) -> NSAttributedString {
	let out = NSMutableAttributedString(text)
	let all = NSRange(location: 0, length: out.length)
	out.addAttributes([.font: body, .foregroundColor: color], range: all)
	out.enumerateAttribute(.inlinePresentationIntent, in: all) { value, range, _ in
		guard let raw = value as? UInt else { return }
		let intent = InlinePresentationIntent(rawValue: raw)
		if intent.contains(.code) {
			out.addAttribute(.font, value: PlatformFont.monospacedSystemFont(ofSize: body.pointSize * 0.9, weight: .regular), range: range)
			return
		}
		#if canImport(UIKit)
		var traits: UIFontDescriptor.SymbolicTraits = []
		if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
		if intent.contains(.emphasized) { traits.insert(.traitItalic) }
		if !traits.isEmpty, let descriptor = body.fontDescriptor.withSymbolicTraits(traits) {
			out.addAttribute(.font, value: UIFont(descriptor: descriptor, size: 0), range: range)
		}
		#else
		var traits: NSFontDescriptor.SymbolicTraits = []
		if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
		if intent.contains(.emphasized) { traits.insert(.italic) }
		if !traits.isEmpty, let font = NSFont(descriptor: body.fontDescriptor.withSymbolicTraits(traits), size: 0) {
			out.addAttribute(.font, value: font, range: range)
		}
		#endif
	}
	return out
}
