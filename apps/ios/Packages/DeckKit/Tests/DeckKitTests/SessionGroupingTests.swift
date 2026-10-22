import XCTest
@testable import DeckKit

final class SessionGroupingTests: XCTestCase {
	private let now = Date(timeIntervalSince1970: 1_000_000)
	private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

	private func session(
		_ id: String, status: String = "idle", asking: Bool = false, cwd: String? = nil,
		agoSeconds: Double = 3600, repo: String? = nil
	) -> SessionDigest {
		let worktree = repo.map { #","worktree":{"repo":"\#($0)","branch":"b"}"# } ?? ""
		let dir = cwd.map { #","cwd":"\#($0)""# } ?? ""
		let json = #"{"id":"\#(id)","status":"\#(status)","awaitingInput":\#(asking),"lastActiveAt":\#(nowMs - agoSeconds * 1000)\#(dir)\#(worktree)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private func project(_ name: String, group: String? = nil) -> DeckProject {
		DeckProject(path: "/p/\(name)", name: name, group: group, hidden: nil)
	}

	// MARK: status

	func testBucketsFollowTheFixedOrderAndDropEmptyOnes() {
		let sections = SessionGrouping.byStatus([
			session("dead", status: "dead"),
			session("idle", agoSeconds: 3600),
			session("run", status: "running"),
			session("fresh", agoSeconds: 60)
		], now: now)
		XCTAssertEqual(sections.map(\.bucket), [.active, .justFinished, .idle, .dead])
		XCTAssertEqual(sections.map(\.bucket.label), ["Active", "Just finished", "Idle", "Dead"])
	}

	func testAskingAndErroredSessionsNeedAttention() {
		let sections = SessionGrouping.byStatus([
			session("ask", status: "running", asking: true),
			session("err", status: "error"),
			session("run", status: "running")
		], now: now)
		XCTAssertEqual(sections.map(\.bucket), [.needsAttention, .active])
		XCTAssertEqual(Set(sections[0].sessions.map(\.id)), ["ask", "err"])
	}

	func testTheFifteenMinuteBoundaryIsInclusive() {
		let sections = SessionGrouping.byStatus([
			session("edge", agoSeconds: 15 * 60),
			session("past", agoSeconds: 15 * 60 + 1)
		], now: now)
		XCTAssertEqual(sections.map(\.bucket), [.justFinished, .idle])
		XCTAssertEqual(sections[0].sessions.map(\.id), ["edge"])
	}

	func testEachBucketIsNewestFirst() {
		let sections = SessionGrouping.byStatus([
			session("old", status: "running", agoSeconds: 500),
			session("new", status: "running", agoSeconds: 5)
		], now: now)
		XCTAssertEqual(sections[0].sessions.map(\.id), ["new", "old"])
	}

	func testModeToggle() {
		XCTAssertEqual(SessionGrouping.Mode.project.toggled, .status)
		XCTAssertEqual(SessionGrouping.Mode.project.toggleLabel, "Group by status")
		XCTAssertEqual(SessionGrouping.Mode.status.toggleLabel, "Group by project")
	}

	// MARK: project

	func testGroupsSortAlphabeticallyWithUngroupedLast() {
		let projects = [project("zed", group: "Work"), project("amy", group: "Personal"), project("loose")]
		let sections = SessionGrouping.byProject([
			session("1", cwd: "/p/zed"), session("2", cwd: "/p/amy"),
			session("3", cwd: "/p/loose"), session("4", cwd: "/elsewhere/x")
		], projects: projects)
		XCTAssertEqual(sections.map(\.name), ["Personal", "Work", "Ungrouped"])
		XCTAssertEqual(sections[2].subgroups.count, 2)
	}

	func testBlankGroupFallsToUngrouped() {
		let sections = SessionGrouping.byProject([session("1", cwd: "/p/a")], projects: [project("a", group: "  ")])
		XCTAssertEqual(sections.map(\.name), ["Ungrouped"])
	}

	func testWorktreeSessionsFoldUnderTheirRepo() {
		let sections = SessionGrouping.byProject([
			session("1", cwd: "/p/acme"),
			session("2", cwd: "/p/acme-worktrees/feat"),
			session("3", cwd: "/elsewhere", repo: "/p/acme")
		], projects: [project("acme", group: "Work")])
		XCTAssertEqual(sections.count, 1)
		XCTAssertEqual(sections[0].subgroups.count, 1)
		XCTAssertEqual(sections[0].subgroups[0].key, "/p/acme")
		XCTAssertEqual(sections[0].subgroups[0].label, "acme")
		XCTAssertEqual(sections[0].subgroups[0].sessions.map(\.id), ["1", "2", "3"])
	}

	func testSubgroupsOrderByMostRecentActivity() {
		let projects = [project("a", group: "G"), project("b", group: "G")]
		let sections = SessionGrouping.byProject([
			session("a-old", cwd: "/p/a", agoSeconds: 900),
			session("b-new", cwd: "/p/b", agoSeconds: 10),
			session("a-older", cwd: "/p/a", agoSeconds: 1000)
		], projects: projects)
		XCTAssertEqual(sections[0].subgroups.map(\.label), ["b", "a"])
		XCTAssertEqual(sections[0].subgroups[1].sessions.map(\.id), ["a-old", "a-older"])
	}

	func testUnregisteredDirectoryKeepsItsPathWithHomeCollapsed() {
		let sections = SessionGrouping.byProject([
			session("1", cwd: "/Users/someone/code/x-worktrees/feat"),
			session("2", cwd: "/home/dev/y"),
			session("3", cwd: "/root")
		], projects: [])
		let subs = sections[0].subgroups
		XCTAssertEqual(Set(subs.map(\.key)), ["/Users/someone/code/x", "/home/dev/y", "/root"])
		XCTAssertEqual(Set(subs.map(\.label)), ["~/code/x", "~/y", "~"])
	}

	func testOrderedFollowsTheGroupedList() {
		let sessions = [
			session("idle", cwd: "/p/zed", agoSeconds: 3600),
			session("run", status: "running", cwd: "/p/app")
		]
		let projects = [project("app", group: "B"), project("zed", group: "A")]
		XCTAssertEqual(SessionGrouping.ordered(sessions, by: .status, projects: projects, now: now).map(\.id), ["run", "idle"])
		XCTAssertEqual(SessionGrouping.ordered(sessions, by: .project, projects: projects, now: now).map(\.id), ["idle", "run"])
	}

	func testTiedSubgroupsKeepAStableOrder() {
		let sessions = [session("b", cwd: "/p/beta"), session("a", cwd: "/p/alpha")]
		let sections = SessionGrouping.byProject(sessions, projects: [project("alpha"), project("beta")])
		XCTAssertEqual(sections.first?.subgroups.map(\.key), ["/p/alpha", "/p/beta"])
	}
}
