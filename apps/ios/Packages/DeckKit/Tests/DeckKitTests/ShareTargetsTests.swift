import XCTest
@testable import DeckKit

final class ShareTargetsTests: XCTestCase {
	private func digest(_ id: String, at: Double, hidden: Bool = false) -> SessionDigest {
		let h = hidden ? #","hidden":true"# : ""
		let json = #"{"id":"\#(id)","status":"idle","lastActiveAt":\#(at)\#(h)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	func testNewestActivityFirst() {
		let picked = ShareTargets.pick([digest("a", at: 1), digest("c", at: 3), digest("b", at: 2)])
		XCTAssertEqual(picked.map(\.id), ["c", "b", "a"])
	}

	func testHiddenSessionsAreNotOfferedToShareInto() {
		let picked = ShareTargets.pick([digest("a", at: 2), digest("gone", at: 3, hidden: true)])
		XCTAssertEqual(picked.map(\.id), ["a"])
	}

	func testTheListIsCappedToTheMostRecent() {
		let many = (0..<50).map { digest("s\($0)", at: Double($0)) }
		let picked = ShareTargets.pick(many, limit: 2)
		XCTAssertEqual(picked.map(\.id), ["s49", "s48"])
	}

	func testASessionWithNoActivityStampSortsLast() {
		let none = try! JSONDecoder().decode(SessionDigest.self, from: Data(#"{"id":"x","status":"idle"}"#.utf8))
		XCTAssertEqual(ShareTargets.pick([none, digest("a", at: 1)]).map(\.id), ["a", "x"])
	}
}

final class ShareLimitsTests: XCTestCase {
	func testAFileWithinTheLimitIsAccepted() {
		let file = SharedFile(name: "notes.txt", data: Data(repeating: 0, count: 10))
		XCTAssertNil(ShareLimits.rejection(for: file))
	}

	func testAnOversizedFileSaysHowBigItIsAndWhatTheLimitIs() {
		let file = SharedFile(name: "huge.bin", data: Data(repeating: 0, count: ShareLimits.maxBytes + 1))
		let why = ShareLimits.rejection(for: file)
		XCTAssertNotNil(why)
		XCTAssertTrue(why!.contains("huge.bin"))
		XCTAssertTrue(why!.contains("25 MB"))
	}
}
