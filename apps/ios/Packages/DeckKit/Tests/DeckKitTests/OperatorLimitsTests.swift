import XCTest
@testable import DeckKit

/// What a tool may hand back, which stopped being a constant when the operator
/// gained a second model to run on (deck#239).
final class OperatorLimitsTests: XCTestCase {
	// The reason the whole thing exists: Apple's window is 4,096 tokens for the
	// instructions, eight tool schemas, the conversation and the result
	// together, so a session's reply arrives as its opening 2,000 characters.
	// A downloaded model has room for the reply itself.
	func testADownloadedModelIsAllowedMoreThanApples() {
		XCTAssertGreaterThan(
			OperatorLimits.downloaded.resultCharacters,
			OperatorLimits.appleOnDevice.resultCharacters)
		XCTAssertGreaterThan(
			OperatorLimits.downloaded.sessionRows,
			OperatorLimits.appleOnDevice.sessionRows)
	}

	// Four characters to a token, roughly. A result allowance that on its own
	// exceeded Apple's whole window would end every turn it was used on.
	func testApplesAllowanceFitsInsideApplesWindow() {
		let appleWindowTokens = 4_096
		let resultTokens = OperatorLimits.appleOnDevice.resultCharacters / 4
		XCTAssertLessThan(resultTokens, appleWindowTokens / 2, "a result has to leave room for everything else")
	}

	func testShortTextIsLeftAlone() {
		let text = "All good."
		XCTAssertEqual(text.boundedForTool(.appleOnDevice), text)
	}

	// A silent truncation reads to the model as the end of the text, so it has
	// to be told, and told it can ask for the rest.
	func testALongResultIsCutAndSaysSo() {
		let long = String(repeating: "x", count: 5_000)
		let bounded = long.boundedForTool(.appleOnDevice)
		XCTAssertTrue(bounded.hasPrefix(String(repeating: "x", count: 2_000)))
		XCTAssertTrue(bounded.contains("cut short"), bounded.suffix(60).description)
		XCTAssertLessThan(bounded.count, long.count)
	}

	// The same text, under a downloaded model, survives whole. This is the
	// difference someone notices when asking what a session said.
	func testThatSameResultSurvivesOnADownloadedModel() {
		let long = String(repeating: "x", count: 5_000)
		XCTAssertEqual(long.boundedForTool(.downloaded), long)
		XCTAssertFalse(long.boundedForTool(.downloaded).contains("cut short"))
	}

	func testCuttingHappensExactlyAtTheLimit() {
		let limits = OperatorLimits(resultCharacters: 10, sessionRows: 2)
		XCTAssertEqual(String(repeating: "a", count: 10).boundedForTool(limits).count, 10, "at the limit is not over it")
		XCTAssertTrue(String(repeating: "a", count: 11).boundedForTool(limits).contains("cut short"))
	}
}
