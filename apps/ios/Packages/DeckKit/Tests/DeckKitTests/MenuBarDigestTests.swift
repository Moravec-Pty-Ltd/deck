import XCTest
@testable import DeckKit

final class MenuBarDigestTests: XCTestCase {
	private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
		try JSONDecoder().decode(T.self, from: Data(json.utf8))
	}

	private func session(_ id: String, _ status: String, title: String? = nil, cwd: String? = nil, active: Int = 0, hidden: Bool = false) throws -> SessionDigest {
		var fields = [#""id": "\#(id)""#, #""status": "\#(status)""#, #""lastActiveAt": \#(active)"#]
		if let title { fields.append(#""title": "\#(title)""#) }
		if let cwd { fields.append(#""cwd": "\#(cwd)""#) }
		if hidden { fields.append(#""hidden": true"#) }
		return try decode(SessionDigest.self, "{\(fields.joined(separator: ","))}")
	}

	private func run(_ id: String, title: String) throws -> RunDigest {
		try decode(RunDigest.self, """
		{ "id": "\(id)", "workflow": { "id": "dev", "name": "Dev", "category": "dev" }, "title": "\(title)",
		  "projectPath": "/path/to/project", "cwd": "/path/to/project", "branch": "b", "status": "blocked",
		  "phase": "review", "round": 1, "loop": false, "blockers": 0, "findings": [],
		  "escalations": { "implementer": false, "disagreement": false, "cap": false }, "humanTouched": false,
		  "phases": [], "createdAt": 1, "updatedAt": 2 }
		""")
	}

	private let pick = AskQuestion(question: "Which colour?", header: "Colour", options: [AskOption(label: "Red"), AskOption(label: "Blue")])

	func testQuestionsAndBlockedRunsAreCountedApart() throws {
		let asks = [
			DeckAsk(sessionId: "c_1", askId: "toolu_1", questions: [pick]),
			DeckAsk(sessionId: "c_9", runId: "r_1", questions: [AskQuestion(question: "Which base?")]),
			DeckAsk(sessionId: "r_2", runId: "r_2", questions: [AskQuestion(question: "Retry?", header: "#8")])
		]
		let digest = MenuBarDigest(
			asks: asks,
			sessions: [try session("c_1", "running", title: "Fix login")],
			runs: [try run("r_1", title: "#7")])
		XCTAssertEqual(digest.questions.map(\.title), ["Fix login"])
		XCTAssertEqual(digest.questions.first?.question, "Which colour?")
		XCTAssertEqual(digest.blockedRuns.map(\.title), ["#7", "#8"])
		XCTAssertEqual(digest.blockedRuns.map(\.sessionId), ["c_9", nil], "a run with no phase session opens nothing")
		XCTAssertEqual(digest.count, 3)
		XCTAssertEqual(digest.badge, "3")
	}

	func testRunningListsOnlyVisibleRunningSessionsNotAlreadyWaiting() throws {
		let digest = MenuBarDigest(
			asks: [DeckAsk(sessionId: "c_ask", questions: [pick])],
			sessions: [
				try session("c_old", "running", active: 1),
				try session("c_new", "running", active: 5),
				try session("c_idle", "idle", active: 9),
				try session("c_hidden", "running", active: 9, hidden: true),
				try session("c_ask", "running", active: 9)
			],
			runs: [])
		XCTAssertEqual(digest.running.map(\.id), ["c_new", "c_old"])
	}

	func testNothingWaitingHasNoBadgeAndManyCaps() {
		let none = MenuBarDigest(asks: [], sessions: [], runs: [])
		XCTAssertNil(none.badge)
		XCTAssertTrue(none.isEmpty)
		let many = MenuBarDigest(
			asks: (0..<12).map { DeckAsk(sessionId: "c_\($0)", questions: [pick]) }, sessions: [], runs: [])
		XCTAssertEqual(many.badge, "9+")
	}

	func testATitleFallsBackToTheFolderThenTheId() throws {
		let digest = MenuBarDigest(
			asks: [DeckAsk(sessionId: "c_1", questions: [pick]), DeckAsk(sessionId: "c_2", questions: [pick])],
			sessions: [try session("c_1", "idle", cwd: "/path/to/project")],
			runs: [])
		XCTAssertEqual(digest.questions.map(\.title), ["project", "c_2"])
	}

	func testOnlyASingleChoiceQuestionGetsOneClickAnswers() {
		XCTAssertEqual(MenuBarDigest.quickOptions(DeckAsk(sessionId: "c_1", questions: [pick])), ["Red", "Blue"])
		let multi = AskQuestion(question: "Which?", multiSelect: true, options: [AskOption(label: "A")])
		XCTAssertEqual(MenuBarDigest.quickOptions(DeckAsk(sessionId: "c_1", questions: [multi])), [])
		XCTAssertEqual(MenuBarDigest.quickOptions(DeckAsk(sessionId: "c_1", questions: [pick, pick])), [])
		XCTAssertEqual(MenuBarDigest.quickOptions(DeckAsk(sessionId: "c_1", questions: [AskQuestion(question: "Free text?")])), [])
		XCTAssertEqual(MenuBarDigest.quickOptions(DeckAsk(sessionId: "c_1", runId: "r_1", questions: [pick])), [], "a run takes a typed reply")
	}
}
