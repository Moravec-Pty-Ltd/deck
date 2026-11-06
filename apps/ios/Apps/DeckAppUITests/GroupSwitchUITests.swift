import XCTest

/// The group switcher against a running deck: it narrows the list, and opening a
/// session from a link brings that session's group along. Groups are set up here
/// and taken away afterwards, since every other test expects a list with none.
final class GroupSwitchUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testPickingAGroupNarrowsTheListAndALinkSwitchesBack() throws {
		let otherTitle = "group switch session"
		let projects = try get([Project].self, "/api/agent/projects")
		guard let project = projects.first(where: { $0.name == "files-proj" }) else {
			throw XCTSkip("needs the seeded files-proj project")
		}
		let otherPath = (project.path as NSString).deletingLastPathComponent + "/other-proj"
		addTeardownBlock {
			let encoded = otherPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? otherPath
			try? self.request("/api/projects?path=\(encoded)", method: "DELETE")
			try? self.post("/api/projects", ["name": project.name, "path": project.path, "group": ""])
			for session in (try? self.get([Session].self, "/api/agent/sessions")) ?? [] where session.title == otherTitle {
				try? self.request("/api/agent/sessions/\(session.id)", method: "DELETE")
			}
		}
		try post("/api/projects", ["name": project.name, "path": project.path, "group": "Client A"])
		try post("/api/projects", ["name": "other-proj", "path": otherPath, "group": "Client B"])
		try post("/api/agent/sessions", ["mode": "work", "kind": "claude", "cwd": otherPath, "title": otherTitle])
		let seeded = try XCTUnwrap(get([Session].self, "/api/agent/sessions").first { $0.title == "file previews" })

		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()

		let switcher = app.buttons["groupSwitcher"]
		XCTAssertTrue(switcher.waitForExistence(timeout: 30), "no switcher\n\(app.debugDescription.prefix(3000))")
		switcher.tap()
		// By prefix: a line also carries its count when something is waiting.
		let clientB = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Client B'")).firstMatch
		XCTAssertTrue(clientB.waitForExistence(timeout: 5), "the menu lists no Client B\n\(app.debugDescription.prefix(3000))")
		clientB.tap()

		XCTAssertTrue(app.staticTexts[otherTitle].waitForExistence(timeout: 10), "Client B's session is not listed")
		XCTAssertTrue(
			app.staticTexts["file previews"].waitForNonExistence(timeout: 10),
			"Client A's session is still listed")

		XCUIDevice.shared.system.open(URL(string: "deck://s/\(seeded.id)")!)
		XCTAssertTrue(
			app.textViews["sessionComposer"].waitForExistence(timeout: 20),
			"the link did not open the session\n\(app.debugDescription.prefix(3000))")
		// A phone pushes the session over the list; an iPad keeps the list beside it.
		if !switcher.isHittable { app.navigationBars.buttons.element(boundBy: 0).tap() }
		XCTAssertTrue(switcher.waitForExistence(timeout: 10), "the list did not come back")
		// A prefix: the label also says when another group has something waiting.
		XCTAssertTrue(switcher.label.hasPrefix("Client A"), "the link did not switch group: \(switcher.label)")
	}

	// MARK: - Setting the server up

	private struct Project: Decodable {
		let path: String
		let name: String
	}

	private struct Session: Decodable {
		let id: String
		let title: String?
	}

	private func get<T: Decodable>(_ type: T.Type, _ path: String) throws -> T {
		try JSONDecoder().decode(type, from: try request(path))
	}

	@discardableResult
	private func post(_ path: String, _ body: [String: Any]) throws -> Data {
		try request(path, method: "POST", body: try JSONSerialization.data(withJSONObject: body))
	}

	/// A blocking request, because this is setup around a UI test rather than
	/// part of what is being measured.
	@discardableResult
	private func request(_ path: String, method: String = "GET", body: Data? = nil) throws -> Data {
		guard let raw = ProcessInfo.processInfo.environment["DECK_UITEST_URL"],
			let url = URL(string: raw + path),
			let token = ProcessInfo.processInfo.environment["DECK_UITEST_TOKEN"]
		else { throw XCTSkip("set DECK_UITEST_URL and DECK_UITEST_TOKEN to run the UI tests") }
		var request = URLRequest(url: url)
		request.httpMethod = method
		request.httpBody = body
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		var result: Result<Data, Error>?
		let done = DispatchSemaphore(value: 0)
		URLSession.shared.dataTask(with: request) { data, _, error in
			result = error.map { .failure($0) } ?? .success(data ?? Data())
			done.signal()
		}.resume()
		guard done.wait(timeout: .now() + 20) == .success, let result else { throw URLError(.timedOut) }
		return try result.get()
	}
}
