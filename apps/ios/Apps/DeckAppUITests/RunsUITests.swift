import XCTest

/// Workflow runs against a stub deck the test hosts (RunStubServer), so they
/// need no running server and leave none changed. The app is signed out at
/// the end, so the live-server tests sign in to theirs as usual.
final class RunsUITests: XCTestCase {
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
		app.buttons["Inbox"].firstMatch.tap()
	}

	/// The board lists every run, the one blocked on you first even though it
	/// is the older of the two.
	func testBoardListsRunsWithTheBlockedOneFirst() {
		XCTAssertTrue(app.staticTexts["Runs"].waitForExistence(timeout: 20), "no runs section\n\(app.debugDescription.prefix(3000))")
		let blocked = row("r_blocked")
		let looping = row("r_review")
		XCTAssertTrue(blocked.waitForExistence(timeout: 10), "\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(looping.exists)
		XCTAssertLessThan(blocked.frame.minY, looping.frame.minY, "the blocked run should sort first")
		let done = row("r_done")
		XCTAssertTrue(done.exists)
		XCTAssertLessThan(looping.frame.minY, done.frame.minY, "a finished run sorts last")
		XCTAssertTrue(blocked.label.contains("needs you"), blocked.label)
		XCTAssertTrue(looping.label.contains("round 2 of 5"), "the looping run shows its round: \(looping.label)")
	}

	/// A run shows its phases, which one is current and how often a looping
	/// one ran; the phase lists each round's session separately with the
	/// overseer's call and its reason, and a round opens its session.
	func testRunViewShowsPhasesAndEachRoundDrillsIn() {
		openRun("r_review")
		XCTAssertTrue(app.staticTexts["PHASES"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Implement"].exists)
		XCTAssertTrue(app.staticTexts["current"].exists)
		XCTAssertTrue(app.staticTexts["round 2 of 5"].firstMatch.exists)
		XCTAssertTrue(app.staticTexts["1 decision"].exists)

		app.staticTexts["Review"].firstMatch.tap()
		XCTAssertTrue(app.staticTexts["Round 1"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Round 2"].exists)
		XCTAssertTrue(app.staticTexts["overseer"].exists)
		XCTAssertTrue(app.staticTexts["The reviewer timed out, not a real failure."].exists)

		app.staticTexts["Round 2"].tap()
		let opened = expectation(for: NSPredicate { _, _ in self.server.requested("c_round_two") }, evaluatedWith: nil)
		wait(for: [opened], timeout: 15)
		XCTAssertFalse(server.requested("c_round_one"), "round 1's session should open only from its own row")
	}

	/// Answering a blocked run posts the reply to deck and shows the run as
	/// deck reports it afterwards. The app posts that one action and nothing
	/// else: deck makes the transition.
	func testAnsweringABlockedRunPostsTheAnswerAndTheRunResumes() {
		openRun("r_blocked")
		XCTAssertTrue(
			app.staticTexts["Which base branch should the PR target?"].firstMatch.waitForExistence(timeout: 10),
			"the block reason is missing\n\(app.debugDescription.prefix(3000))")
		let reply = app.textFields["Or type a reply"]
		XCTAssertTrue(reply.waitForExistence(timeout: 5))
		reply.tap()
		reply.typeText("main")
		app.buttons["Send answers"].tap()

		XCTAssertTrue(app.staticTexts["running"].waitForExistence(timeout: 10), "the run did not resume\n\(app.debugDescription.prefix(3000))")
		XCTAssertFalse(app.staticTexts["NEEDS YOU"].exists)
		let posts = server.posts
		XCTAssertEqual(posts.map(\.path), ["/api/agent/runs/r_blocked/answer"])
		XCTAssertEqual(posts.first?.body["text"] as? String, "main")
	}

	/// Pause, resume at a chosen phase, and take over each post their action,
	/// and take over lands in the phase's session.
	func testControlsPostTheirActions() {
		openRun("r_review")
		let pause = app.buttons["Pause"]
		XCTAssertTrue(pause.waitForExistence(timeout: 10))
		pause.tap()
		XCTAssertTrue(app.staticTexts["paused"].waitForExistence(timeout: 10))

		let resume = app.buttons["Resume at…"]
		scrollTo(resume)
		resume.tap()
		let implement = app.sheets.buttons["Implement"].firstMatch
		XCTAssertTrue(implement.waitForExistence(timeout: 5), "the resume choice did not open")
		implement.tap()
		XCTAssertTrue(app.staticTexts["running"].waitForExistence(timeout: 10))

		let takeOver = app.buttons["Take over"].firstMatch
		scrollTo(takeOver)
		takeOver.tap()
		// The dialog's button, not the list's one that opened it.
		let sheet = app.sheets.buttons["Take over"].firstMatch
		if sheet.waitForExistence(timeout: 5) {
			sheet.tap()
		} else {
			let both = app.buttons.matching(identifier: "Take over")
			XCTAssertGreaterThan(both.count, 1, "no take-over confirmation\n\(app.debugDescription.prefix(3000))")
			both.element(boundBy: both.count - 1).tap()
		}
		let opened = expectation(for: NSPredicate { _, _ in self.server.requested("c_impl2") }, evaluatedWith: nil)
		wait(for: [opened], timeout: 15)

		let posts = server.posts
		XCTAssertEqual(posts.map(\.path), [
			"/api/agent/runs/r_review/pause",
			"/api/agent/runs/r_review/resume",
			"/api/agent/runs/r_review/takeover"
		])
		XCTAssertEqual(posts[1].body["phase"] as? String, "implement")
	}

	/// A finished dev run with an open PR and findings left offers to fix
	/// them; the button posts fix-findings and the run shows the follow-up
	/// deck reports.
	func testFixRemainingFindingsStartsAFollowUp() {
		openRun("r_done")
		let fix = app.buttons["Fix remaining findings"]
		scrollTo(fix)
		fix.tap()
		XCTAssertTrue(app.staticTexts["follow-up"].firstMatch.waitForExistence(timeout: 10), "\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(app.staticTexts["running"].exists)
		XCTAssertFalse(app.buttons["Fix remaining findings"].exists, "a running run offers no fix")
		XCTAssertEqual(server.posts.map(\.path), ["/api/agent/runs/r_done/fix-findings"])
		XCTAssertTrue(server.posts.first?.body.isEmpty ?? false)
	}

	/// A run that is not finished never offers the fix.
	func testAnUnfinishedRunOffersNoFix() {
		openRun("r_review")
		XCTAssertTrue(app.staticTexts["PHASES"].waitForExistence(timeout: 10))
		app.collectionViews.firstMatch.swipeUp()
		XCTAssertFalse(app.buttons["Fix remaining findings"].exists)
	}

	/// deck refuses when the PR is merged; the person reads deck's reason.
	func testARefusedFixShowsDecksReason() {
		server.prMerged = true
		openRun("r_done")
		let fix = app.buttons["Fix remaining findings"]
		scrollTo(fix)
		fix.tap()
		let reason = app.alerts.staticTexts["the PR is merged, so there is nothing to push to"]
		XCTAssertTrue(reason.waitForExistence(timeout: 10), "\(app.debugDescription.prefix(3000))")
		app.alerts.buttons["OK"].tap()
		XCTAssertTrue(app.buttons["Fix remaining findings"].exists, "the run is still done and still offers the fix")
	}

	/// The overseer's session is one tap from the board.
	func testOverseerRowOpensItsSession() {
		let overseer = app.staticTexts["Overseer"].firstMatch
		XCTAssertTrue(overseer.waitForExistence(timeout: 20), "\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(app.staticTexts["watching"].exists)
		overseer.tap()
		let opened = expectation(for: NSPredicate { _, _ in self.server.requested("c_overseer") }, evaluatedWith: nil)
		wait(for: [opened], timeout: 15)
	}

	/// Deleting a run from the board asks deck, and the row goes when deck's
	/// run-deleted event arrives.
	func testDeletingARunFromTheBoard() {
		let done = row("r_done")
		XCTAssertTrue(done.waitForExistence(timeout: 20))
		done.swipeLeft()
		let delete = app.buttons["Delete"]
		XCTAssertTrue(delete.waitForExistence(timeout: 5))
		delete.tap()
		XCTAssertTrue(done.waitForNonExistence(timeout: 10), "the deleted run stayed on the board")
		XCTAssertEqual(server.deletes.map(\.path), ["/api/agent/runs/r_done"])
		XCTAssertTrue(server.posts.isEmpty)
	}

	// MARK: - Helpers

	/// The run's controls sit below its phases and findings.
	private func scrollTo(_ element: XCUIElement) {
		XCTAssertTrue(element.waitForExistence(timeout: 10))
		for _ in 0..<6 where !element.isHittable {
			app.collectionViews.firstMatch.swipeUp()
		}
	}

	private func row(_ id: String) -> XCUIElement {
		app.descendants(matching: .any).matching(identifier: "run-\(id)").firstMatch
	}

	private func openRun(_ id: String) {
		let target = row(id)
		XCTAssertTrue(target.waitForExistence(timeout: 20), "no \(id) row\n\(app.debugDescription.prefix(3000))")
		target.tap()
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
		// From a fresh launch: signing out with a session open that deck does not
		// list (as the stub's are) crashes SwiftUI, a session-screen bug of its own.
		app.terminate()
		app.launch()
		// Already signed out (nothing left to undo) when the sessions screen,
		// and so its settings button, never appears.
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
