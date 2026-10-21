import XCTest
@testable import DeckKit

final class TranscriptFollowTests: XCTestCase {
	private func at(_ offset: Double, content: Double = 2000, container: Double = 500) -> TranscriptFollow.Geometry {
		TranscriptFollow.Geometry(offset: offset, contentHeight: content, containerHeight: container)
	}

	func testGrowthAtTheEndPinsWithoutChangingFollowing() {
		let step = TranscriptFollow.step(from: at(1500), to: at(1500, content: 2400), isNearBottom: true)
		XCTAssertEqual(step, .init(isNearBottom: true, pin: true))
	}

	func testGrowthAfterScrollingUpLeavesTheReaderAlone() {
		let step = TranscriptFollow.step(from: at(200), to: at(200, content: 2400), isNearBottom: false)
		XCTAssertEqual(step, .init(isNearBottom: false, pin: false))
	}

	func testScrollingUpWhileRowsAboveTakeTheirHeightStopsFollowing() {
		let step = TranscriptFollow.step(from: at(1500), to: at(1400, content: 2400), isNearBottom: true, userScrolling: true)
		XCTAssertEqual(step, .init(isNearBottom: false, pin: false))
	}

	func testGrowthWhileTheReaderScrollsNearTheEndNeverPins() {
		let step = TranscriptFollow.step(from: at(1500), to: at(1550, content: 2100), isNearBottom: true, userScrolling: true)
		XCTAssertEqual(step, .init(isNearBottom: true, pin: false))
	}

	func testScrollingUpStopsFollowing() {
		let step = TranscriptFollow.step(from: at(1500), to: at(1200), isNearBottom: true)
		XCTAssertEqual(step, .init(isNearBottom: false, pin: false))
	}

	func testANudgeUpNearTheEndKeepsFollowing() {
		let step = TranscriptFollow.step(from: at(1500), to: at(1450), isNearBottom: true)
		XCTAssertTrue(step.isNearBottom)
	}

	func testAPinThatLandsShortKeepsFollowing() {
		let step = TranscriptFollow.step(from: at(600), to: at(1100), isNearBottom: true)
		XCTAssertEqual(step, .init(isNearBottom: true, pin: false))
	}

	func testScrollingBackToTheEndResumesFollowing() {
		let step = TranscriptFollow.step(from: at(900), to: at(1490), isNearBottom: false)
		XCTAssertTrue(step.isNearBottom)
	}

	func testScrollingDownShortOfTheEndDoesNotResume() {
		let step = TranscriptFollow.step(from: at(200), to: at(800), isNearBottom: false)
		XCTAssertFalse(step.isNearBottom)
	}

	func testAResizeAtTheEndPins() {
		let step = TranscriptFollow.step(from: at(1500), to: at(1500, container: 420), isNearBottom: true)
		XCTAssertEqual(step, .init(isNearBottom: true, pin: true))
	}
}
