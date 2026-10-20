import XCTest
import DeckKit

final class DeckLinkTests: XCTestCase {
	func testASessionPath() {
		XCTAssertEqual(DeckLink.sessionId(from: "http://localhost:4818/s/abc"), "abc")
		XCTAssertEqual(DeckLink.sessionId(from: "/s/abc"), "abc")
	}

	func testANestedSIsNotASession() {
		XCTAssertNil(DeckLink.sessionId(from: "http://localhost:4818/runs/r1/s/abc"))
	}

	func testAnEmptyId() {
		XCTAssertNil(DeckLink.sessionId(from: "http://localhost:4818/s/"))
		XCTAssertNil(DeckLink.sessionId(from: "deck://s/"))
	}

	func testTheAppScheme() {
		XCTAssertEqual(DeckLink.sessionId(from: "deck://s/abc"), "abc")
		XCTAssertEqual(DeckLink.sessionId(from: URL(string: "deck://s/abc")!), "abc")
		XCTAssertNil(DeckLink.sessionId(from: "deck://runs/abc"))
	}

	func testQueryAndFragmentAreIgnored() {
		XCTAssertEqual(DeckLink.sessionId(from: "http://localhost:4818/s/abc?tab=diff#end"), "abc")
		XCTAssertEqual(DeckLink.sessionId(from: "deck://s/abc?x=1#y"), "abc")
	}

	func testOtherPaths() {
		XCTAssertNil(DeckLink.sessionId(from: "http://localhost:4818/"))
		XCTAssertNil(DeckLink.sessionId(from: "http://localhost:4818/sessions/abc"))
	}
}
