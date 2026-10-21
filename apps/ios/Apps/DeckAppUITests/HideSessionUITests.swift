import XCTest

/// Hiding from the Sessions tab, against a running deck server pointed at by
/// `DECK_UITEST_URL` / `DECK_UITEST_TOKEN`. This runs against a live deck, so
/// the test hides a session and puts it back before it finishes.
final class HideSessionUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	/// Swiping a row reveals Hide; hiding moves the session into the Hidden
	/// section at the bottom, where Unhide brings it back to the list.
	func testHidingMovesASessionToTheHiddenSectionAndBack() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		let list = app.collectionViews.firstMatch
		XCTAssertTrue(list.waitForExistence(timeout: 20), "sessions list never appeared")
		let row = list.cells.element(boundBy: 0)
		XCTAssertTrue(row.waitForExistence(timeout: 20), "no session rows to swipe")
		// Hold onto which session this is, so the assertions below follow it
		// rather than whatever ends up first.
		let title = row.staticTexts.element(boundBy: 0).label
		XCTAssertFalse(title.isEmpty, "the first row has no title to track")

		XCTAssertFalse(app.staticTexts["Hidden"].exists, "nothing is hidden yet")

		row.swipeLeft()
		let hide = app.buttons["Hide"]
		XCTAssertTrue(hide.waitForExistence(timeout: 5), "swipe did not reveal Hide")
		// Registered before the tap, so a failure below still puts it back.
		addTeardownBlock { try? self.setSessionHidden(id: self.firstSessionId(named: title), false) }
		hide.tap()

		let section = app.staticTexts["Hidden"]
		XCTAssertTrue(
			section.waitForExistence(timeout: 20),
			"hiding did not add a Hidden section\n\(app.debugDescription.prefix(3000))")
		// Closed to start with, so the session it holds is off the list.
		XCTAssertFalse(app.staticTexts[title].exists, "the hidden session is still on the list")

		section.tap()
		let hidden = app.staticTexts[title]
		XCTAssertTrue(
			hidden.waitForExistence(timeout: 10),
			"opening Hidden did not show the session\n\(app.debugDescription.prefix(3000))")

		// Put it back, so a live deck is left as it was found.
		let hiddenRow = list.cells.containing(.staticText, identifier: title).firstMatch
		XCTAssertTrue(hiddenRow.waitForExistence(timeout: 10))
		// The section sits at the end of the list, where the floating tab bar
		// covers the row: a swipe there lands on the bar.
		let tabBar = app.tabBars.firstMatch
		for _ in 0..<4 where tabBar.exists && hiddenRow.frame.maxY > tabBar.frame.minY {
			list.swipeUp()
		}
		hiddenRow.swipeLeft()
		let unhide = app.buttons["Unhide"]
		XCTAssertTrue(unhide.waitForExistence(timeout: 5), "the hidden row offers no Unhide")
		unhide.tap()

		XCTAssertTrue(
			app.staticTexts["Hidden"].waitForNonExistence(timeout: 20),
			"unhiding left the Hidden section behind")
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "the session did not come back")
		XCTAssertEqual(app.state, .runningForeground, "the app died hiding a session")
	}

	/// A project hidden on the server takes its sessions into the Hidden
	/// section, and they unhide through the project rather than one at a time.
	func testAHiddenProjectUnhidesFromItsOwnRow() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		XCTAssertTrue(app.collectionViews.firstMatch.waitForExistence(timeout: 20))

		guard let project = try firstProjectWithSessions() else {
			throw XCTSkip("needs a registered project that has sessions")
		}
		// Registered before the change and not with `defer`, which a failed
		// assertion skips when continueAfterFailure is off. This runs against a
		// live deck, so the undo has to happen whatever the test does.
		addTeardownBlock { try? self.setProjectHidden(project, false) }
		try setProjectHidden(project, true)

		let section = app.staticTexts["Hidden"]
		XCTAssertTrue(
			section.waitForExistence(timeout: 30),
			"hiding a project did not add a Hidden section\n\(app.debugDescription.prefix(3000))")
		section.tap()

		let unhide = app.buttons["Unhide \(project.name)"]
		XCTAssertTrue(
			unhide.waitForExistence(timeout: 10),
			"the hidden project has no row to unhide it\n\(app.debugDescription.prefix(3000))")
		unhide.tap()

		XCTAssertTrue(
			app.staticTexts["Hidden"].waitForNonExistence(timeout: 30),
			"unhiding the project left the Hidden section behind")
		XCTAssertEqual(app.state, .runningForeground, "the app died unhiding a project")
	}

	// MARK: - Setting the server up

	private struct Project: Decodable {
		let path: String
		let name: String
	}

	/// A project the server has sessions for, so hiding it actually moves
	/// something. nil when the deck under test has none.
	private func firstProjectWithSessions() throws -> Project? {
		struct Session: Decodable { let cwd: String? }
		let projects = try get([Project].self, "/api/agent/projects")
		let cwds = try get([Session].self, "/api/agent/sessions").compactMap(\.cwd)
		return projects.first { project in
			cwds.contains { $0 == project.path || $0.hasPrefix(project.path + "/") }
		}
	}

	private func setProjectHidden(_ project: Project, _ hidden: Bool) throws {
		_ = try post("/api/agent/projects/hidden", ["path": project.path, "hidden": hidden])
	}

	private func setSessionHidden(id: String?, _ hidden: Bool) throws {
		guard let id else { return }
		_ = try post("/api/agent/sessions/\(id)/hidden", ["hidden": hidden])
	}

	/// The id of the session with this title, so teardown can put back exactly
	/// the one the test hid.
	private func firstSessionId(named title: String) -> String? {
		struct Session: Decodable {
			let id: String
			let title: String?
		}
		let sessions = (try? get([Session].self, "/api/agent/sessions")) ?? []
		return sessions.first { $0.title == title }?.id
	}

	private func server() throws -> (url: URL, token: String) {
		guard let raw = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let url = URL(string: raw),
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }
		return (url, token)
	}

	private func get<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
		try JSONDecoder().decode(type, from: try send(path, body: nil))
	}

	@discardableResult
	private func post(_ path: String, _ body: [String: Any]) throws -> Data {
		try send(path, body: try JSONSerialization.data(withJSONObject: body))
	}

	/// A blocking request, because this is setup around a UI test rather than
	/// part of what is being measured.
	private func send(_ path: String, body: Data?) throws -> Data {
		let (base, token) = try server()
		var request = URLRequest(url: base.appendingPathComponent(path))
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		if let body {
			request.httpMethod = "POST"
			request.httpBody = body
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		var result: Result<Data, Error>?
		let done = DispatchSemaphore(value: 0)
		URLSession.shared.dataTask(with: request) { data, _, error in
			result = error.map { .failure($0) } ?? .success(data ?? Data())
			done.signal()
		}.resume()
		guard done.wait(timeout: .now() + 20) == .success, let result else {
			throw XCTSkip("deck did not answer \(path)")
		}
		return try result.get()
	}
}
