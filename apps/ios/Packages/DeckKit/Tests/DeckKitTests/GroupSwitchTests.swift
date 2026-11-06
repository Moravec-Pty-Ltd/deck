import XCTest
@testable import DeckKit

/// The same cases as the "group switcher" block in `src/lib/groups.test.ts`.
final class GroupSwitchTests: XCTestCase {
	private let projects = [
		DeckProject(path: "/p/web", name: "web", group: "Client A", hidden: nil),
		DeckProject(path: "/p/api", name: "api", group: "Client A", hidden: nil),
		DeckProject(path: "/p/site", name: "site", group: "Client B", hidden: nil),
		DeckProject(path: "/p/scratch", name: "scratch", group: nil, hidden: nil)
	]
	private let ungrouped = SessionGrouping.ungrouped

	private func session(
		_ id: String, cwd: String, asking: Bool = false, unread: Bool = false, hidden: Bool = false, repo: String? = nil
	) -> SessionDigest {
		let worktree = repo.map { #","worktree":{"repo":"\#($0)","branch":"b"}"# } ?? ""
		let json = #"{"id":"\#(id)","status":"idle","cwd":"\#(cwd)","awaitingInput":\#(asking),"unread":\#(unread),"hidden":\#(hidden)\#(worktree)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	func testWorktreeSessionsGoUnderTheirRepoAndAnythingElseUnderUngrouped() {
		XCTAssertEqual(GroupSwitch.group(of: session("a", cwd: "/p/web-worktrees/feature"), in: projects), "Client A")
		XCTAssertEqual(GroupSwitch.group(of: session("b", cwd: "/elsewhere", repo: "/p/site"), in: projects), "Client B")
		XCTAssertEqual(GroupSwitch.group(of: session("c", cwd: "/p/site/sub"), in: projects), "Client B")
		XCTAssertEqual(GroupSwitch.group(of: session("d", cwd: "/p/scratch"), in: projects), ungrouped)
		XCTAssertEqual(GroupSwitch.group(of: session("e", cwd: "/tmp/adhoc"), in: projects), ungrouped)
		XCTAssertEqual(GroupSwitch.group(ofPath: "", in: projects), ungrouped)
	}

	func testListsAllEachGroupThenUngrouped() {
		let entries = GroupSwitch.entries([], projects: projects)
		XCTAssertEqual(entries.map(\.label), ["All", "Client A", "Client B", ungrouped])
		XCTAssertNil(entries[0].name)
	}

	func testListsUngroupedOnlyWhenAProjectOrSessionLandsThere() {
		let grouped = projects.filter { $0.group != nil }
		XCTAssertEqual(GroupSwitch.entries([], projects: grouped).map(\.label), ["All", "Client A", "Client B"])
		let adhoc = [session("s", cwd: "/tmp/adhoc")]
		XCTAssertEqual(GroupSwitch.entries(adhoc, projects: grouped).map(\.label), ["All", "Client A", "Client B", ungrouped])
	}

	func testListsNothingWhenNoProjectHasAGroup() {
		let none = [DeckProject(path: "/p/scratch", name: "scratch", group: nil, hidden: nil)]
		XCTAssertTrue(GroupSwitch.entries([session("s", cwd: "/tmp")], projects: none).isEmpty)
	}

	func testCountsAskingAndUnreadPerGroupLeavingOutHiddenAndQuiet() {
		let entries = GroupSwitch.entries([
			session("a", cwd: "/p/web-worktrees/feature", asking: true),
			session("b", cwd: "/p/api", unread: true),
			session("quiet", cwd: "/p/web"),
			session("gone", cwd: "/p/site", asking: true, hidden: true),
			session("c", cwd: "/tmp/adhoc", asking: true)
		], projects: projects)
		XCTAssertEqual(
			Dictionary(uniqueKeysWithValues: entries.map { ($0.label, $0.count) }),
			["All": 3, "Client A": 2, "Client B": 0, ungrouped: 1])
	}

	func testFlagsWaitingInAnotherGroupOnly() {
		let entries = GroupSwitch.entries([session("a", cwd: "/p/web", asking: true)], projects: projects)
		XCTAssertTrue(GroupSwitch.waitingElsewhere(entries, selected: "Client B"))
		XCTAssertFalse(GroupSwitch.waitingElsewhere(entries, selected: "Client A"))
		XCTAssertFalse(GroupSwitch.waitingElsewhere(entries, selected: nil))
	}

	func testFallsBackToAllWhenThePickedGroupHasGone() {
		let entries = GroupSwitch.entries([], projects: projects)
		XCTAssertEqual(GroupSwitch.resolved(picked: "Client A", in: entries), "Client A")
		XCTAssertNil(GroupSwitch.resolved(picked: "Deleted", in: entries))
		XCTAssertNil(GroupSwitch.resolved(picked: "", in: entries))
		XCTAssertNil(GroupSwitch.resolved(picked: "Client A", in: []))
	}

	func testFiltersToTheSelectedGroupAndAllKeepsEverything() {
		let sessions = [session("wt", cwd: "/p/web-worktrees/feature"), session("b", cwd: "/p/site"), session("adhoc", cwd: "/tmp/adhoc")]
		let ids = { (selected: String?) in GroupSwitch.sessions(sessions, in: selected, projects: self.projects).map(\.id) }
		XCTAssertEqual(ids("Client A"), ["wt"])
		XCTAssertEqual(ids(self.ungrouped), ["adhoc"])
		XCTAssertEqual(ids(nil), ["wt", "b", "adhoc"])
	}

	func testAHiddenProjectStaysInItsGroup() {
		let hiding = [
			DeckProject(path: "/p/web", name: "web", group: "Client A", hidden: true),
			DeckProject(path: "/p/site", name: "site", group: "Client B", hidden: nil)
		]
		let sessions = [session("h", cwd: "/p/web", hidden: true), session("b", cwd: "/p/site")]
		XCTAssertEqual(GroupSwitch.sessions(sessions, in: "Client A", projects: hiding).map(\.id), ["h"])
		XCTAssertTrue(GroupSwitch.entries([], projects: hiding).map(\.label).contains("Client A"))
	}

	func testFollowsAnOpenedSessionToItsGroupUnlessOnAll() {
		let other = session("o", cwd: "/p/site")
		XCTAssertEqual(GroupSwitch.afterOpening(other, projects: projects, selected: "Client A"), "Client B")
		XCTAssertEqual(GroupSwitch.afterOpening(session("m", cwd: "/p/web"), projects: projects, selected: "Client A"), "Client A")
		XCTAssertNil(GroupSwitch.afterOpening(other, projects: projects, selected: nil))
	}

	func testOrdersThePickerWithTheGroupFirstAndTheRestUnderOtherGroups() {
		let withHidden = projects + [DeckProject(path: "/p/old", name: "old", group: "Client A", hidden: true)]
		let sections = GroupSwitch.pickerGroups(withHidden, selected: "Client B")
		XCTAssertEqual(sections.map(\.name), ["Client B", GroupSwitch.otherGroups, ProjectGroups.hidden])
		XCTAssertEqual(sections[0].projects.map(\.name), ["site"])
		XCTAssertEqual(sections[1].projects.map(\.name), ["api", "scratch", "web"])
		XCTAssertEqual(sections[2].projects.map(\.name), ["old"])
		XCTAssertEqual(GroupSwitch.pickerGroups(projects, selected: nil).map(\.name), ["Client A", "Client B", ProjectGroups.ungrouped])
	}

	func testThePickerCallsTheNoGroupBucketUngroupedWhenItIsSelected() {
		XCTAssertEqual(GroupSwitch.pickerGroups(projects, selected: ungrouped).first?.name, ungrouped)
		XCTAssertEqual(GroupSwitch.pickerGroups(projects, selected: ungrouped).first?.projects.map(\.name), ["scratch"])
	}

	func testStartsInTheSelectedGroupKeepingAPickThatFits() {
		let web = projects[0], site = projects[2]
		let start = { (open: SessionDigest?, current: DeckProject?, group: String?) in
			SessionProject.startDefault(openSession: open, current: current, in: self.projects, group: group)?.name
		}
		XCTAssertEqual(start(nil, site, "Client A"), "api")
		XCTAssertEqual(start(nil, web, "Client A"), "web")
		XCTAssertEqual(start(nil, nil, "Client A"), "api")
		XCTAssertEqual(start(self.session("o", cwd: "/p/site"), web, "Client A"), "web")
		XCTAssertEqual(start(nil, site, nil), "site")
		XCTAssertEqual(start(nil, nil, nil), "web")
	}

	func testRunsFilterByTheirProject() throws {
		let run = { (id: String, path: String) in
			try JSONDecoder().decode(RunDigest.self, from: Data(#"{"id":"\#(id)","workflow":{"id":"w","name":"n","category":"dev"},"title":"t","projectPath":"\#(path)","cwd":"\#(path)-worktrees/x","branch":"b","status":"running","phase":"p","round":0,"loop":false,"blockers":0,"findings":[],"escalations":{"implementer":false,"disagreement":false,"cap":false},"humanTouched":false,"phases":[],"createdAt":1,"updatedAt":1}"#.utf8))
		}
		let runs = [try run("a", "/p/web"), try run("b", "/p/site")]
		XCTAssertEqual(GroupSwitch.runs(runs, in: "Client B", projects: projects).map(\.id), ["b"])
		XCTAssertEqual(GroupSwitch.runs(runs, in: nil, projects: projects).map(\.id), ["a", "b"])
	}

	func testSchedulesFilterByTheirDirectoryOrTheirSessionsProject() throws {
		let schedule = { (id: String, target: String) in
			try JSONDecoder().decode(DeckSchedule.self, from: Data(#"{"id":"\#(id)","title":"t","cron":"0 9 * * *","prompt":"p","enabled":true,\#(target),"createdAt":1,"runs":0}"#.utf8))
		}
		let schedules = [
			try schedule("dir", #""cwd":"/p/web""#),
			try schedule("live", #""sessionId":"s1""#),
			try schedule("gone", #""sessionId":"missing""#)
		]
		let sessions = [session("s1", cwd: "/p/site")]
		let ids = { (group: String?) in
			GroupSwitch.schedules(schedules, in: group, sessions: sessions, projects: self.projects).map(\.id)
		}
		XCTAssertEqual(ids("Client A"), ["dir"])
		XCTAssertEqual(ids("Client B"), ["live"])
		XCTAssertEqual(ids(self.ungrouped), ["gone"])
		XCTAssertEqual(ids(nil), ["dir", "live", "gone"])
	}

	func testPaletteListsTheOtherGroupsAndReadsThePickBack() {
		let entries = GroupSwitch.entries([], projects: projects)
		let actions = GroupSwitch.paletteActions(entries, selected: "Client A")
		XCTAssertEqual(actions.map(\.title), ["Switch to All", "Switch to Client B", "Switch to \(ungrouped)"])
		XCTAssertEqual(actions.map { GroupSwitch.storedValue(for: $0) }, ["", "Client B", ungrouped])
		XCTAssertEqual(actions[1].shortcut, "⌘3")
		XCTAssertNil(GroupSwitch.storedValue(for: .inbox))
	}
}
