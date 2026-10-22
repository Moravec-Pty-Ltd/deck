import XCTest
@testable import DeckKit

@MainActor
final class DraftStoreTests: XCTestCase {
	private func draft(_ text: String) -> ComposerDraft { ComposerDraft(text: text) }

	func testTheFirstTypistOwnsAnEmptySlot() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("one"), from: "a")
		XCTAssertEqual(store.saved?.text, "one")
		XCTAssertEqual(store.claim(for: "a")?.text, "one")
		XCTAssertNil(store.claim(for: "b"))
	}

	func testAnotherSessionCannotOverwriteTheOwner() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("mine"), from: "a")
		store.update(draft("theirs"), from: "b")
		XCTAssertEqual(store.saved?.text, "mine")
	}

	func testEmptyingTheOwnersDraftClearsTheSlot() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("x"), from: "a")
		store.update(draft(""), from: "a")
		XCTAssertNil(store.saved)
		store.update(draft("y"), from: "b")
		XCTAssertEqual(store.saved?.text, "y")
	}

	func testReleaseHandsTheDraftOnToAnotherSession() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("x"), from: "a")
		store.release(draft("x edited"), from: "a")
		XCTAssertEqual(store.claim(for: "b")?.text, "x edited")
		XCTAssertNil(store.claim(for: "a"))
	}

	func testAnUnownedSavedDraftIsNotOverwrittenByTyping() {
		let store = DraftStore(fileURL: nil)
		store.release(draft("kept"), from: "a")
		store.update(draft("new"), from: "b")
		XCTAssertEqual(store.saved?.text, "kept")
	}

	func testEmptyReleaseLeavesTheSavedDraftButFreesTheOwner() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("x"), from: "a")
		store.release(draft(""), from: "a")
		XCTAssertEqual(store.saved?.text, "x")
		XCTAssertEqual(store.claim(for: "b")?.text, "x")
	}

	func testEmptyReleaseFromANonOwnerChangesNothing() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("x"), from: "a")
		store.release(draft(""), from: "b")
		XCTAssertNil(store.claim(for: "b"))
		XCTAssertEqual(store.claim(for: "a")?.text, "x")
	}

	func testSavedDraftSurvivesARestart() throws {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent("draft-\(UUID().uuidString).json")
		defer { try? FileManager.default.removeItem(at: url) }
		let store = DraftStore(fileURL: url)
		store.update(ComposerDraft(text: "hello", originSessionId: "a"), from: "a")
		store.flush()
		XCTAssertEqual(DraftStore(fileURL: url).saved?.text, "hello")

		store.update(draft(""), from: "a")
		store.flush()
		XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
		XCTAssertNil(DraftStore(fileURL: url).saved)
	}

	func testTheSessionThatLeftTheDraftKeepsWritingIt() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("x"), from: "a")
		store.release(draft("x"), from: "a")
		store.update(draft("x more"), from: "a")
		XCTAssertEqual(store.saved?.text, "x more")
		store.update(draft("theirs"), from: "b")
		XCTAssertEqual(store.saved?.text, "x more")
	}

	func testAClosedPanesDraftIsNotOverwrittenByTheOtherPane() {
		let store = DraftStore(fileURL: nil)
		store.update(draft("main"), from: "a")
		store.release(draft("beside"), from: "b")
		store.update(draft("main more"), from: "a")
		XCTAssertEqual(store.saved?.text, "beside")
		XCTAssertEqual(store.claim(for: "c")?.text, "beside")
	}

	func testAClaimedDraftKeepsItsOrigin() {
		let store = DraftStore(fileURL: nil)
		store.update(ComposerDraft(text: "x", originSessionId: "a"), from: "a")
		store.release(ComposerDraft(text: "x", originSessionId: "a"), from: "a")
		XCTAssertEqual(store.claim(for: "b")?.originSessionId, "a")
	}
}
