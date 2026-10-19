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
