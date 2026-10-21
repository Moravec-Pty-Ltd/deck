import XCTest
@testable import DeckKit

/// The same cases as deck's `quickMessagesFor` tests in quick-messages-core.
final class QuickMessagesTests: XCTestCase {
	private let list = [
		QuickMessage(id: "g1", text: "g1"),
		QuickMessage(id: "a1", text: "a1", projectId: "/p/acme"),
		QuickMessage(id: "w1", text: "w1", projectId: "/p/web"),
		QuickMessage(id: "g2", text: "g2"),
		QuickMessage(id: "a2", text: "a2", projectId: "/p/acme"),
	]

	func testAProjectsMessagesComeFirstThenTheGlobalOnes() {
		XCTAssertEqual(QuickMessage.offered(list, projectId: "/p/acme").map(\.id), ["a1", "a2", "g1", "g2"])
	}

	func testWithoutAProjectOnlyTheGlobalOnesShow() {
		XCTAssertEqual(QuickMessage.offered(list, projectId: nil).map(\.id), ["g1", "g2"])
		XCTAssertEqual(QuickMessage.offered(list, projectId: "/p/other").map(\.id), ["g1", "g2"])
	}

	func testAWorktreeSessionGetsItsRepoProjectsMessages() throws {
		let json = #"{"id":"s1","status":"idle","cwd":"/p/acme-worktrees/feature"}"#
		let session = try JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
		let projects = [DeckProject(path: "/p/acme", name: "acme", group: nil, hidden: nil)]
		let projectId = SessionProject.owning(session, in: projects)?.path
		XCTAssertEqual(QuickMessage.offered(list, projectId: projectId).map(\.id), ["a1", "a2", "g1", "g2"])
	}

	// MARK: - Editor sections

	private let projects = [
		DeckProject(path: "/p/acme", name: "acme", group: nil, hidden: nil),
		DeckProject(path: "/p/web", name: "web", group: nil, hidden: nil),
	]

	func testSectionsAreGlobalThenProjectsThenUnregisteredScopes() {
		let messages = list + [QuickMessage(id: "x1", text: "x1", projectId: "/p/gone")]
		let scopes = QuickMessage.scopes(messages, projects: projects)
		XCTAssertEqual(scopes.map(\.label), ["Global", "acme", "web", "/p/gone"])
		XCTAssertEqual(scopes.map(\.ids), [["g1", "g2"], ["a1", "a2"], ["w1"], ["x1"]])
		XCTAssertEqual(QuickMessage.scopes([], projects: projects).map(\.label), ["Global"])
	}

	func testMovingWithinASectionLeavesTheOthersInPlace() {
		var messages = list
		QuickMessage.move(&messages, scope: "/p/acme", fromOffsets: IndexSet(integer: 1), toOffset: 0)
		XCTAssertEqual(messages.map(\.id), ["g1", "a2", "w1", "g2", "a1"])
		QuickMessage.move(&messages, scope: nil, fromOffsets: IndexSet(integer: 0), toOffset: 2)
		XCTAssertEqual(messages.map(\.id), ["g2", "a2", "w1", "g1", "a1"])
	}

	func testRescopingPutsTheMessageLastInItsNewSection() {
		var messages = list
		QuickMessage.setScope(&messages, id: "g1", to: "/p/web")
		XCTAssertEqual(QuickMessage.scopes(messages, projects: projects).first { $0.projectId == "/p/web" }?.ids, ["w1", "g1"])
		QuickMessage.setScope(&messages, id: "a1", to: "")
		XCTAssertNil(messages.last?.projectId, "a blank scope is Global")
	}
}
