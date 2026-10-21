import XCTest

/// The phone layout of the Sessions tab: a session pushes over the list and
/// the back button returns to it; a search hit opens its session the same
/// way. Needs a deck server in demo mode (DECK_DEMO=1).
final class SessionsCompactUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testSessionPushesOverTheListAndSearchOpensAHit() throws {
		guard UIDevice.current.userInterfaceIdiom == .phone, !FoldableUITests.isFoldable else {
			throw XCTSkip("an iPad or an open foldable shows the list beside the session")
		}
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		let row = app.staticTexts["Yolo badge in session header"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the demo sessions\n\(app.debugDescription.prefix(3000))")
		XCTAssertFalse(app.staticTexts["No session open"].exists, "a phone has no detail column")
		row.tap()

		XCTAssertTrue(app.navigationBars["Yolo badge in session header"].waitForExistence(timeout: 20))
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Done. The yolo badge'")).firstMatch.waitForExistence(timeout: 20))
		XCTAssertFalse(app.staticTexts["dev server"].exists, "the list is covered by the session")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.staticTexts["dev server"].waitForExistence(timeout: 10), "back returns to the list")

		let field = app.searchFields.firstMatch
		if !field.exists { app.buttons["Search"].firstMatch.tap() }
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		field.tap()
		field.typeText("token diff")
		let hit = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'token diff into the renderer'")).firstMatch
		XCTAssertTrue(hit.waitForExistence(timeout: 20), "no search hit rendered\n\(app.debugDescription.prefix(3000))")
		hit.tap()
		XCTAssertTrue(app.navigationBars["Stream token diff renderer"].waitForExistence(timeout: 20), "the hit should open its session")
	}
}
