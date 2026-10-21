import XCTest
@testable import DeckKit

/// These figures have to read the same as deck's own gauge, which computes them
/// in `src/lib/context-core.ts`. The cases here mirror that module's tests.
final class SessionContextTests: XCTestCase {
	func testPercentRoundsAndCaps() {
		XCTAssertEqual(SessionContext(used: 702_516, window: 1_000_000).percent, 70)
		// A turn can overrun the window before anything compacts it.
		XCTAssertEqual(SessionContext(used: 1_003_057, window: 1_000_000).percent, 100)
		XCTAssertEqual(SessionContext(used: 0, window: 1_000_000).percent, 0)
	}

	func testPercentIsZeroWithoutAWindow() {
		XCTAssertEqual(SessionContext(used: 50_000, window: 0).percent, 0)
	}

	func testTokensReadInThousandsBelowAMillion() {
		XCTAssertEqual(SessionContext.tokens(703_390), "703k")
		XCTAssertEqual(SessionContext.tokens(1_000_000), "1.0M")
		XCTAssertEqual(SessionContext.tokens(1_250_000), "1.3M")
		XCTAssertEqual(SessionContext.tokens(812), "812")
		XCTAssertEqual(SessionContext.tokens(0), "0")
	}

	func testSummarySpellsOutThePair() {
		XCTAssertEqual(SessionContext(used: 248_000, window: 1_000_000).summary, "248k / 1.0M tokens")
	}

	func testDecodesFromTheDigestAndStaysAbsentWhenNotSent() throws {
		let withContext = """
			{"id":"c_1","status":"idle","context":{"used":702516,"window":1000000}}
			"""
		let digest = try JSONDecoder().decode(SessionDigest.self, from: Data(withContext.utf8))
		XCTAssertEqual(digest.context?.used, 702_516)
		XCTAssertEqual(digest.context?.percent, 70)

		// An older deck, or a session that has not finished a turn, sends none.
		let without = try JSONDecoder().decode(SessionDigest.self, from: Data(#"{"id":"c_2","status":"idle"}"#.utf8))
		XCTAssertNil(without.context)
	}
}
