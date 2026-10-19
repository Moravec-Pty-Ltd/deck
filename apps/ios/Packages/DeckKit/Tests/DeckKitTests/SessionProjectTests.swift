import XCTest
@testable import DeckKit

/// The same cases as deck's `stampHidden` tests, because two copies of one rule
/// drift the moment nothing compares them.
final class SessionProjectTests: XCTestCase {
	private func project(_ name: String, _ path: String, hidden: Bool = false) -> DeckProject {
		DeckProject(path: path, name: name, group: nil, hidden: hidden ? true : nil)
	}

	private func session(_ id: String, cwd: String, repo: String? = nil) -> SessionDigest {
		let worktree = repo.map { #","worktree":{"repo":"\#($0)","branch":"b"}"# } ?? ""
		let json = #"{"id":"\#(id)","status":"idle","cwd":"\#(cwd)"\#(worktree)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private var projects: [DeckProject] {
		[project("acme", "/p/acme", hidden: true), project("web", "/p/web")]
	}

	func testASessionInTheProjectDirectoryBelongsToIt() {
		XCTAssertEqual(SessionProject.owning(session("s1", cwd: "/p/acme"), in: projects)?.name, "acme")
		XCTAssertEqual(SessionProject.owning(session("s2", cwd: "/p/acme/sub"), in: projects)?.name, "acme")
	}

	func testAWorktreeSessionBelongsToTheRepoItBranchedFrom() {
		let worktree = session("s1", cwd: "/p/acme-worktrees/feature")
		XCTAssertEqual(SessionProject.owning(worktree, in: projects)?.name, "acme")
		XCTAssertTrue(SessionProject.hides(worktree, in: projects))
	}

	func testTheNamedRepoWinsWhenTheWorktreeSaysSo() {
		let elsewhere = session("s1", cwd: "/somewhere/else", repo: "/p/web")
		XCTAssertEqual(SessionProject.owning(elsewhere, in: projects)?.name, "web")
	}

	func testADirectorySharingAPrefixIsNotTheProject() {
		XCTAssertNil(SessionProject.owning(session("s1", cwd: "/p/acme-other"), in: projects))
		XCTAssertFalse(SessionProject.hides(session("s1", cwd: "/p/acme-other"), in: projects))
	}

	func testTheLongestMatchingProjectWins() {
		let nested = [project("outer", "/p"), project("acme", "/p/acme", hidden: true)]
		XCTAssertEqual(SessionProject.owning(session("s1", cwd: "/p/acme/sub"), in: nested)?.name, "acme")
	}

	func testAnUnregisteredDirectoryBelongsToNothing() {
		XCTAssertNil(SessionProject.owning(session("s1", cwd: "/tmp/scratch"), in: projects))
		XCTAssertFalse(SessionProject.hides(session("s1", cwd: "/tmp/scratch"), in: projects))
	}

	func testAVisibleProjectDoesNotHideItsSessions() {
		XCTAssertFalse(SessionProject.hides(session("s1", cwd: "/p/web"), in: projects))
	}
}
