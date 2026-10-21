import Foundation

/// One section of the quick-message editor: Global, or one project's messages.
/// Mirrors deck's `groupByScope` in quick-messages-core.ts.
public struct QuickMessageScope: Identifiable, Equatable, Sendable {
	/// nil is Global.
	public let projectId: String?
	public let label: String
	/// The section's message ids, in stored order.
	public let ids: [String]

	public var id: String { projectId ?? "" }
}

extension QuickMessage {
	/// The editor's sections: Global first (always, so there is somewhere to
	/// add), then each project with messages in registered order, then any scope
	/// whose project is no longer registered, labelled by its path.
	public static func scopes(_ list: [QuickMessage], projects: [DeckProject]) -> [QuickMessageScope] {
		var byScope: [String: [String]] = [:]
		var unknown: [String] = []
		for message in list {
			let key = message.projectId ?? ""
			if byScope[key] == nil, !key.isEmpty, !projects.contains(where: { $0.path == key }) { unknown.append(key) }
			byScope[key, default: []].append(message.id)
		}
		var scopes = [QuickMessageScope(projectId: nil, label: "Global", ids: byScope[""] ?? [])]
		for project in projects {
			if let ids = byScope[project.path] { scopes.append(QuickMessageScope(projectId: project.path, label: project.name, ids: ids)) }
		}
		for path in unknown { scopes.append(QuickMessageScope(projectId: path, label: path, ids: byScope[path] ?? [])) }
		return scopes
	}

	/// Reorder within one scope, as a section's `.onMove` reports it, leaving
	/// every other message where it is: the scope's messages are rearranged
	/// among the slots they already hold.
	public static func move(_ list: inout [QuickMessage], scope projectId: String?, fromOffsets source: IndexSet, toOffset destination: Int) {
		let slots = list.indices.filter { list[$0].projectId == projectId }
		let members = slots.map { list[$0] }
		// SwiftUI's move(fromOffsets:toOffset:), which DeckKit cannot import.
		var reordered = members.indices.filter { !source.contains($0) }.map { members[$0] }
		let insertAt = destination - source.filter { $0 < destination }.count
		reordered.insert(contentsOf: source.map { members[$0] }, at: min(max(insertAt, 0), reordered.count))
		for (slot, message) in zip(slots, reordered) { list[slot] = message }
	}

	/// Give a message a new scope (nil or empty is Global), placing it last in
	/// that scope's section.
	public static func setScope(_ list: inout [QuickMessage], id: String, to projectId: String?) {
		guard let index = list.firstIndex(where: { $0.id == id }) else { return }
		var message = list.remove(at: index)
		message.projectId = projectId?.isEmpty == false ? projectId : nil
		list.append(message)
	}
}
