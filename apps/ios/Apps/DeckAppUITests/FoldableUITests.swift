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

		let row = Self.listItem("Stream token diff renderer", in: app)
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

		let row = Self.listItem("Yolo badge in session header", in: app)
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
		VoiceUITests.allowMicrophone()
		let talk = app.buttons["Hold to talk"]
		XCTAssertTrue(talk.waitForExistence(timeout: 10), "voice deck missing\n\(app.debugDescription.prefix(3000))")
		XCTAssertGreaterThan(talk.frame.midY, window.midY)
		XCTAssertTrue(app.buttons["Stop reading and interrupt"].exists)
		attach(app, "tabletop-voice")

		app.buttons["Turn voice mode off"].tap()
		XCTAssertTrue(start.waitForExistence(timeout: 10))
	}

	/// Opened flat, a sheet from the session would straddle the fold, so it
	/// opens on the session's half instead.
	func testOpenFlatKeepsSheetsOnTheSessionHalf() throws {
		guard Self.isFoldable else { throw XCTSkip("opened flat needs the iPhone Duo simulator") }
		let app = try Self.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = Self.listItem("Stream token diff renderer", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()
		let window = app.windows.firstMatch.frame

		let rename = app.buttons["renameSession"]
		XCTAssertTrue(rename.waitForExistence(timeout: 20))
		rename.tap()
		let renameBar = app.navigationBars["Rename session"]
		XCTAssertTrue(renameBar.waitForExistence(timeout: 5), "rename did not open\n\(app.debugDescription.prefix(3000))")
		XCTAssertGreaterThanOrEqual(renameBar.frame.minX, window.midX, "rename sits on the session's half")
		attach(app, "open-flat-rename")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(renameBar.waitForNonExistence(timeout: 5))

		app.buttons["sessionMenu"].tap()
		let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model' OR label == 'Change model'")).firstMatch
		XCTAssertTrue(model.waitForExistence(timeout: 5))
		model.tap()
		let modelBar = app.navigationBars["Model"]
		XCTAssertTrue(modelBar.waitForExistence(timeout: 5), "the model picker did not open\n\(app.debugDescription.prefix(3000))")
		XCTAssertGreaterThanOrEqual(modelBar.frame.minX, window.midX, "the model picker sits on the session's half")
		attach(app, "open-flat-model")
		app.buttons["Cancel"].tap()
	}

	/// Half open with a PR and a question pending, everything to tap lies on
	/// the flat half; the standing half shows only the PR's status.
	func testTabletopPutsPRActionsOnTheFlatHalf() throws {
		guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("the tabletop layout is a phone's") }
		guard let url = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }
		let app = try Self.launch(environment: ["DECK_HINGE": "tabletop"])
		app.buttons["Sessions"].firstMatch.tap()
		let row = Self.listItem("ask smoke", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()

		let sessionId = try VoiceUITests.sessionId(titled: "ask smoke", url: url, token: token)
		// Answered from outside, so the question does not outlive the test.
		addTeardownBlock { try? VoiceUITests.send("Blue", sessionId: sessionId, url: url, token: token, route: "answer") }
		try VoiceUITests.send("[ask] Ask me which colour to use.", sessionId: sessionId, url: url, token: token)
		let send = app.buttons["Send answers"]
		XCTAssertTrue(send.waitForExistence(timeout: 60), "no ask card\n\(app.debugDescription.prefix(3000))")

		let window = app.windows.firstMatch.frame
		let review = app.buttons["prReview"]
		XCTAssertTrue(review.waitForExistence(timeout: 10), "needs the fixture's PR on 'ask smoke'")
		XCTAssertGreaterThan(review.frame.midY, window.midY, "PR actions lie on the flat half")
		XCTAssertFalse(app.buttons["prRow"].exists, "the standing half only shows the PR, so a tap cannot wobble it")
		XCTAssertGreaterThan(send.frame.midY, window.midY)
		attach(app, "tabletop-pr-ask")
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

	/// A row of the sessions list, scrolled into view: the list builds only the
	/// rows on screen, and grouped, the fixture's sessions run past a phone's.
	static func listItem(_ label: String, in app: XCUIApplication) -> XCUIElement {
		let item = app.staticTexts[label].firstMatch
		let list = app.collectionViews.firstMatch
		_ = list.cells.firstMatch.waitForExistence(timeout: 20)
		for _ in 0..<5 where !item.exists { list.swipeUp() }
		return item
	}

	/// The first session in the list. On iPad the list is a sidebar, whose
	/// group headers are cells too; a header holds one label, a session several.
	static func firstSessionRow(in list: XCUIElement) -> XCUIElement {
		_ = list.cells.firstMatch.waitForExistence(timeout: 20)
		return list.cells.allElementsBoundByIndex.first { $0.staticTexts.count > 1 } ?? list.cells.firstMatch
	}
}
