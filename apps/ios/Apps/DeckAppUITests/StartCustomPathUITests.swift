import XCTest

/// Starting a session in a folder that isn't a project. Needs the demo-fixture
/// server, whose home holds its data directory but no "missing" folder.
final class StartCustomPathUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testStartsInAFolderAndShowsARefusedOne() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Start"].firstMatch.tap()

		// A missing folder is offered as a new one, made when the session starts.
		typePath(app, "~/missing")
		XCTAssertTrue(app.staticTexts["New folder: created when you start."].waitForExistence(timeout: 10),
			"a missing folder should be offered as a new one\n\(app.debugDescription.prefix(3000))")

		// deck will not make a hidden folder, so it says why and offers no start.
		typePath(app, "~/.missing")
		let reason = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'hidden (dot) folder'")).firstMatch
		XCTAssertTrue(reason.waitForExistence(timeout: 10), "the refusal should show\n\(app.debugDescription.prefix(3000))")
		shot("custom-path-refused")
		XCTAssertFalse(newSessionButton(app).isEnabled, "a refused folder can't be started")
		let shell = app.buttons["startShell"].firstMatch
		XCTAssertTrue(!shell.exists || !shell.isEnabled, "nor can a terminal open in it")

		openSheet(app, path: "~/data")
		XCTAssertTrue(app.staticTexts["Folder"].exists, "a folder is named as one, with no worktree choice")
		shot("custom-path-sheet")
		tapStart(app)
		let composer = app.descendants(matching: .any)["sessionComposer"]
		XCTAssertTrue(composer.waitForExistence(timeout: 60), "a session should open\n\(app.debugDescription.prefix(3000))")
	}

	private func openSheet(_ app: XCUIApplication, path: String) {
		typePath(app, path)
		let new = newSessionButton(app)
		XCTAssertTrue(new.waitForExistence(timeout: 10))
		new.tap()
		XCTAssertTrue(app.navigationBars["New session"].waitForExistence(timeout: 10), "the sheet should open\n\(app.debugDescription.prefix(3000))")
	}

	private func newSessionButton(_ app: XCUIApplication) -> XCUIElement {
		app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'New session in'")).firstMatch
	}

	private func typePath(_ app: XCUIApplication, _ path: String) {
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
