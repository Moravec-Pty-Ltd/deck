import XCTest
import UIKit
import UniformTypeIdentifiers

/// Paste in the session's message field: an image attaches, text stays text,
/// and the clipboard keeps the image. Needs the demo-fixture server (a
/// session titled "long transcript").
final class ComposerPasteUITests: XCTestCase {
	override func setUp() {
		continueAfterFailure = false
	}

	func testPasteAttachesImagesAndInsertsText() throws {
		let app = try FoldableUITests.launch(environment: [:])
		app.buttons["Sessions"].firstMatch.tap()
		let row = app.staticTexts["long transcript"].firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 20))
		row.tap()
		let field = app.textViews["sessionComposer"]
		XCTAssertTrue(field.waitForExistence(timeout: 20), "\(app.debugDescription.prefix(3000))")

		// Typed JPEG data and no ready image object: how Photos and Safari copy.
		let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).jpegData(withCompressionQuality: 0.9) { context in
			UIColor.systemOrange.setFill()
			context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
		}
		UIPasteboard.general.setData(jpeg, forPasteboardType: UTType.jpeg.identifier)
		paste(into: field, app)
		let remove = app.buttons.matching(identifier: "Remove image")
		XCTAssertTrue(remove.firstMatch.waitForExistence(timeout: 10), "the image should attach\n\(app.debugDescription.prefix(3000))")
		XCTAssertTrue(UIPasteboard.general.hasImages, "the image should stay on the clipboard")

		UIPasteboard.general.string = "pasted words"
		paste(into: field, app)
		// CONTAINS: the session may hold a saved draft from an earlier test.
		let pasted = expectation(for: NSPredicate(format: "value CONTAINS %@", "pasted words"), evaluatedWith: field)
		XCTAssertEqual(XCTWaiter.wait(for: [pasted], timeout: 5), .completed, "text should paste as text, got \(String(describing: field.value))")
		XCTAssertEqual(remove.count, 1, "text should not attach anything")

		// The field is the same view after a send: it clears and keeps the keyboard.
		app.buttons["Send"].tap()
		XCTAssertTrue(remove.firstMatch.waitForNonExistence(timeout: 20), "the send should clear the draft")
		XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: NSPredicate(format: "value == ''"), evaluatedWith: field)], timeout: 5), .completed)
		XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "focus should come back after a send")
	}

	private func paste(into field: XCUIElement, _ app: XCUIApplication) {
		// Focus first: a long press on an unfocused field only focuses it.
		field.tap()
		field.press(forDuration: 1.2)
		let item = app.menuItems["Paste"]
		XCTAssertTrue(item.waitForExistence(timeout: 5), "no Paste in the edit menu\n\(app.debugDescription.prefix(3000))")
		item.tap()
	}
}
