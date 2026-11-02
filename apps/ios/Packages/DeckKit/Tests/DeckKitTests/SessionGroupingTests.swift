import XCTest
@testable import DeckKit

final class SessionGroupingTests: XCTestCase {
	private let now = Date(timeIntervalSince1970: 1_000_000)
	private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

	private func session(
		_ id: String, status: String = "idle", asking: Bool = false, cwd: String? = nil,
		agoSeconds: Double = 3600, repo: String? = nil, unread: Bool = false,
		dueIn: [Double] = [], subagents: Int? = nil
	) -> SessionDigest {
		let worktree = repo.map { #","worktree":{"repo":"\#($0)","branch":"b"}"# } ?? ""
		let dir = cwd.map { #","cwd":"\#($0)""# } ?? ""
		let json = #"{"id":"\#(id)","status":"\#(status)","awaitingInput":\#(asking),"lastActiveAt":\#(nowMs - agoSeconds * 1000)\#(dir)\#(worktree)\#(unread ? #","unread":true"# : "")\#(watchJSON(dueIn))\#(subagents.map { #","subagents":\#($0)"# } ?? "")}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private func watchJSON(_ dueIn: [Double]) -> String {
		if dueIn.isEmpty { return "" }
		let list = dueIn.enumerated().map { i, d in
			#"{"id":"w\#(i)","sessionId":"x","title":"t","prompt":"p","createdAt":1,"dueAt":\#(d),"state":"active"}"#
		}
		return #","watches":[\#(list.joined(separator: ","))]"#
	}

	private func project(_ name: String, group: String? = nil) -> DeckProject {
		DeckProject(path: "/p/\(name)", name: name, group: group, hidden: nil)
	}

	// MARK: status

	func testActivityShowsWhileWorkingAskingOrJustFinished() {
		let shows = { (s: SessionDigest) in SessionGrouping.showsActivity(s, now: self.now) }
		XCTAssertTrue(shows(session("a", status: "running")))
		XCTAssertTrue(shows(session("b", subagents: 1)))
		XCTAssertTrue(shows(session("c", asking: true)))
		XCTAssertTrue(shows(session("d", status: "error", unread: true)))
		XCTAssertTrue(shows(session("e", agoSeconds: 14 * 60)))
		XCTAssertFalse(shows(session("f", agoSeconds: 16 * 60)))
		XCTAssertFalse(shows(session("g", status: "error")))
		XCTAssertFalse(shows(session("h", agoSeconds: 16 * 60, dueIn: [nowMs + 60_000])))
	}

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

	func testUnreadBucketComesFirst() {
		let sections = SessionGrouping.byStatus([
			session("run", status: "running"),
			session("ask", status: "running", asking: true),
			session("read", unread: true)
		], now: now)
		XCTAssertEqual(sections.map(\.bucket), [.unread, .needsAttention, .active])
		XCTAssertEqual(sections[0].bucket.label, "Unread")
		XCTAssertEqual(sections[0].sessions.map(\.id), ["read"])
	}

	func testUnreadThatNeedsAttentionStaysThere() {
		let sections = SessionGrouping.byStatus([
			session("ask", status: "running", asking: true, unread: true),
			session("err", status: "error", unread: true)
		], now: now)
		XCTAssertEqual(sections.map(\.bucket), [.needsAttention])
	}

	func testUnreadSessionsSortFirstWithinAProjectSubgroup() {
		let sections = SessionGrouping.byProject([
			session("new", cwd: "/p/acme", agoSeconds: 10),
			session("old", cwd: "/p/acme", agoSeconds: 900, unread: true)
		], projects: [project("acme")])
		XCTAssertEqual(sections[0].subgroups[0].sessions.map(\.id), ["old", "new"])
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

	func testWaitingSitsBetweenActiveAndJustFinished() {
		let sections = SessionGrouping.byStatus([
			session("fresh", agoSeconds: 60), session("wait", dueIn: [5]), session("run", status: "running")
		], now: now)
		XCTAssertEqual(sections.map(\.bucket), [.active, .waiting, .justFinished])
		XCTAssertEqual(SessionGrouping.Bucket.waiting.label, "Waiting")
	}

	func testWaitingPrecedence() {
		func bucket(_ s: SessionDigest) -> SessionGrouping.Bucket { SessionGrouping.byStatus([s], now: now)[0].bucket }
		XCTAssertEqual(bucket(session("a", unread: true, dueIn: [5])), .unread)
		XCTAssertEqual(bucket(session("b", asking: true, dueIn: [5])), .needsAttention)
		XCTAssertEqual(bucket(session("c", status: "error", dueIn: [5])), .needsAttention)
		XCTAssertEqual(bucket(session("d", status: "running", dueIn: [5])), .active)
		XCTAssertEqual(bucket(session("e", dueIn: [5])), .waiting)
	}

	func testWaitingOrdersBySoonestWatch() {
		let sections = SessionGrouping.byStatus([
			session("late", dueIn: [900]), session("soon", dueIn: [800, 100]), session("mid", dueIn: [500])
		], now: now)
		XCTAssertEqual(sections[0].sessions.map(\.id), ["soon", "mid", "late"])
	}

	func testIdleSessionWithSubagentsIsActive() {
		XCTAssertEqual(SessionGrouping.byStatus([session("s", subagents: 2)], now: now)[0].bucket, .active)
	}

	func testIsWorking() {
		XCTAssertTrue(session("a", status: "running").isWorking)
		XCTAssertTrue(session("b", subagents: 2).isWorking)
		XCTAssertFalse(session("c").isWorking)
		XCTAssertFalse(session("d", subagents: 0).isWorking)
		XCTAssertFalse(session("e", status: "running", asking: true).isWorking)
		XCTAssertTrue(session("e", status: "running", asking: true).canStop)
		XCTAssertTrue(session("b", subagents: 2).canStop)
		XCTAssertFalse(session("c").canStop)
	}

	func testWorkingLabelCountsSubagentsOnceTheTurnEnds() {
		XCTAssertEqual(session("a", status: "running").workingLabel, "Working…")
		XCTAssertEqual(session("b", status: "running", subagents: 2).workingLabel, "Working…")
		XCTAssertEqual(session("c", subagents: 1).workingLabel, "1 subagent working")
		XCTAssertEqual(session("d", subagents: 2).workingLabel, "2 subagents working")
	}
}
