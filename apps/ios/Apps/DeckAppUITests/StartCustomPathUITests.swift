import XCTest

/// Starting a session in a folder that isn't a project. Needs the demo-fixture
/// server, whose home holds its data directory but no "missing" folder.
final class StartCustomPathUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testStartsInAFolderAndShowsAMissingOne() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Start"].firstMatch.tap()

		openSheet(app, path: "~/missing")
		tapStart(app)
		let error = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'cwd does not exist'")).firstMatch
		XCTAssertTrue(error.waitForExistence(timeout: 20), "the server's error should show in the sheet\n\(app.debugDescription.prefix(3000))")
		shot("custom-path-missing")
		app.navigationBars["New session"].buttons["Cancel"].tap()

		openSheet(app, path: "~/data")
		XCTAssertTrue(app.staticTexts["Folder"].exists, "a folder is named as one, with no worktree choice")
		shot("custom-path-sheet")
		tapStart(app)
		let composer = app.descendants(matching: .any)["sessionComposer"]
		XCTAssertTrue(composer.waitForExistence(timeout: 60), "a session should open\n\(app.debugDescription.prefix(3000))")
	}

	private func openSheet(_ app: XCUIApplication, path: String) {
		let picker = app.buttons["startProject"].firstMatch
		XCTAssertTrue(picker.waitForExistence(timeout: 20), "the project picker is missing\n\(app.debugDescription.prefix(3000))")
		picker.tap()
		app.buttons["Custom path…"].firstMatch.tap()
		let field = app.textFields["customPath"].firstMatch
		XCTAssertTrue(field.waitForExistence(timeout: 10), "the path field is missing\n\(app.debugDescription.prefix(3000))")
		field.tap()
		// The field keeps what was typed last time; clear it first.
		if let typed = field.value as? String, !typed.isEmpty, typed != field.placeholderValue {
			field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
		}
		field.typeText(path)
		shot("custom-path-field")
		let new = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New session in'")).firstMatch
		XCTAssertTrue(new.waitForExistence(timeout: 10))
		new.tap()
		XCTAssertTrue(app.navigationBars["New session"].waitForExistence(timeout: 10), "the sheet should open\n\(app.debugDescription.prefix(3000))")
	}

	/// Start waits for the defaults to load, so wait for it to enable first.
	private func tapStart(_ app: XCUIApplication) {
		let start = app.navigationBars["New session"].buttons["Start"]
		let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: start)
		wait(for: [enabled], timeout: 20)
		start.tap()
		shot("custom-path-after-start")
	}

	/// Saved for a person to look at when DECK_UITEST_SHOTS names a folder.
	private func shot(_ name: String) {
		guard let dir = ProcessInfo.processInfo.environment["DECK_UITEST_SHOTS"] else { return }
		try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
	}
}
