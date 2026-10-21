import Foundation

/// How the app lists projects: clustered by their group, alphabetically, with
/// the hidden ones gathered under "Hidden" at the bottom. Mirrors deck's
/// `groupProjects` in `src/lib/groups.ts`, except that deck calls the no-group
/// bucket "Ungrouped" and the app has always called it "Projects".
public enum ProjectGroups {
	/// The bucket a hidden project leaves its group for, which is the point of
	/// hiding it.
	public static let hidden = "Hidden"

	/// The bucket for a project with no group of its own.
	public static let ungrouped = "Projects"

	public struct Group: Identifiable, Sendable {
		public var id: String { name }
		public let name: String
		public let projects: [DeckProject]
	}

	public static func grouped(_ projects: [DeckProject]) -> [Group] {
		let buckets = Dictionary(grouping: projects) { project in
			project.hidden == true ? hidden : (project.group ?? ungrouped)
		}
		return buckets.keys
			.sorted(by: before)
			.map { Group(name: $0, projects: buckets[$0]!.sorted { $0.name < $1.name }) }
	}

	/// Alphabetical, but "Projects" then "Hidden" sort to the bottom whatever
	/// they would do alphabetically.
	private static func before(_ a: String, _ b: String) -> Bool {
		let rank = { (name: String) in name == hidden ? 2 : name == ungrouped ? 1 : 0 }
		return rank(a) == rank(b) ? a < b : rank(a) < rank(b)
	}
}
