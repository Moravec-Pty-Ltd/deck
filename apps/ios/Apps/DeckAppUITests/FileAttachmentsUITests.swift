import XCTest

/// Files a message mentions show under it: image previews that open a paged
/// gallery, and chips that open other files in Quick Look. Needs a deck
/// server with a claude session titled "file previews" whose last reply
/// mentions three images plus report.csv inside a registered project (see
/// the seeding script in the deck repo's file-preview change).
final class FileAttachmentsUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testPreviewsGalleryAndQuickLook() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = app.staticTexts["file previews"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20), "needs the seeded session\n\(app.debugDescription.prefix(3000))")
		row.tap()

		let second = app.buttons["Open tabletop.png"]
		XCTAssertTrue(second.waitForExistence(timeout: 20), "previews missing\n\(app.debugDescription.prefix(4000))")
		XCTAssertTrue(app.buttons["Open open-flat.png"].exists)
		XCTAssertTrue(app.buttons["Open report.csv"].exists)
		XCTAssertFalse(app.buttons["Open missing.png"].exists, "a file deck cannot serve stays plain text")
		attach(app, "previews")
		second.tap()

		XCTAssertTrue(app.staticTexts["2 of 3"].waitForExistence(timeout: 10), "gallery should open at the tapped image\n\(app.debugDescription.prefix(3000))")
		attach(app, "gallery")
		app.swipeLeft()
		XCTAssertTrue(app.staticTexts["3 of 3"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["tabletop-off.jpg"].exists)
		app.buttons["Close"].tap()
		XCTAssertFalse(app.staticTexts["3 of 3"].waitForExistence(timeout: 2))

		app.buttons["Open report.csv"].tap()
		// Quick Look titles the preview with the name minus its extension.
		XCTAssertTrue(app.navigationBars["report"].waitForExistence(timeout: 20), "Quick Look should show the file\n\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(app.staticTexts["value"].waitForExistence(timeout: 20), "the CSV renders as a table")
		attach(app, "quick-look")
		app.buttons["QLOverlayDoneButtonAccessibilityIdentifier"].tap()
		XCTAssertTrue(app.buttons["Open report.csv"].waitForExistence(timeout: 10))
	}

	private func attach(_ app: XCUIApplication, _ name: String) {
		let attachment = XCTAttachment(screenshot: app.screenshot())
		attachment.name = name
		attachment.lifetime = .keepAlways
		add(attachment)
	}
}
