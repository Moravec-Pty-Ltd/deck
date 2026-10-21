import XCTest

/// Schedules (deck#235) against the stub deck the test hosts, so it needs no
/// running server and leaves none changed. The app is signed out at the end, the
/// same bargain RunsUITests makes.
///
/// What is worth pinning here is what the row says and what a tap asks for: a
/// schedule pointed at a session that has gone has to look different from a
/// healthy one, and pausing has to send `enabled` and nothing else.
final class SchedulesUITests: XCTestCase {
	private var server: RunStubServer!
	private var app: XCUIApplication!

	override func setUpWithError() throws {
		continueAfterFailure = false
		server = try RunStubServer()
		try server.start()
		app = XCUIApplication()
		app.launch()
		signIn()
		addTeardownBlock { [app, server] in
			if let app { Self.signOut(app) }
			server?.stop()
		}
		openSchedules()
	}

	func testListsEachScheduleWithItsCadenceAndTarget() {
		XCTAssertTrue(
			app.staticTexts["Morning sweep"].waitForExistence(timeout: 20),
			"the spawning schedule should be listed\n\(app.debugDescription.prefix(4000))")
		XCTAssertTrue(app.staticTexts["0 9 * * mon-fri"].exists, "its expression should be on the row")
		XCTAssertTrue(app.staticTexts["example"].exists, "a directory target shows its project")
		XCTAssertTrue(app.staticTexts["Ran"].exists, "the last outcome should be shown")

		XCTAssertTrue(app.staticTexts["Hourly check"].exists)
		XCTAssertTrue(app.staticTexts["0 * * * *"].exists)
		XCTAssertTrue(app.staticTexts["Failed"].exists)
	}

	/// A session target with no title is one deck can no longer find, and that
	/// is why the schedule stopped. Saying so is the whole job of the row.
	func testASchedulePointedAtAMissingSessionSaysSo() {
		XCTAssertTrue(
			app.staticTexts["session no longer exists"].waitForExistence(timeout: 20),
			"a vanished session should be named as the reason\n\(app.debugDescription.prefix(4000))")
		XCTAssertTrue(
			app.staticTexts["the session this schedule sends to no longer exists"].exists,
			"deck's own note should be shown")
	}

	/// Pausing sends `enabled` alone. A toggle in a list has no form behind it,
	/// so anything else in the body would be this screen inventing values.
	func testPausingSendsOnlyTheEnabledFlag() {
		let toggle = app.switches["Pause Morning sweep"].firstMatch
		XCTAssertTrue(
			toggle.waitForExistence(timeout: 20),
			"the row should offer a pause toggle\n\(app.debugDescription.prefix(4000))")
		toggle.tap()

		let patched = expectation(for: NSPredicate { [server] _, _ in
			server?.patches.contains { $0.path.hasSuffix("/api/agent/schedules/sch_spawn") } == true
		}, evaluatedWith: nil)
		wait(for: [patched], timeout: 15)

		let patch = server.patches.first { $0.path.hasSuffix("/api/agent/schedules/sch_spawn") }
		XCTAssertEqual(patch?.body["enabled"] as? Bool, false)
		XCTAssertEqual(patch?.body.count, 1, "the body carried more than the flag: \(patch?.body ?? [:])")
	}

	/// The form opens on the shape the schedule already is, rather than
	/// defaulting back to a fresh session and quietly changing its target.
	func testEditingOpensOnTheScheduleAsItStands() {
		let edit = app.buttons.matching(NSPredicate(format: "label == 'Edit'")).element(boundBy: 0)
		XCTAssertTrue(edit.waitForExistence(timeout: 20), "\(app.debugDescription.prefix(4000))")
		edit.tap()
		XCTAssertTrue(
			app.navigationBars["Edit schedule"].waitForExistence(timeout: 10),
			"the form should open\n\(app.debugDescription.prefix(3000))")
		// The newest schedule is the spawning one, so the form is on the
		// project shape and its expression.
		XCTAssertTrue(app.textFields["scheduleCron"].waitForExistence(timeout: 5))
		XCTAssertEqual(app.textFields["scheduleCron"].value as? String, "0 9 * * mon-fri")
	}

	// MARK: Harness

	private func openSchedules() {
		app.buttons["Start"].firstMatch.tap()
		let open = app.buttons["openSchedules"].firstMatch
		XCTAssertTrue(
			open.waitForExistence(timeout: 20),
			"the Start tab should offer schedules\n\(app.debugDescription.prefix(3000))")
		open.tap()
		XCTAssertTrue(
			app.navigationBars["Schedules"].waitForExistence(timeout: 10),
			"the schedules list should open\n\(app.debugDescription.prefix(3000))")
	}

	private func signIn() {
		if app.buttons["Inbox"].firstMatch.waitForExistence(timeout: 5) { Self.signOut(app) }
		let manual = app.buttons["Enter details manually"]
		XCTAssertTrue(manual.waitForExistence(timeout: 10))
		manual.tap()
		let urlField = app.textFields["Server URL"]
		XCTAssertTrue(urlField.waitForExistence(timeout: 5))
		urlField.tap()
		urlField.typeText(server.url)
		let tokenField = app.secureTextFields["Token"]
		tokenField.tap()
		tokenField.typeText(RunStubServer.token)
		app.buttons["Connect"].tap()
		let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
		if allow.waitForExistence(timeout: 3) { allow.tap() }
		XCTAssertTrue(app.buttons["Inbox"].firstMatch.waitForExistence(timeout: 20), "no tabs\n\(app.debugDescription.prefix(3000))")
	}

	private static func signOut(_ app: XCUIApplication) {
		app.terminate()
		app.launch()
		guard app.buttons["openSettings"].firstMatch.waitForExistence(timeout: 20) else { return }
		app.buttons["openSettings"].firstMatch.tap()
		let signOut = app.buttons["Sign out"].firstMatch
		if !signOut.waitForExistence(timeout: 5) { app.swipeUp() }
		signOut.tap()
		let confirm = app.sheets.buttons["Sign out"].firstMatch
		if confirm.waitForExistence(timeout: 5) {
			confirm.tap()
		} else {
			app.buttons.matching(identifier: "Sign out").element(boundBy: 1).tap()
		}
		_ = app.buttons["Enter details manually"].waitForExistence(timeout: 10)
	}
}
