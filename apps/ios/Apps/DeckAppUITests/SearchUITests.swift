import XCTest

/// Search from the Sessions tab. `testSearchOpensTheMatchingSession` needs the
/// VoiceUITests fixture (a session named "voice smoke" whose transcript says
/// "You picked"); the name-search test below runs against the ordinary demo
/// fixture and skips if its sessions are missing.
final class SearchUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testSearchOpensTheMatchingSession() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		// On iPad the field lives in the sidebar's navigation bar, so look there
		// as well as at the top level.
		var field = app.searchFields.firstMatch
		if !field.waitForExistence(timeout: 10) {
			field = app.navigationBars.searchFields.firstMatch
		}
		XCTAssertTrue(
			field.waitForExistence(timeout: 10),
			"no search field\n\(app.debugDescription.prefix(3500))")
		field.tap()
		field.typeText("you picked")
		let hit = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'You picked'")).firstMatch
		XCTAssertTrue(hit.waitForExistence(timeout: 20), "no search hit rendered\n\(app.debugDescription.prefix(3000))")
		hit.tap()
		XCTAssertTrue(app.buttons.matching(identifier: "renameSession").matching(NSPredicate(format: "label == %@", "voice smoke")).firstMatch.waitForExistence(timeout: 20), "the hit should open its session")
		// In the transcript: on iPad the hit's own row stays in the list beside it.
		XCTAssertTrue(app.scrollViews.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'You picked'")).firstMatch.waitForExistence(timeout: 20))
	}

	/// Typing a session's name lists it under "Sessions", ahead of anything
	/// said, and opens it. This is the common case: you know which session you
	/// want. It also exercises tapping the search field, which used to crash
	/// the Mac app when the whole list was swapped for a results view.
	func testTypingANameListsTheSessionFirst() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		guard app.staticTexts["file previews"].firstMatch.waitForExistence(timeout: 20) else {
			throw XCTSkip("needs the demo fixture sessions")
		}

		// On iPad the search field is not on screen: the navigation bar shows a
		// Search button that reveals it.
		let reveal = app.navigationBars["Sessions"].buttons["Search"]
		if reveal.waitForExistence(timeout: 10) { reveal.tap() }

		let field = app.searchFields.firstMatch
		XCTAssertTrue(
			field.waitForExistence(timeout: 10),
			"no search field after tapping Search\n\(app.debugDescription.prefix(4000))")
		field.tap()
		XCTAssertEqual(app.state, .runningForeground, "the app died on tapping the search field")
		field.typeText("file previews")

		XCTAssertTrue(
			app.staticTexts["Sessions"].waitForExistence(timeout: 10),
			"name matches should be grouped under a Sessions heading\n\(app.debugDescription.prefix(2500))")
		// A session that does not match must have gone.
		XCTAssertFalse(app.staticTexts["long transcript"].exists, "the list should be filtered to the match")

		app.staticTexts["file previews"].firstMatch.tap()
		XCTAssertTrue(
			app.buttons.matching(identifier: "renameSession").matching(NSPredicate(format: "label == %@", "file previews")).firstMatch.waitForExistence(timeout: 20),
			"the name match should open its session")
	}
}
