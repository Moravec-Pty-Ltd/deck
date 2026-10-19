import XCTest
@testable import DeckKit

/// The same cases as deck's `matchSessionNames` tests, because two copies of
/// one rule drift the moment nothing compares them.
final class SessionSearchTests: XCTestCase {
	private func digest(_ id: String, _ title: String?) -> SessionDigest {
		let titleJSON = title.map { "\"\($0)\"" } ?? "null"
		let json = #"{"id":"\#(id)","title":\#(titleJSON),"status":"idle"}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private var sessions: [SessionDigest] {
		[
			digest("c_1", "deck enhancements"),
			digest("c_2", "deck"),
			digest("c_3", "Auth: token refresh"),
			digest("c_4", "unrelated work"),
			digest("c_5", ""),
			digest("c_6", nil),
		]
	}

	func testFindsEveryTitleHoldingAllTheWordsInAnyOrder() {
		XCTAssertEqual(SessionSearch.byName("auth token", in: sessions).map(\.id), ["c_3"])
		XCTAssertEqual(SessionSearch.byName("token auth", in: sessions).map(\.id), ["c_3"])
	}

	func testExactTitleThenPrefixThenTheRest() {
		XCTAssertEqual(SessionSearch.byName("deck", in: sessions).map(\.id), ["c_2", "c_1"])
	}

	func testKeepsCallerOrderWithinARankSoRecencySurvives() {
		let recent = [digest("newer", "build the thing"), digest("older", "build the other thing")]
		XCTAssertEqual(SessionSearch.byName("build", in: recent).map(\.id), ["newer", "older"])
	}

	func testIgnoresCaseAndSurroundingWhitespace() {
		XCTAssertEqual(SessionSearch.byName("  AUTH  ", in: sessions).map(\.id), ["c_3"])
	}

	func testNothingForATooShortQueryOrNoMatch() {
		XCTAssertTrue(SessionSearch.byName("a", in: sessions).isEmpty)
		XCTAssertTrue(SessionSearch.byName("", in: sessions).isEmpty)
		XCTAssertTrue(SessionSearch.byName("nothing like this", in: sessions).isEmpty)
	}

	func testSkipsSessionsWithNoTitle() {
		let ids = SessionSearch.byName("deck", in: sessions).map(\.id)
		XCTAssertFalse(ids.contains("c_5"))
		XCTAssertFalse(ids.contains("c_6"))
	}
}
