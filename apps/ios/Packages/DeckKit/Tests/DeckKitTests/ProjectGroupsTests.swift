import XCTest
@testable import DeckKit

/// The same ordering as deck's `groupProjects` tests, so the two lists cannot
/// disagree about where a project belongs.
final class ProjectGroupsTests: XCTestCase {
	private func project(_ name: String, group: String? = nil, hidden: Bool = false) -> DeckProject {
		DeckProject(path: "/p/\(name)", name: name, group: group, hidden: hidden ? true : nil)
	}

	func testGroupsSortAlphabeticallyWithProjectsThenHiddenLast() {
		let groups = ProjectGroups.grouped([
			project("zeta", group: "Work"),
			project("alpha", group: "Work"),
			project("solo", group: "Personal"),
			project("loose"),
			project("gone", group: "Work", hidden: true)
		])
		XCTAssertEqual(groups.map(\.name), ["Personal", "Work", "Projects", "Hidden"])
	}

	func testAHiddenProjectLeavesItsGroup() {
		let groups = ProjectGroups.grouped([
			project("kept", group: "Work"),
			project("gone", group: "Work", hidden: true)
		])
		XCTAssertEqual(groups.first { $0.name == "Work" }?.projects.map(\.name), ["kept"])
		XCTAssertEqual(groups.first { $0.name == "Hidden" }?.projects.map(\.name), ["gone"])
	}

	func testProjectsWithinAGroupSortByName() {
		let groups = ProjectGroups.grouped([project("zeta", group: "W"), project("alpha", group: "W")])
		XCTAssertEqual(groups.first?.projects.map(\.name), ["alpha", "zeta"])
	}

	func testNoHiddenGroupUntilSomethingIsHidden() {
		let groups = ProjectGroups.grouped([project("one"), project("two", group: "W")])
		XCTAssertFalse(groups.contains { $0.name == "Hidden" })
	}
}
