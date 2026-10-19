import XCTest
@testable import DeckKit

final class PaletteIndexTests: XCTestCase {
	private func digest(_ id: String, _ title: String?) -> SessionDigest {
		let titleJSON = title.map { "\"\($0)\"" } ?? "null"
		let json = #"{"id":"\#(id)","title":\#(titleJSON),"status":"idle"}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private var index: PaletteIndex {
		PaletteIndex(
			actions: [.newSession, .searchSessions, .settings],
			sessions: [
				digest("c_1", "new onboarding flow"),
				digest("c_2", "Settings page polish"),
				digest("c_3", "Auth: token refresh"),
				digest("c_4", nil),
			])
	}

	private func ids(_ query: String) -> [String] {
		index.results(for: query).map(\.id)
	}

	func testAShortQueryListsEverythingActionsFirst() {
		let all = ["action:new-session", "action:search-sessions", "action:settings",
			"session:c_1", "session:c_2", "session:c_3", "session:c_4"]
		XCTAssertEqual(ids(""), all)
		XCTAssertEqual(ids("n"), all)
	}

	func testExactBeatsPrefixBeatsTheRestAcrossBothKinds() {
		XCTAssertEqual(ids("settings"), ["action:settings", "session:c_2"])
		XCTAssertEqual(ids("token"), ["session:c_3"])
	}

	func testAnActionLeadsASessionOfTheSameRank() {
		XCTAssertEqual(ids("new"), ["action:new-session", "session:c_1"])
	}

	func testSessionsMatchWordWiseLikeTheSessionsList() {
		XCTAssertEqual(ids("token auth"), ["session:c_3"])
	}

	func testActionsMatchOnTheirKeywords() {
		XCTAssertEqual(ids("find"), ["action:search-sessions"])
		XCTAssertEqual(ids("create"), ["action:new-session"])
	}

	func testUntitledSessionsOnlyShowUnfiltered() {
		XCTAssertFalse(ids("c_4").contains("session:c_4"))
	}

	func testNothingMatches() {
		XCTAssertTrue(ids("zzz qqq").isEmpty)
	}

	func testStepsThroughSessionsInListOrder() {
		let list = ["a", "b", "c"]
		XCTAssertEqual(SessionStepper.step(from: "b", by: 1, in: list), "c")
		XCTAssertEqual(SessionStepper.step(from: "b", by: -1, in: list), "a")
		XCTAssertNil(SessionStepper.step(from: "c", by: 1, in: list))
		XCTAssertNil(SessionStepper.step(from: "a", by: -1, in: list))
	}

	func testStepsFromNothingOpenToAnEnd() {
		let list = ["a", "b", "c"]
		XCTAssertEqual(SessionStepper.step(from: nil, by: 1, in: list), "a")
		XCTAssertEqual(SessionStepper.step(from: nil, by: -1, in: list), "c")
		XCTAssertEqual(SessionStepper.step(from: "gone", by: 1, in: list), "a")
		XCTAssertNil(SessionStepper.step(from: nil, by: 1, in: []))
	}
}
