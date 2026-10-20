import XCTest

/// Turns voice mode on for a session and checks a fresh reply is read: the bar
/// appears, shows "Reading" with the reply's first sentence, then rests. Needs
/// a running deck with a speech server configured and a claude session titled
/// "voice smoke" (see DECK_UITEST_URL / DECK_UITEST_TOKEN in TranscriptUITests).
final class VoiceUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testVoiceModeReadsANewReply() throws {
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
		app.tabBars.buttons["Sessions"].tap()

		let row = app.staticTexts["voice smoke"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs a claude session titled 'voice smoke'")
		row.tap()

		let toggle = app.buttons["Turn voice mode on"]
		XCTAssertTrue(toggle.waitForExistence(timeout: 20), "the voice toggle appears once /api/agent/speech reports tts")
		toggle.tap()
		XCTAssertTrue(app.staticTexts["Voice on"].waitForExistence(timeout: 5), "voice bar missing\n\(app.debugDescription)")
		XCTAssertTrue(app.buttons["Hold to talk"].exists)

		// Provoke a reply from outside the app, like a turn finishing on its own.
		let sessionId = try Self.sessionId(url: url, token: token)
		try Self.send("Reply with exactly: Simulator voice check, one sentence only.", sessionId: sessionId, url: url, token: token)

		XCTAssertTrue(app.staticTexts["Reading"].waitForExistence(timeout: 60), "the bar should start reading the reply\n\(app.debugDescription)")
		XCTAssertTrue(app.staticTexts["Voice on"].waitForExistence(timeout: 30), "the bar should rest once the reply is read")

		// Hold to talk captures a take from the (simulator's) microphone and sends
		// it for transcription; silence comes back empty and nothing is sent.
		app.buttons["Hold to talk"].press(forDuration: 2.5)
		XCTAssertTrue(app.staticTexts["Voice on"].waitForExistence(timeout: 30), "the bar should rest after the take\n\(app.debugDescription)")

		app.buttons["Turn voice mode off"].tap()
		XCTAssertFalse(app.buttons["Hold to talk"].exists)
	}

	static func sessionId(url: String, token: String) throws -> String {
		var request = URLRequest(url: URL(string: "\(url)/api/agent/sessions")!)
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		let data = try sync(request)
		let sessions = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
		guard let match = sessions.first(where: { $0["title"] as? String == "voice smoke" }), let id = match["id"] as? String else {
			throw XCTSkip("no 'voice smoke' session on the server")
		}
		return id
	}

	static func send(_ text: String, sessionId: String, url: String, token: String) throws {
		var request = URLRequest(url: URL(string: "\(url)/api/agent/sessions/\(sessionId)/message")!)
		request.httpMethod = "POST"
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: ["text": text])
		_ = try sync(request)
	}

	private static func sync(_ request: URLRequest) throws -> Data {
		let done = XCTestExpectation(description: "request")
		var result: Data?
		var failure: Error?
		URLSession.shared.dataTask(with: request) { data, _, error in
			result = data
			failure = error
			done.fulfill()
		}.resume()
		XCTWaiter().wait(for: [done], timeout: 30)
		if let failure { throw failure }
		return result ?? Data()
	}
}
