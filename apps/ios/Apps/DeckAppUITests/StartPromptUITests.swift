import XCTest

/// Starting a session with nothing behind it: a project, a first message and
/// a branch. Needs the demo-fixture server, whose project is "files-proj".
final class StartPromptUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testStartsASessionFromAPromptAlone() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Start"].firstMatch.tap()

		let prompt = app.segmentedControls.buttons["Prompt"].firstMatch
		XCTAssertTrue(prompt.waitForExistence(timeout: 20), "the Start tab should offer a plain prompt\n\(app.debugDescription.prefix(3000))")
		prompt.tap()
		let new = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New session in'")).firstMatch
		XCTAssertTrue(new.waitForExistence(timeout: 10))
		new.tap()

		XCTAssertTrue(app.navigationBars["New session"].waitForExistence(timeout: 10), "the sheet should open\n\(app.debugDescription.prefix(3000))")
		let field = app.descendants(matching: .any)["firstPrompt"]
		XCTAssertTrue(field.waitForExistence(timeout: 10), "the first-prompt field is missing\n\(app.debugDescription.prefix(3000))")
		field.tap()
		// Only a prompt: the title and branch come from its first words.
		field.typeText("Smoke \(Int(Date().timeIntervalSince1970) % 100000) reply with exactly: prompt session ready")
		// The sheet's own Start, not the tab bar's button of the same name.
		app.navigationBars["New session"].buttons["Start"].tap()
		// Landing on the session's own screen is what says it was created.
		let composer = app.descendants(matching: .any)["sessionComposer"]
		XCTAssertTrue(composer.waitForExistence(timeout: 60), "a session should open\n\(app.debugDescription.prefix(3000))")
	}
}
