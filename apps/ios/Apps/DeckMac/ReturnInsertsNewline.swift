import SwiftUI
import AppKit

extension View {
	/// Return adds a line to a vertical text field, as the phone's composer
	/// does, and ⌘Return is left to the window's Send. A Return that commits an
	/// input method's marked text (Japanese, Chinese) stays with the input method.
	func returnInsertsNewline(_ focused: FocusState<Bool>.Binding) -> some View {
		modifier(ReturnInsertsNewline(focused: focused))
	}
}

private struct ReturnInsertsNewline: ViewModifier {
	let focused: FocusState<Bool>.Binding
	@State private var monitor: Any?
	@State private var windowIsKey = false
	@Environment(\.controlActiveState) private var activeState

	func body(content: Content) -> some View {
		content
			// The monitor sees every window's keys; only the key window's field answers.
			.onChange(of: activeState, initial: true) { windowIsKey = activeState == .key }
			.onAppear {
				guard monitor == nil else { return }
				monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { newline($0) ? nil : $0 }
			}
			.onDisappear {
				if let monitor { NSEvent.removeMonitor(monitor) }
				monitor = nil
			}
	}

	private func newline(_ event: NSEvent) -> Bool {
		guard focused.wrappedValue, windowIsKey,
			// Return, or Enter on the keypad.
			event.charactersIgnoringModifiers == "\r" || event.charactersIgnoringModifiers == "\u{3}",
			event.modifierFlags.intersection([.command, .option, .control]).isEmpty,
			let editor = event.window?.firstResponder as? NSTextView, editor.isFieldEditor,
			!editor.hasMarkedText() else { return false }
		editor.insertNewlineIgnoringFieldEditor(nil)
		return true
	}
}
