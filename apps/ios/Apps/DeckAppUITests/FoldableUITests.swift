import XCTest

/// The layouts for a foldable phone, run on the iPhone Duo simulator: opened
/// flat, the sessions list and the open session sit side by side; half open
/// on a table (faked with DECK_HINGE, since the simulator can neither bend
/// nor turn the open display) the transcript stands above the fold and the
/// voice controls lie below it. Needs a deck server in demo mode
/// (DECK_DEMO=1) with speech configured.
final class FoldableUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testOpenFlatShowsListBesideSession() throws {
		guard Self.isFoldable else { throw XCTSkip("opened flat needs the iPhone Duo simulator") }
		let app = try Self.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		let row = app.staticTexts["Stream token diff renderer"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the demo session\n\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(app.staticTexts["No session open"].exists, "the detail column starts empty beside the list")
		row.tap()

		XCTAssertTrue(app.navigationBars["Stream token diff renderer"].waitForExistence(timeout: 20))
		XCTAssertTrue(app.navigationBars["Sessions"].exists, "the list stays open beside the session")
		XCTAssertTrue(app.staticTexts["dev server"].exists)
		attach(app, "open-flat")
	}

	func testTabletopSplitsTranscriptAboveVoice() throws {
		guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("the tabletop layout is a phone's") }
		let app = try Self.launch(environment: ["DECK_HINGE": "tabletop"])
		app.buttons["Sessions"].firstMatch.tap()

		let row = app.staticTexts["Yolo badge in session header"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		let start = app.buttons["Start voice mode"]
		XCTAssertTrue(start.waitForExistence(timeout: 20), "the lower half offers voice mode\n\(app.debugDescription)")
		XCTAssertFalse(app.navigationBars["Sessions"].exists, "the session takes the whole window on a tabletop")
		let transcript = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Done. The yolo badge'")).firstMatch
		XCTAssertTrue(transcript.waitForExistence(timeout: 20))
		let window = app.windows.firstMatch.frame
		XCTAssertLessThan(transcript.frame.midY, window.midY, "the transcript sits above the fold")
		XCTAssertGreaterThan(start.frame.midY, window.midY, "voice sits below the fold")
		attach(app, "tabletop")

		start.tap()
		let talk = app.buttons["Hold to talk"]
		XCTAssertTrue(talk.waitForExistence(timeout: 10), "voice deck missing\n\(app.debugDescription.prefix(3000))")
		XCTAssertGreaterThan(talk.frame.midY, window.midY)
		XCTAssertTrue(app.buttons["Stop reading and interrupt"].exists)
		attach(app, "tabletop-voice")

		app.buttons["Turn voice mode off"].tap()
		XCTAssertTrue(start.waitForExistence(timeout: 10))
	}

	/// Every screen, since the open display is not the main one.
	private func attach(_ app: XCUIApplication, _ name: String) {
		for (index, screen) in XCUIScreen.screens.enumerated() {
			let attachment = XCTAttachment(screenshot: screen.screenshot())
			attachment.name = "\(name)-\(index)"
			attachment.lifetime = .keepAlways
			add(attachment)
		}
	}

	/// Only the simulator says which device it is; the tests run on nothing else.
	static var isFoldable: Bool {
		ProcessInfo.processInfo.environment["SIMULATOR_DEVICE_NAME"]?.contains("Duo") == true
	}

	static func launch(environment: [String: String]) throws -> XCUIApplication {
		guard let url = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }
		let app = XCUIApplication()
		app.launchEnvironment = environment
		app.launch()
		let manual = app.buttons["Enter details manually"]
		if manual.waitForExistence(timeout: 5) {
			manual.tap()
			let urlField = app.textFields["Server URL"]
			XCTAssertTrue(urlField.waitForExistence(timeout: 5))
			urlField.tap()
			urlField.typeText(url)
			let tokenField = app.secureTextFields["Token"]
			tokenField.tap()
			tokenField.typeText(token)
			app.buttons["Connect"].tap()
		}
		// A fresh simulator asks about notifications right after sign-in.
		let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
		if allow.waitForExistence(timeout: 3) { allow.tap() }
		// On the open display the tabs sit in a rail rather than a tab bar.
		XCTAssertTrue(app.buttons["Inbox"].firstMatch.waitForExistence(timeout: 20), "no tabs\n\(app.debugDescription.prefix(3000))")
		return app
	}
}
