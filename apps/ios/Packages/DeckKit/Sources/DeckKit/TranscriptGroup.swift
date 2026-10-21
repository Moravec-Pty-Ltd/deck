import Foundation

/// Consecutive tool calls and intervening thinking, matching the web Chat view.
public struct TranscriptGroup: Identifiable, Equatable, Sendable {
	public let items: [TranscriptItem]
	public var id: String { items[0].id }
	public var toolCount: Int {
		items.reduce(0) { count, item in
			if case .tool = item { return count + 1 }
			return count
		}
	}
	public var isCollapsedRun: Bool { toolCount > 1 }

	public static func make(_ items: [TranscriptItem], condensed: Bool) -> [TranscriptGroup] {
		guard condensed else { return items.map { TranscriptGroup(items: [$0]) } }
		var groups: [TranscriptGroup] = []
		var run: [TranscriptItem] = []
		func flush() {
			guard !run.isEmpty else { return }
			let group = TranscriptGroup(items: run)
			groups += group.isCollapsedRun ? [group] : run.map { TranscriptGroup(items: [$0]) }
			run = []
		}
		for item in items {
			switch item {
			case .thinking:
				run.append(item)
			case .tool(let call) where !call.isAsk:
				run.append(item)
			default:
				flush()
				groups.append(TranscriptGroup(items: [item]))
			}
		}
		flush()
		return groups
	}
}

/// The transcript with each subagent's items lifted out of the thread and filed
/// under the call that launched it, matching the web view's `nestSubagents`.
/// Background subagents keep producing events long after their call returned,
/// interleaved with the main thread and each other, so they are filed by parent
/// id rather than by position. An item whose launcher isn't loaded stays in the
/// thread so nothing goes missing, and an ask stays there too: it is how a
/// blocked session gets answered.
public struct TranscriptThread: Equatable, Sendable {
	public let items: [TranscriptItem]
	/// A subagent's items, by the id of the call that launched it.
	public let steps: [String: [TranscriptItem]]

	public static func make(_ items: [TranscriptItem], parents: [String: String]) -> TranscriptThread {
		var calls = Set<String>()
		for case .tool(let call) in items { calls.insert(call.id) }
		var main: [TranscriptItem] = []
		var steps: [String: [TranscriptItem]] = [:]
		for item in items {
			if case .tool(let call) = item, call.isAsk {
				main.append(item)
			} else if let parent = parents[item.id], calls.contains(parent) {
				steps[parent, default: []].append(item)
			} else {
				main.append(item)
			}
		}
		return TranscriptThread(items: main, steps: steps)
	}

	/// The thread row that shows `id`: the row itself, or the outermost card a
	/// subagent's step folds into. Nil when it isn't loaded.
	public func threadItemId(for id: String) -> String? {
		if items.contains(where: { $0.id == id }) { return id }
		var launcher: [String: String] = [:]
		for (call, list) in steps {
			for item in list { launcher[item.id] = "tool-\(call)" }
		}
		var current = id
		var seen = Set<String>()
		while let card = launcher[current], seen.insert(card).inserted { current = card }
		return current == id ? nil : current
	}
}
