import XCTest

/// Answers a question from a notification's actions without opening deck.
/// The test backgrounds the app and waits for an ask push (delivered from
/// outside with `xcrun simctl push`), long-presses the banner, taps the
/// second option, and checks the ask resolved on the server.
final class NotificationActionUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testOptionActionAnswersTheAsk() throws {
		guard let url = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }

		let app = XCUIApplication()
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
		XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
		// Notification permission, so the banner can appear.
		let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
		app.buttons["openSettings"].firstMatch.tap()
		let enable = app.buttons["Enable notifications"]
		if enable.waitForExistence(timeout: 3) {
			enable.tap()
			let allow = springboard.buttons["Allow"]
			if allow.waitForExistence(timeout: 5) { allow.tap() }
		}
		XCUIDevice.shared.press(.home)

		let banner = springboard.descendants(matching: .any)
			.matching(NSPredicate(format: "label CONTAINS 'Needs your answer'")).firstMatch
		XCTAssertTrue(banner.waitForExistence(timeout: 120), "no ask notification arrived (push it with simctl while this waits)")
		banner.press(forDuration: 1.5)
		let option = springboard.buttons["Option 2"]
		XCTAssertTrue(option.waitForExistence(timeout: 10), "expanded notification shows no option actions\n\(springboard.debugDescription.prefix(3000))")
		option.tap()

		// The answer posts in the background; the pending ask clears once it lands.
		let deadline = Date().addingTimeInterval(30)
		var pending = true
		while pending, Date() < deadline {
			sleep(2)
			pending = (try? Self.pendingAsks(url: url, token: token)) != 0
		}
		XCTAssertFalse(pending, "the ask should be resolved by the notification action")
	}

	static func pendingAsks(url: String, token: String) throws -> Int {
		var request = URLRequest(url: URL(string: "\(url)/api/agent/asks")!)
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		let done = XCTestExpectation(description: "asks")
		var count = -1
		URLSession.shared.dataTask(with: request) { data, _, _ in
			if let data, let asks = try? JSONSerialization.jsonObject(with: data) as? [Any] { count = asks.count }
			done.fulfill()
		}.resume()
		XCTWaiter().wait(for: [done], timeout: 30)
		return count
	}
}
