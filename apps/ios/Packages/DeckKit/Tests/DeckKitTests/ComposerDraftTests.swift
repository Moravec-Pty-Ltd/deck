import XCTest
@testable import DeckKit

/// The same cases as deck's `composer-draft-core` tests.
final class ComposerDraftTests: XCTestCase {
	private func image(_ size: Int, _ id: String = "i") -> DeckImage {
		DeckImage(id: id, mediaType: "image/png", data: String(repeating: "a", count: size))
	}

	func testWhitespaceOnlyTextWithNoImagesIsEmpty() {
		XCTAssertTrue(ComposerDraft(text: " \n\t").isEmpty)
		XCTAssertFalse(ComposerDraft(text: "hi").isEmpty)
		XCTAssertFalse(ComposerDraft(images: [image(1)]).isEmpty)
	}

	func testOriginIsAdoptedHeldAndCleared() {
		XCTAssertEqual(ComposerDraft.nextOrigin(nil, isEmpty: false, current: "a"), "a")
		XCTAssertEqual(ComposerDraft.nextOrigin("a", isEmpty: false, current: "b"), "a")
		XCTAssertNil(ComposerDraft.nextOrigin("a", isEmpty: true, current: "b"))
	}

	func testCrossSession() {
		XCTAssertFalse(ComposerDraft.isCrossSession(nil, current: "a"))
		XCTAssertFalse(ComposerDraft.isCrossSession("a", current: "a"))
		XCTAssertTrue(ComposerDraft.isCrossSession("a", current: "b"))
	}

	func testBudgetStopsAtTheFirstOverflow() {
		let kept = ComposerDraft.clamped([image(60, "1"), image(60, "2"), image(10, "3")], budget: 100)
		XCTAssertEqual(kept.map(\.id), ["1"])
		XCTAssertEqual(ComposerDraft.clamped([image(60, "1"), image(40, "2")], budget: 100).count, 2)
	}

	func testEncodingKeepsTextAndDropsImagesPastTheBudget() throws {
		let draft = ComposerDraft(text: "hello", images: [image(50), image(80)], originSessionId: "s1")
		let decoded = try XCTUnwrap(ComposerDraft.decoded(draft.encoded(budget: 100)))
		XCTAssertEqual(decoded.text, "hello")
		XCTAssertEqual(decoded.images.count, 1)
		XCTAssertEqual(decoded.originSessionId, "s1")
	}

	func testRoundTripGivesImagesFreshIds() throws {
		let draft = ComposerDraft(text: "x", images: [image(3, "keep")], originSessionId: "s")
		let decoded = try XCTUnwrap(ComposerDraft.decoded(draft.encoded()))
		XCTAssertEqual(decoded.images.map(\.data), ["aaa"])
		XCTAssertEqual(decoded.images.map(\.mediaType), ["image/png"])
		XCTAssertNotEqual(decoded.images.first?.id, "keep")
	}

	func testEmptyDraftEncodesToNil() {
		XCTAssertNil(ComposerDraft(text: "  ").encoded())
	}

	func testDecodingIsTolerant() throws {
		XCTAssertNil(ComposerDraft.decoded(nil))
		XCTAssertNil(ComposerDraft.decoded(Data("not json".utf8)))
		XCTAssertNil(ComposerDraft.decoded(Data(#"{"text":" ","images":[]}"#.utf8)))
		let json = #"{"text":"t","images":[{"mediaType":"image/png","data":"zz"},{"mediaType":1},"x"]}"#
		let decoded = try XCTUnwrap(ComposerDraft.decoded(Data(json.utf8)))
		XCTAssertEqual(decoded.images.map(\.data), ["zz"])
		XCTAssertNil(decoded.originSessionId)
	}
}
