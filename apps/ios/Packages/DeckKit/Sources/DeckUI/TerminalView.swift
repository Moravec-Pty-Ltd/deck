import SwiftUI
import DeckKit

extension AttributedString {
	/// ANSI runs as styled text. Uncoloured text keeps the view's own
	/// foreground, so the default reads in light and dark alike.
	public init(ansi runs: [AnsiRun]) {
		self.init()
		for run in runs {
			var piece = AttributedString(run.text)
			let style = run.style
			var foreground = style.foreground.map(Color.init(ansi:))
			var background = style.background.map(Color.init(ansi:))
			if style.inverse {
				(foreground, background) = (background ?? .deckBackground, foreground ?? .primary)
			}
			if style.dim { foreground = (foreground ?? .primary).opacity(0.65) }
			if let foreground { piece.foregroundColor = foreground }
			if let background { piece.backgroundColor = background }
			var intent: InlinePresentationIntent = []
			if style.bold { intent.insert(.stronglyEmphasized) }
			if style.italic { intent.insert(.emphasized) }
			if !intent.isEmpty { piece.inlinePresentationIntent = intent }
			if style.underline { piece.underlineStyle = .single }
			append(piece)
		}
	}
}

extension Color {
	init(ansi color: AnsiColor) {
		self.init(red: Double(color.red) / 255, green: Double(color.green) / 255, blue: Double(color.blue) / 255)
	}
}

/// A tmux pane: a shell session's terminal, or (with no input) a dev
/// server's log. Follows the newest output while the reader is at the end and
/// leaves them where they are once they scroll up. Polls only while the app
/// is in the foreground.
public struct TerminalView: View {
	let poller: TerminalPoller
	var emptyText: String

	@Environment(\.scenePhase) private var scenePhase
	@State private var line = ""
	@State private var atEnd = true
	@FocusState private var focus: Field?

	private enum Field { case line, screen }

	private static let keyBar: [(label: String, key: TerminalKey)] = [
		("enter", .enter), ("ctrl-c", .control("c")!), ("esc", .escape),
		("up", .up), ("down", .down), ("tab", .tab), ("ctrl-d", .control("d")!)
	]

	public init(poller: TerminalPoller, emptyText: String = "(empty)") {
		self.poller = poller
		self.emptyText = emptyText
	}

	public var body: some View {
		VStack(spacing: 0) {
			banner
			screen
			if poller.canType {
				Divider()
				inputBar
			}
		}
		.task(id: scenePhase == .background) {
			guard scenePhase != .background else { return }
			await poller.run()
		}
		.onChange(of: focus) { _, focus in poller.focused = focus != nil }
	}

	@ViewBuilder
	private var banner: some View {
		let message: String? = !poller.connected
			? "Reconnecting…"
			: poller.cleared ? "The program cleared the screen; showing its last output." : nil
		if let message {
			Text(message)
				.font(.caption)
				.foregroundStyle(poller.connected ? Color.secondary : Color.orange)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal)
				.padding(.vertical, 6)
		}
	}

	private var screen: some View {
		ScrollViewReader { proxy in
			ScrollView {
				Text(poller.text.isEmpty ? AttributedString(poller.loaded ? emptyText : "connecting…") : AttributedString(ansi: poller.runs))
					.font(.system(.caption, design: .monospaced))
					.textSelection(.enabled)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(10)
				Color.clear.frame(height: 1).id("end")
			}
			.modifier(FollowEnd(atEnd: $atEnd) { proxy.scrollTo("end", anchor: .bottom) })
			.background(Color.deckSecondaryGroupedBackground)
			.focusable(poller.canType && !poller.dead)
			.focused($focus, equals: .screen)
			.onKeyPress(phases: .down) { press in handle(press, typing: true) }
		}
	}

	private var inputBar: some View {
		VStack(spacing: 8) {
			ScrollView(.horizontal, showsIndicators: false) {
				HStack(spacing: 6) {
					ForEach(Self.keyBar, id: \.label) { entry in
						Button(entry.label) { Task { await poller.press(entry.key) } }
							.font(.caption.monospaced())
							.buttonStyle(.bordered)
							.controlSize(.small)
					}
				}
			}
			HStack(spacing: 8) {
				TextField(poller.dead ? "session is dead" : "type a command, return to send", text: $line)
					.font(.callout.monospaced())
					.textFieldStyle(.roundedBorder)
					.autocorrectionDisabled()
					#if os(iOS)
					.textInputAutocapitalization(.never)
					#endif
					.focused($focus, equals: .line)
					.onSubmit { send() }
					.onKeyPress(phases: .down) { press in handle(press, typing: false) }
				Button {
					send()
				} label: {
					Image(systemName: "paperplane.fill")
				}
				.buttonStyle(.borderedProminent)
				.accessibilityLabel("Send")
			}
			if let error = poller.inputError {
				Text(error)
					.font(.caption)
					.foregroundStyle(.red)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.disabled(poller.dead)
		.padding(10)
	}

	private func send() {
		let text = line
		focus = .line
		Task {
			if await poller.type(text) { if line == text { line = "" } }
		}
	}

	/// Hardware keys. On the screen everything goes straight to the pane; in
	/// the input line only the keys a line editor has no use for do.
	private func handle(_ press: KeyPress, typing: Bool) -> KeyPress.Result {
		if let key = Self.terminalKey(for: press, typing: typing) {
			Task { await poller.press(key) }
			return .handled
		}
		// Function keys arrive as private-use characters, which mean nothing to
		// a shell.
		let printable = !press.characters.isEmpty
			&& press.characters.unicodeScalars.allSatisfy { !(0xF700...0xF8FF).contains($0.value) }
		guard typing, printable, press.modifiers.isDisjoint(with: [.command, .control]) else {
			return .ignored
		}
		Task { await poller.type(press.characters, submit: false) }
		return .handled
	}

	static func terminalKey(for press: KeyPress, typing: Bool) -> TerminalKey? {
		if press.modifiers.contains(.control), let letter = press.key.character.lowercased().first {
			// A line editor keeps its own ctrl bindings; only interrupt and
			// end-of-input reach the pane from there.
			return typing || letter == "c" || letter == "d" ? TerminalKey.control(letter) : nil
		}
		switch press.key {
		case .upArrow: return .up
		case .downArrow: return .down
		case .escape: return .escape
		case .tab: return .tab
		default: return typing ? screenKey(press.key) : nil
		}
	}

	private static func screenKey(_ key: KeyEquivalent) -> TerminalKey? {
		switch key {
		case .return: return .enter
		case .delete: return .backspace
		case .deleteForward: return .delete
		case .leftArrow: return .left
		case .rightArrow: return .right
		case .home: return .home
		case .end: return .end
		case .pageUp: return .pageUp
		case .pageDown: return .pageDown
		default: return nil
		}
	}
}

/// Keeps the end of a scroll view in view while the reader is there. Only the
/// reader's own scrolling decides whether they are, so a pin that lands short
/// can't switch following off.
private struct FollowEnd: ViewModifier {
	@Binding var atEnd: Bool
	let pin: () -> Void

	func body(content: Content) -> some View {
		if #available(iOS 18, macOS 15, *) {
			content
				.defaultScrollAnchor(.bottom, for: .initialOffset)
				.onScrollPhaseChange { old, phase, context in
					let userMoved = phase == .interacting || phase == .decelerating || (phase == .idle && old != .animating)
					guard userMoved else { return }
					let geometry = context.geometry
					atEnd = geometry.contentSize.height - geometry.contentOffset.y - geometry.containerSize.height < 40
				}
				.onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { old, height in
					if height != old, atEnd { pin() }
				}
		} else {
			content
		}
	}
}
