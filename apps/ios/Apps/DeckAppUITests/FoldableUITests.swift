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

		let title = app.buttons["renameSession"]
		XCTAssertTrue(title.waitForExistence(timeout: 20))
		XCTAssertEqual(title.label, "Stream token diff renderer")
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

	/// Opened flat, dragging the divider resizes the list within its limits,
	/// a popover stays in the session's pane, and letting go near the fold
	/// snaps back to it. An iPad told it is open flat stands in for the Duo,
	/// whose simulator may boot folded.
	func testDraggingTheDividerResizesTheList() throws {
		guard Self.isFoldable || UIDevice.current.userInterfaceIdiom == .pad else {
			throw XCTSkip("opened flat needs the iPhone Duo or an iPad simulator")
		}
		let app = try Self.launch(environment: ["DECK_HINGE": "fullyOpen"])
		let window = app.windows.firstMatch.frame
		guard window.width > 700 else { throw XCTSkip("the simulator booted folded") }
		let listEdge = { Self.listEdge(in: app) }
		let drag = { (x: CGFloat) in Self.dragDivider(to: x, in: app) }
		// The width is kept, so a run that failed part way must not shift the other tests.
		addTeardownBlock {
			if app.navigationBars["Sessions"].exists, abs(Self.listEdge(in: app) - window.midX) > 2 { Self.dragDivider(to: window.midX, in: app) }
		}

		app.buttons["Sessions"].firstMatch.tap()
		let row = Self.listItem("Stream token diff renderer", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		if abs(listEdge() - window.midX) > 2 { drag(window.midX) }
		XCTAssertEqual(listEdge(), window.midX, accuracy: 2, "the list starts on the fold")
		row.tap()
		XCTAssertTrue(app.buttons["renameSession"].waitForExistence(timeout: 20))

		drag(window.midX - 120)
		XCTAssertEqual(listEdge(), window.midX - 120, accuracy: 4, "the list narrows with the drag")
		drag(window.minX + 40)
		XCTAssertEqual(listEdge() - window.minX, 260, accuracy: 2, "the list stops at its minimum")
		drag(window.maxX - 120)
		XCTAssertEqual(listEdge() - window.minX, window.width * 0.6, accuracy: 2, "the list stops at its maximum")

		app.buttons["renameSession"].tap()
		let rename = app.navigationBars["Rename session"]
		XCTAssertTrue(rename.waitForExistence(timeout: 5), "rename did not open\n\(app.debugDescription.prefix(3000))")
		XCTAssertGreaterThanOrEqual(rename.frame.minX, listEdge(), "rename sits in the session's pane")
		attach(app, "divider-widest-rename")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(rename.waitForNonExistence(timeout: 5))

		drag(window.midX - 15)
		XCTAssertEqual(listEdge(), window.midX, accuracy: 2, "let go near the fold, the divider snaps to it")
	}

	private static func listEdge(in app: XCUIApplication) -> CGFloat {
		app.navigationBars["Sessions"].firstMatch.frame.maxX
	}

	/// To a point inside the window: past either limit, but never off screen.
	private static func dragDivider(to x: CGFloat, in app: XCUIApplication) {
		let divider = app.descendants(matching: .any).matching(identifier: "foldDivider").firstMatch
		XCTAssertTrue(divider.waitForExistence(timeout: 5), "no divider\n\(app.debugDescription.prefix(3000))")
		let start = divider.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
		start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: x - divider.frame.midX, dy: 0)))
		sleep(1)
	}

	/// Two sessions side by side each fill their half of the fold, with their
	/// own header, close button and composer, all clear of the tab rail.
	func testTwoSessionsSplitOnTheFold() throws {
		guard Self.isFoldable else { throw XCTSkip("opened flat needs the iPhone Duo simulator") }
		let app = try Self.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = Self.listItem("Stream token diff renderer", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()
		XCTAssertTrue(app.buttons["renameSession"].waitForExistence(timeout: 20))
		Self.listItem("Yolo badge in session header", in: app).press(forDuration: 1)
		app.buttons["Open beside"].tap()
		let closes = app.buttons.matching(identifier: "closePane")
		XCTAssertTrue(closes.element(boundBy: 1).waitForExistence(timeout: 20), "no second session\n\(app.debugDescription.prefix(3000))")
		sleep(2)
		attach(app, "two-up")

		let window = app.windows.firstMatch.frame
		let rail = app.buttons["Inbox"].firstMatch.frame.minX
		let frames = { (id: String, type: XCUIElement.ElementType) in
			app.descendants(matching: type).matching(identifier: id).allElementsBoundByIndex.map(\.frame).sorted { $0.minX < $1.minX }
		}
		let close = frames("closePane", .button), composers = frames("sessionComposer", .textView), transcripts = frames("transcript", .scrollView)
		let found = "window \(window) rail \(rail) close \(close) composers \(composers) transcripts \(transcripts)"
		XCTAssertEqual(close.count, 2, found)
		XCTAssertEqual(composers.count, 2, found)
		XCTAssertEqual(transcripts.count, 2, found)
		XCTAssertLessThan(close[0].maxX, window.midX, "the left pane closes from its own header: \(found)")
		XCTAssertGreaterThan(close[1].minX, window.midX, "the right pane closes from its own header: \(found)")
		XCTAssertEqual(transcripts[0].maxX, window.midX, accuracy: 2, "the left pane reaches the fold: \(found)")
		XCTAssertEqual(transcripts[1].minX, window.midX, accuracy: 2, "the right pane starts at the fold: \(found)")
		XCTAssertLessThanOrEqual(transcripts[1].maxX, rail, "the right pane stays clear of the rail: \(found)")
		XCTAssertGreaterThan(composers[0].maxX, window.midX - 40, "the left composer reaches the fold: \(found)")
		XCTAssertLessThanOrEqual(composers[1].maxX, rail, "the right composer stays clear of the rail: \(found)")
	}

	/// Both of the foldable's displays are short, so the session's title band
	/// and the composer's second row give their height to the conversation:
	/// one header line with the title, the browser and the menu, a finished PR
	/// as a badge in it, and a composer whose controls stand in a column,
	/// cut to Send and More while typing. The list's title is inline.
	func testShortWindowUsesOneHeaderLineAndAOneRowComposer() throws {
		guard Self.isFoldable else { throw XCTSkip("a short window needs the iPhone Duo simulator") }
		let app = try Self.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let window = app.windows.firstMatch.frame
		let openFlat = window.width > window.height
		let list = app.navigationBars["Sessions"]
		XCTAssertTrue(list.waitForExistence(timeout: 20))
		XCTAssertEqual(list.staticTexts["Sessions"].frame.midY, list.buttons["Select"].frame.midY, accuracy: 8,
			"the list's title is inline, beside its toolbar")

		Self.listItem("Stream token diff renderer", in: app).tap()
		let title = app.buttons["renameSession"]
		XCTAssertTrue(title.waitForExistence(timeout: 20), "no header line\n\(app.debugDescription.prefix(3000))")
		XCTAssertFalse(app.navigationBars["Stream token diff renderer"].exists, "no title band")
		XCTAssertFalse(app.buttons["sessionBack"].exists, "the rail's Sessions tab goes back, not a chevron")
		for control in ["renameSession", "openBrowser", "sessionMenu"] {
			let button = app.buttons[control]
			XCTAssertTrue(button.isHittable, "\(control) is reachable")
			XCTAssertEqual(button.frame.midY, title.frame.midY, accuracy: 12, "\(control) shares the title's line")
			XCTAssertGreaterThanOrEqual(button.frame.height, 44, "\(control) has a full tap target")
		}
		let field = app.textViews["sessionComposer"]
		XCTAssertTrue(field.waitForExistence(timeout: 20), "the session is still loading")
		let row = app.buttons["prRow"]
		XCTAssertTrue(row.waitForExistence(timeout: 10), "an open PR keeps its row")
		let send = app.buttons["Send"]
		let photos = app.buttons["Attach photos"]
		XCTAssertTrue(photos.exists)
		XCTAssertGreaterThan(send.frame.minY, photos.frame.maxY, "Send sits under the column of controls")
		XCTAssertGreaterThan(send.frame.minX, field.frame.maxX, "the column stands right of the message")
		XCTAssertEqual(photos.frame.midX, send.frame.midX, accuracy: 1.5, "the column's controls centre on Send")
		XCTAssertEqual(field.frame.midY, send.frame.midY, accuracy: 1.5, "the message line centres on Send")
		attach(app, "short-session")

		field.tap()
		field.typeText("One line")
		let more = app.buttons["composerMore"]
		XCTAssertTrue(more.waitForExistence(timeout: 5), "typing cuts the column to Send and More")
		XCTAssertFalse(photos.exists)
		XCTAssertEqual(send.frame.midY, field.frame.midY, accuracy: 1.5, "a one-line message centres on Send")
		XCTAssertEqual(more.frame.midY, send.frame.midY, accuracy: 1.5)
		XCTAssertTrue(row.waitForNonExistence(timeout: 5), "the PR row steps aside while typing")
		attach(app, "short-typing")
		let line = field.frame.height
		field.typeText("\nTwo\nThree")
		XCTAssertGreaterThan(field.frame.height, line * 2.5, "the field grows to three lines")
		XCTAssertEqual(more.frame.midY, send.frame.midY, accuracy: 1.5, "More and Send stay centred on each other")
		XCTAssertEqual(send.frame.midY, field.frame.maxY - line / 2, accuracy: 1.5, "Send stays on the last line")
		attach(app, "short-typing-three-lines")
		// Cleared, or the draft follows into the next session and the tests after.
		field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count))
		XCTAssertEqual(field.value as? String ?? "", "", "the draft is cleared")

		more.tap()
		XCTAssertTrue(app.buttons["Attach photos"].waitForExistence(timeout: 5), "More offers the photos")
		XCTAssertTrue(app.buttons["Quick messages"].exists, "and the quick messages")
		// The first tap may only close the menu; the transcript's top is clear of it.
		let transcript = app.scrollViews["transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15))
		transcript.tap()
		if !row.waitForExistence(timeout: 3) { transcript.tap() }
		XCTAssertTrue(row.waitForExistence(timeout: 5), "the PR row comes back once typing stops")

		title.tap()
		let rename = app.navigationBars["Rename session"]
		XCTAssertTrue(rename.waitForExistence(timeout: 5), "the title still renames")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(rename.waitForNonExistence(timeout: 5))

		if !openFlat {
			let edge = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5)).withOffset(CGVector(dx: 2, dy: 0))
			edge.press(forDuration: 0.05, thenDragTo: edge.withOffset(CGVector(dx: window.width * 0.7, dy: 0)))
			XCTAssertTrue(list.waitForExistence(timeout: 5), "the edge swipe goes back to the list")
			Self.listItem("Stream token diff renderer", in: app).tap()
			XCTAssertTrue(app.buttons["renameSession"].waitForExistence(timeout: 20))
			app.buttons["Sessions"].firstMatch.tap()
			XCTAssertTrue(list.waitForExistence(timeout: 5), "the rail's Sessions tab goes back to the list")
		}
		Self.listItem("merged pr", in: app).tap()
		let badge = app.staticTexts["prBadge"]
		XCTAssertTrue(badge.waitForExistence(timeout: 20), "a merged PR is a badge in the header line\n\(app.debugDescription.prefix(3000))")
		XCTAssertEqual(badge.label, "Merged")
		XCTAssertEqual(badge.frame.midY, app.buttons["renameSession"].frame.midY, accuracy: 12)
		XCTAssertFalse(app.buttons["prRow"].exists, "with no row of its own")
		attach(app, "short-merged")
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

	/// Unfolding moves the open session from over the list to beside it, and
	/// folding moves it back; both keep the reader's place and a whole layout.
	/// No simulator folds, so an iPad stands in, folded and unfolded by the
	/// notifications DECK_HINGE=switchable listens for: closed, it lays out
	/// compact like the outer display. The draft is left out: an iPad forced
	/// compact with text in the composer never settles its layout, which says
	/// nothing about a phone.
	func testFoldAndUnfoldKeepTheSessionInPlace() throws {
		guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("needs a window that is regular when unfolded: an iPad simulator") }
		let app = try Self.launch(environment: ["DECK_HINGE": "switchable"])
		let fold = { Self.post("deck.hinge.closed") }
		let unfold = { Self.post("deck.hinge.fullyOpen") }
		app.buttons["Sessions"].firstMatch.tap()
		let row = Self.listItem("long transcript", in: app)
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the seeded session")
		row.tap()
		let latest = app.staticTexts["Reply 60, the latest message."]
		XCTAssertTrue(latest.waitForExistence(timeout: 20))
		XCTAssertFalse(app.navigationBars["Sessions"].exists, "starts folded, the session pushed over the list")
		for _ in 0..<4 { app.scrollViews["transcript"].swipeDown() }
		sleep(2)
		XCTAssertTrue(app.buttons["Jump to latest"].exists, "scrolled away from the end")
		let top = try XCTUnwrap(Self.topRow(in: app), "no message on screen\n\(app.debugDescription.prefix(3000))")
		unfold()
		XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 10), "unfolded, the list sits beside the session")
		sleep(2)
		assertWholeLayout(app, "unfolded")
		assertAtTop(top, in: app, "unfolding")
		attach(app, "unfolded-middle")

		fold()
		XCTAssertTrue(app.navigationBars["long transcript"].waitForExistence(timeout: 10), "folded, the session stays open\n\(app.debugDescription.prefix(3000))")
		XCTAssertFalse(app.navigationBars["Sessions"].exists, "folded, the session is pushed over the list")
		sleep(2)
		assertWholeLayout(app, "folded")
		assertAtTop(top, in: app, "folding")

		// Swiped rather than the jump button, which misses on an iPad.
		for _ in 0..<12 where !app.buttons["Jump to latest"].waitForNonExistence(timeout: 1) {
			app.scrollViews["transcript"].swipeUp()
		}
		XCTAssertTrue(latest.isHittable, "back at the end")
		unfold()
		XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 10))
		sleep(2)
		XCTAssertTrue(latest.isHittable, "at the end, unfolding stays at the end")
		assertWholeLayout(app, "unfolded at the end")

		fold()
		XCTAssertTrue(app.navigationBars["long transcript"].waitForExistence(timeout: 10))
		sleep(2)
		XCTAssertTrue(latest.isHittable, "at the end, folding stays at the end")
		app.navigationBars["long transcript"].buttons["Sessions"].tap()
		XCTAssertTrue(app.navigationBars["Sessions"].waitForExistence(timeout: 5), "Back goes to the list")
	}

	/// The composer at the foot of the window and the transcript filling the
	/// space above it, rather than squeezed to nothing under the title.
	private func assertWholeLayout(_ app: XCUIApplication, _ posture: String, file: StaticString = #filePath, line: UInt = #line) {
		let window = app.windows.firstMatch.frame
		let composer = app.textViews["sessionComposer"]
		let transcript = app.scrollViews["transcript"].frame
		XCTAssertTrue(composer.exists, "\(posture): no composer", file: file, line: line)
		XCTAssertGreaterThan(composer.frame.minY, window.midY, "\(posture): the composer sits at the bottom", file: file, line: line)
		XCTAssertGreaterThan(transcript.height, window.height / 3, "\(posture): the transcript fills the pane", file: file, line: line)
		let pane = app.navigationBars["Sessions"].exists ? window.width / 2 : window.width
		XCTAssertGreaterThan(transcript.width, pane - 40, "\(posture): the transcript spans its pane", file: file, line: line)
		XCTAssertLessThanOrEqual(transcript.maxY, composer.frame.minY + 1, "\(posture): the transcript sits above the composer", file: file, line: line)
	}

	/// The transcript's visible band: under the title, above the composer.
	private static func band(in app: XCUIApplication) -> ClosedRange<CGFloat> {
		app.buttons["renameSession"].frame.maxY...app.textViews["sessionComposer"].frame.minY
	}

	private static func messages(in app: XCUIApplication) -> XCUIElementQuery {
		app.scrollViews["transcript"].staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Step ' OR label BEGINSWITH 'Reply '"))
	}

	/// The first message showing in the transcript's band.
	private static func topRow(in app: XCUIApplication) -> String? {
		let band = band(in: app)
		return messages(in: app).allElementsBoundByIndex
			.filter { $0.frame.maxY > band.lowerBound + 30 && $0.frame.minY < band.upperBound }
			.min { $0.frame.minY < $1.frame.minY }?.label
	}

	/// The message that led the band before the change still shows near its top.
	private func assertAtTop(_ label: String, in app: XCUIApplication, _ change: String, file: StaticString = #filePath, line: UInt = #line) {
		let band = Self.band(in: app)
		let row = Self.messages(in: app).matching(NSPredicate(format: "label == %@", label)).firstMatch
		XCTAssertTrue(row.exists, "\(change): the top message is gone", file: file, line: line)
		XCTAssertGreaterThan(row.frame.minY, band.lowerBound - 40, "\(change): the top message is pushed up off the screen", file: file, line: line)
		XCTAssertLessThan(row.frame.minY, band.lowerBound + (band.upperBound - band.lowerBound) / 3,
			"\(change): the top message should lead the transcript, at \(row.frame) in \(band)", file: file, line: line)
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

	/// A Darwin notification, which reaches the app across processes.
	private static func post(_ name: String) {
		CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
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
