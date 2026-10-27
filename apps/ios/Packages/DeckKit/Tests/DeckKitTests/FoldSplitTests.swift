import XCTest
@testable import DeckKit

final class FoldSplitTests: XCTestCase {
	private let window = 1000.0

	func testDefaultIsTheFold() {
		XCTAssertEqual(FoldSplit.width(0, window: window), 500)
		XCTAssertEqual(FoldSplit.width(-5, window: window), 500)
	}

	func testStoredWidthIsClamped() {
		XCTAssertEqual(FoldSplit.width(320, window: window), 320)
		XCTAssertEqual(FoldSplit.width(100, window: window), 260)
		XCTAssertEqual(FoldSplit.width(900, window: window), 600)
	}

	func testClampRoundsAndRejectsNonFinite() {
		XCTAssertEqual(FoldSplit.clamp(321.6, window: window), 322)
		XCTAssertEqual(FoldSplit.clamp(.nan, window: window), 500)
		XCTAssertEqual(FoldSplit.clamp(.infinity, window: window), 500)
	}

	func testNarrowWindowKeepsTheFoldAsTheLowerLimit() {
		XCTAssertEqual(FoldSplit.clamp(100, window: 400), 200)
		XCTAssertEqual(FoldSplit.clamp(300, window: 400), 240)
	}

	func testReleaseNearTheFoldSnapsToIt() {
		XCTAssertEqual(FoldSplit.settle(500, window: window), 0)
		XCTAssertEqual(FoldSplit.settle(476, window: window), 0)
		XCTAssertEqual(FoldSplit.settle(524, window: window), 0)
	}

	func testReleaseAwayFromTheFoldKeepsTheClampedWidth() {
		XCTAssertEqual(FoldSplit.settle(470, window: window), 470)
		XCTAssertEqual(FoldSplit.settle(530, window: window), 530)
		XCTAssertEqual(FoldSplit.settle(10, window: window), 260)
		XCTAssertEqual(FoldSplit.settle(2000, window: window), 600)
	}
}
