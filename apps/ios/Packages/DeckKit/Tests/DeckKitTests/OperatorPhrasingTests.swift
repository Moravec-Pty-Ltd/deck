import XCTest
@testable import DeckKit

/// These rules moved here from deck's `src/lib/operator-core.ts` when the
/// operator's brain moved on-device. The cases mirror that module's tests, so
/// the two copies cannot quietly drift.
final class OperatorPhrasingTests: XCTestCase {
	private let options = ["Half the screen", "Fixed 320", "Something else"]

	func testExactLabelWins() {
		XCTAssertEqual(OperatorPhrasing.pickOption("Fixed 320", options: options), "Fixed 320")
		XCTAssertEqual(OperatorPhrasing.pickOption("  half the screen  ", options: options), "Half the screen")
	}

	func testALabelSaidInsideASentence() {
		XCTAssertEqual(
			OperatorPhrasing.pickOption("let's go with fixed 320 please", options: options), "Fixed 320")
	}

	func testANumberPicksByPosition() {
		XCTAssertEqual(OperatorPhrasing.pickOption("option 2", options: options), "Fixed 320")
		XCTAssertEqual(OperatorPhrasing.pickOption("the first one", options: options), "Half the screen")
		XCTAssertEqual(OperatorPhrasing.pickOption("two", options: options), "Fixed 320")
		XCTAssertEqual(OperatorPhrasing.pickOption("third", options: options), "Something else")
	}

	func testANumberPastTheEndMatchesNothing() {
		XCTAssertNil(OperatorPhrasing.pickOption("option 9", options: options))
		XCTAssertNil(OperatorPhrasing.pickOption("ninth", options: options))
	}

	func testFreeTextMatchesNothing() {
		XCTAssertNil(OperatorPhrasing.pickOption("do whatever you think is best", options: options))
		XCTAssertNil(OperatorPhrasing.pickOption("", options: options))
		XCTAssertNil(OperatorPhrasing.pickOption("yes", options: []))
	}

	/// A digit inside an identifier is part of a word, not an option number.
	func testAnIdentifierIsNotAnOptionNumber() {
		XCTAssertNil(OperatorPhrasing.pickOption("use SKO-136 for this", options: options))
	}

	func testMatchSessionsTakesAnExactIdFirst() {
		let sessions = [digest("c_auth", "Auth token refresh"), digest("c_fold", "Foldable layout")]
		XCTAssertEqual(OperatorPhrasing.matchSessions("c_fold", in: sessions).map(\.id), ["c_fold"])
	}

	func testMatchSessionsNeedsEveryWordSaid() {
		let sessions = [
			digest("c_auth", "Auth token refresh"),
			digest("c_other", "Auth cleanup"),
			digest("c_fold", "Foldable layout"),
		]
		XCTAssertEqual(OperatorPhrasing.matchSessions("auth", in: sessions).map(\.id), ["c_auth", "c_other"])
		XCTAssertEqual(OperatorPhrasing.matchSessions("auth token", in: sessions).map(\.id), ["c_auth"])
		XCTAssertTrue(OperatorPhrasing.matchSessions("nothing like this", in: sessions).isEmpty)
		XCTAssertTrue(OperatorPhrasing.matchSessions("   ", in: sessions).isEmpty)
	}

	private func digest(_ id: String, _ title: String) -> SessionDigest {
		let json = #"{"id":"\#(id)","title":"\#(title)","status":"idle"}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}
}
