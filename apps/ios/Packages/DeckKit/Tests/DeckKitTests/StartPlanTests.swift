import XCTest
@testable import DeckKit

final class StartPlanTests: XCTestCase {
	private let issues = [
		DeckIssue(source: "github", sourceId: "source-a", issueId: "acme/web#1", title: "Fix the login page"),
		DeckIssue(source: "linear", sourceId: "source-b", issueId: "EX-2")
	]

	private func keys() -> () -> String {
		var n = 0
		return { n += 1; return "key-\(n)" }
	}

	private func work(worktree: WorktreeOptions? = WorktreeOptions(branch: "combined-branch", base: "main")) -> CreateSessionRequest {
		var request = CreateSessionRequest(mode: .work, cwd: "/path/to/project")
		request.title = "Combined"
		request.worktree = worktree
		return request
	}

	private let conflict = WorktreeConflict(code: .branchExists, branch: "EX-2", message: "The branch EX-2 already exists.")

	func testCombinedWorkIsOneCreateOnEveryIssue() {
		let plan = StartPlan.work(work(), issues: issues, split: false, makeKey: keys())
		XCTAssertEqual(plan.items.count, 1)
		XCTAssertEqual(plan.items[0].request.issues, issues)
		XCTAssertEqual(plan.items[0].request.title, "Combined")
		XCTAssertEqual(plan.items[0].request.worktree?.branch, "combined-branch")
	}

	func testSplitWorkIsOneCreatePerIssueOnItsOwnBranch() {
		let plan = StartPlan.work(work(), issues: issues, split: true, makeKey: keys())
		XCTAssertEqual(plan.items.map(\.request.issues), [[issues[0]], [issues[1]]])
		XCTAssertEqual(plan.items.map(\.request.title), ["Fix the login page", "EX-2"], "titled with the issue title, else the short id")
		XCTAssertEqual(plan.items.map(\.request.worktree?.branch), ["acme/web#1", "EX-2"])
		XCTAssertEqual(plan.items.map(\.request.worktree?.base), ["main", "main"])
		XCTAssertEqual(plan.items.map(\.idempotencyKey), ["key-1", "key-2"])
	}

	func testSplitNeedsANewWorktree() {
		XCTAssertEqual(StartPlan.work(work(worktree: nil), issues: issues, split: true).items.count, 1)
		let existing = WorktreeOptions(branch: "b", newBranch: false)
		XCTAssertEqual(StartPlan.work(work(worktree: existing), issues: issues, split: true).items.count, 1)
		XCTAssertEqual(StartPlan.work(work(), issues: [issues[0]], split: true).items.count, 1)
	}

	func testReviewIsOneCreatePerPR() {
		let prs = [DeckPR(repo: "acme/web", number: 3), DeckPR(repo: "acme/web", number: 4)]
		let plan = StartPlan.review(CreateSessionRequest(mode: .review, cwd: "/path/to/project"), prs: prs, makeKey: keys())
		XCTAssertEqual(plan.items.map(\.request.pr), prs)
		XCTAssertEqual(plan.items.map(\.label), ["#3", "#4"])
		XCTAssertEqual(Set(plan.items.map(\.idempotencyKey)).count, 2)
	}

	func testARetrySendsOnlyTheFailedCreatesUnderTheirOriginalKeys() {
		var plan = StartPlan.work(work(), issues: issues, split: true, makeKey: keys())
		XCTAssertEqual(plan.begin().count, 2)
		plan.record(issues[0].id, .created(id: "s1"))
		plan.record(issues[1].id, .failed("timed out"))
		XCTAssertFalse(plan.isFinished)
		XCTAssertEqual(plan.failures.map(\.label), ["EX-2"])

		// The form is rebuilt for the retry with fresh keys; the plan's history wins.
		plan = plan.carrying(into: StartPlan.work(work(), issues: issues, split: true, makeKey: { "fresh" }))
		let retry = plan.begin()
		XCTAssertEqual(retry.map(\.id), [issues[1].id])
		XCTAssertEqual(retry.map(\.idempotencyKey), ["key-2"])
		plan.record(issues[1].id, .created(id: "s2"))
		XCTAssertTrue(plan.isFinished)
		XCTAssertEqual(plan.createdIds, ["s1", "s2"])
	}

	func testAConflictRetriesWithOnExistingOnlyOnce() {
		var plan = StartPlan.work(work(), issues: issues, split: true, makeKey: keys())
		_ = plan.begin()
		plan.record(issues[0].id, .created(id: "s1"))
		plan.record(issues[1].id, .conflict(conflict))
		XCTAssertEqual(plan.conflicts, [conflict])

		plan.resolveConflicts(with: .reuse)
		let retry = plan.begin()
		XCTAssertEqual(retry.map(\.request.worktree?.onExisting), [.reuse])
		XCTAssertEqual(retry.map(\.idempotencyKey), ["key-2"])

		plan.record(issues[1].id, .failed("still broken"))
		XCTAssertNil(plan.items[1].request.worktree?.onExisting, "the answer is spent on the attempt it rode on")
	}

	func testErrorsMapToStatuses() {
		XCTAssertEqual(StartPlan.status(for: DeckError.worktreeConflict(conflict)), .conflict(conflict))
		XCTAssertEqual(StartPlan.status(for: DeckError.http(status: 500, message: "boom")), .failed("boom (HTTP 500)"))
	}

	func testWorkBodyCarriesOnExisting() {
		var request = work()
		request.worktree?.onExisting = .recreate
		let worktree = request.json["worktree"] as? [String: Any]
		XCTAssertEqual(worktree?["onExisting"] as? String, "recreate")
		XCTAssertNil(work().json["worktree"].flatMap { ($0 as? [String: Any])?["onExisting"] })
	}
}
