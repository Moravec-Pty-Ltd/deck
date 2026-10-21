import XCTest
@testable import DeckIntents

/// A spoken instruction becomes a branch name, so it has to be a valid git ref
/// whatever was said. deck would refuse the create otherwise, and the failure
/// would surface to Siri as an unexplained error.
final class StartSessionIntentTests: XCTestCase {
	func testBranchNameIsALowercaseSlug() {
		XCTAssertEqual(StartSessionIntent.branchName(from: "Fix the login redirect"), "fix-the-login-redirect")
	}

	func testPunctuationAndSpacingCollapse() {
		XCTAssertEqual(StartSessionIntent.branchName(from: "Fix   the  login... redirect!"), "fix-the-login-redirect")
		XCTAssertEqual(StartSessionIntent.branchName(from: "  leading and trailing  "), "leading-and-trailing")
	}

	func testItStaysShortEnoughToRead() {
		XCTAssertEqual(
			StartSessionIntent.branchName(from: "one two three four five six seven eight"),
			"one-two-three-four-five")
	}

	func testSomethingUnusableStillGivesAValidRef() {
		XCTAssertEqual(StartSessionIntent.branchName(from: "!!! ???"), "deck-session")
		XCTAssertEqual(StartSessionIntent.branchName(from: ""), "deck-session")
	}

	func testTitleIsAFewWordsOfWhatWasSaid() {
		XCTAssertEqual(
			StartSessionIntent.title(from: "fix the login redirect on staging please now"),
			"fix the login redirect on staging")
		XCTAssertEqual(StartSessionIntent.title(from: "   "), "New session")
	}
}
