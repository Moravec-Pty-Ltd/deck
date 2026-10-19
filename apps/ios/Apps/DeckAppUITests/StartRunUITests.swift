import XCTest

/// The run start form, against a running deck (see the README for the two env
/// vars). It opens the form and cancels: starting a run on a live deck would
/// create a worktree and spawn sessions.
final class StartRunUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	/// Anything whose label starts with this, whatever element type SwiftUI
	/// chose for it.
	private func labelled(_ app: XCUIApplication, startingWith prefix: String) -> XCUIElementQuery {
		app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix))
	}

	func testTheInboxOffersStartingARunAndTheFormAsksForWhatItNeeds() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Inbox"].firstMatch.tap()

		let start = app.buttons["Start a run"].firstMatch
		XCTAssertTrue(
			start.waitForExistence(timeout: 20),
			"the Inbox offers no way to start a run\n\(app.debugDescription.prefix(3000))")
		start.tap()

		XCTAssertTrue(
			app.navigationBars["Start a run"].waitForExistence(timeout: 10),
			"the start form did not open\n\(app.debugDescription.prefix(3000))")
		// Project and workflow are chosen for you; the source is what you pick.
		// A Form picker is a button labelled "Project, <value>", not a static text.
		XCTAssertTrue(
			labelled(app, startingWith: "Project").firstMatch.waitForExistence(timeout: 10),
			"no project picker\n\(app.debugDescription.suffix(4000))")
		// Counted, not `.exists`: SwiftUI gives a Form picker more than one
		// matching element, and asking a multi-match query to resolve one throws.
		XCTAssertGreaterThan(labelled(app, startingWith: "Workflow").count, 0, "no workflow picker")
		// Scoped to the sheet's own bar: the app has a "Start" tab too, and an
		// unscoped query matches both.
		let bar = app.navigationBars["Start a run"]
		// Start stays off until an issue or PR is picked.
		XCTAssertFalse(bar.buttons["Start"].isEnabled, "Start is enabled with nothing picked")

		bar.buttons["Cancel"].tap()
		XCTAssertEqual(app.state, .runningForeground, "the app died closing the start form")
	}
}
