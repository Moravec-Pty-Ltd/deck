import Foundation
import Observation

/// A key a shell session can be sent, by its tmux name. Only the server's
/// allowlist (terminal-core.ts) can be built, so a key never reaches deck as
/// tmux syntax it would refuse.
public struct TerminalKey: Hashable, Sendable {
	public let name: String

	private init(_ name: String) { self.name = name }

	public static let enter = TerminalKey("Enter")
	public static let escape = TerminalKey("Escape")
	public static let tab = TerminalKey("Tab")
	public static let backTab = TerminalKey("BTab")
	public static let backspace = TerminalKey("BSpace")
	public static let delete = TerminalKey("DC")
	public static let space = TerminalKey("Space")
	public static let up = TerminalKey("Up")
	public static let down = TerminalKey("Down")
	public static let left = TerminalKey("Left")
	public static let right = TerminalKey("Right")
	public static let home = TerminalKey("Home")
	public static let end = TerminalKey("End")
	public static let pageUp = TerminalKey("PPage")
	public static let pageDown = TerminalKey("NPage")

	public static let named: [TerminalKey] = [
		.enter, .escape, .tab, .backTab, .backspace, .delete, .space,
		.up, .down, .left, .right, .home, .end, .pageUp, .pageDown
	]

	/// Control plus a letter, a through z; nil for anything else.
	public static func control(_ letter: Character) -> TerminalKey? {
		let lower = Character(letter.lowercased())
		guard lower.isASCII, ("a"..."z").contains(lower) else { return nil }
		return TerminalKey("C-\(lower)")
	}

	/// A key by its tmux name, if the server accepts it.
	public init?(name: String) {
		if let key = Self.named.first(where: { $0.name == name }) {
			self = key
		} else if name.count == 3, name.hasPrefix("C-"), let key = Self.control(name.last!), key.name == name {
			self = key
		} else {
			return nil
		}
	}
}

/// Keeps a tmux pane's snapshot fresh: a shell session's terminal, or a dev
/// server's log pane. Sends the last `h` tag back so an unchanged pane costs
/// the server nothing to answer, and polls faster while someone is typing.
/// The view runs `run()` only while the app is in the foreground.
@MainActor
@Observable
public final class TerminalPoller {
	public typealias Fetch = @Sendable (_ tag: String?) async throws -> TerminalSnapshot

	/// How to type into the pane; a log pane has none.
	public struct Input: Sendable {
		public let type: @Sendable (_ text: String, _ submit: Bool) async throws -> Void
		public let press: @Sendable (TerminalKey) async throws -> Void

		public init(
			type: @escaping @Sendable (String, Bool) async throws -> Void,
			press: @escaping @Sendable (TerminalKey) async throws -> Void
		) {
			self.type = type
			self.press = press
		}
	}

	public static let focusedInterval: Duration = .seconds(1)
	public static let idleInterval: Duration = .milliseconds(2500)
	/// How long after a keystroke to look again, so its effect shows promptly.
	static let echoDelay: Duration = .milliseconds(300)
	private static let tagLimit = 64

	public private(set) var text = ""
	public private(set) var runs: [AnsiRun] = []
	public private(set) var cleared = false
	public private(set) var dead = false
	public private(set) var loaded = false
	/// False while the server can't be reached; the last screen stays up.
	public private(set) var connected = true
	public private(set) var inputError: String?
	/// Set by the view while the input line or the screen has keyboard focus.
	public var focused = false
	private(set) var tag: String?
	private var generation = 0

	private let fetch: Fetch
	private let input: Input?

	public init(fetch: @escaping Fetch, input: Input? = nil) {
		self.fetch = fetch
		self.input = input
	}

	public var canType: Bool { input != nil }

	public var interval: Duration { focused ? Self.focusedInterval : Self.idleInterval }

	public static func shell(client: DeckClient, sessionId: String) -> TerminalPoller {
		TerminalPoller(
			fetch: { try await client.terminal(sessionId: sessionId, tag: $0) },
			input: Input(
				type: { try await client.typeInTerminal(sessionId: sessionId, text: $0, submit: $1) },
				press: { try await client.pressInTerminal(sessionId: sessionId, key: $0) }))
	}

	public static func serverLogs(client: DeckClient, sessionId: String, name: String) -> TerminalPoller {
		TerminalPoller(fetch: { try await client.serverLogs(sessionId: sessionId, name: name, tag: $0) })
	}

	/// Poll until the calling task is cancelled.
	public func run() async {
		while !Task.isCancelled {
			await refresh()
			try? await Task.sleep(for: interval)
		}
	}

	/// A keystroke's refresh can overlap the loop's, and their answers can land
	/// in either order, so only the latest-started one may touch the screen.
	public func refresh() async {
		generation &+= 1
		let mine = generation
		let result: Result<TerminalSnapshot, Error>
		do {
			result = .success(try await fetch(tag))
		} catch {
			result = .failure(error)
		}
		guard mine == generation else { return }
		take(result)
	}

	private func take(_ result: Result<TerminalSnapshot, Error>) {
		do {
			let snapshot = try result.get()
			connected = true
			apply(snapshot)
		} catch is CancellationError {
		} catch DeckError.http {
			// Reachable but refused (a deleted session, say): keep what is shown.
			connected = true
		} catch let error as URLError where error.code == .cancelled {
		} catch {
			connected = false
		}
	}

	func apply(_ snapshot: TerminalSnapshot) {
		loaded = true
		if snapshot.unchanged == true { return }
		tag = snapshot.h.map { String($0.prefix(Self.tagLimit)) }
		text = snapshot.text ?? ""
		runs = AnsiParser.parse(text)
		dead = snapshot.dead ?? false
		cleared = snapshot.cleared ?? false
	}

	/// Type a line, pressing Enter after it unless `submit` is false. Returns
	/// whether deck took it, so the view clears the line only then.
	@discardableResult
	public func type(_ line: String, submit: Bool = true) async -> Bool {
		guard let input else { return false }
		return await send { try await input.type(line, submit) }
	}

	public func press(_ key: TerminalKey) async {
		guard let input else { return }
		await send { try await input.press(key) }
	}

	@discardableResult
	private func send(_ action: () async throws -> Void) async -> Bool {
		do {
			try await action()
			inputError = nil
		} catch {
			inputError = error.localizedDescription
			return false
		}
		// Drop the tag so the next answer is the whole screen, then look again
		// soon enough for the keystroke's effect to show.
		tag = nil
		try? await Task.sleep(for: Self.echoDelay)
		await refresh()
		return true
	}
}
