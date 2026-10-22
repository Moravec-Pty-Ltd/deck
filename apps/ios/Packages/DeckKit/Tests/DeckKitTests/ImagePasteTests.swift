import XCTest
import AppKit
import UniformTypeIdentifiers
import DeckUI

final class ImagePasteTests: XCTestCase {
	private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])
	private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])

	private func tiff() -> Data {
		let image = NSImage(size: NSSize(width: 4, height: 4))
		image.lockFocus()
		NSColor.red.setFill()
		NSRect(x: 0, y: 0, width: 4, height: 4).fill()
		image.unlockFocus()
		return image.tiffRepresentation!
	}

	func testPNGAndJPEGGoAsTheyAre() {
		XCTAssertEqual(ImagePaste.image(from: png)?.mediaType, "image/png")
		XCTAssertEqual(ImagePaste.image(from: png)?.data, png.base64EncodedString())
		XCTAssertEqual(ImagePaste.image(from: jpeg)?.mediaType, "image/jpeg")
	}

	func testOtherFormatsAreReencodedAsPNG() throws {
		let image = try XCTUnwrap(ImagePaste.image(from: tiff()))
		XCTAssertEqual(image.mediaType, "image/png")
		XCTAssertTrue(try XCTUnwrap(Data(base64Encoded: image.data)).starts(with: png.prefix(4)))
	}

	func testUnreadableDataIsNil() {
		XCTAssertNil(ImagePaste.image(from: Data()))
		XCTAssertNil(ImagePaste.image(from: Data("not an image".utf8)))
	}

	/// The common clipboard shape: a typed file, no ready image object.
	func testProviderOfferingAFileIsRead() async throws {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".tiff")
		try tiff().write(to: url)
		defer { try? FileManager.default.removeItem(at: url) }
		let provider = NSItemProvider()
		provider.registerFileRepresentation(forTypeIdentifier: UTType.tiff.identifier, visibility: .all) { done in
			done(url, false, nil)
			return nil
		}
		XCTAssertTrue(ImagePaste.hasImage(provider))
		let image = await ImagePaste.image(from: provider)
		XCTAssertEqual(image?.mediaType, "image/png")
	}

	func testProviderOfferingTypedDataIsRead() async {
		let provider = NSItemProvider(item: jpeg as NSData, typeIdentifier: UTType.jpeg.identifier)
		let image = await ImagePaste.image(from: provider)
		XCTAssertEqual(image?.mediaType, "image/jpeg")
	}

	func testTextIsNotAnImage() async {
		let provider = NSItemProvider(object: "hello" as NSString)
		XCTAssertFalse(ImagePaste.hasImage(provider))
		let image = await ImagePaste.image(from: provider)
		XCTAssertNil(image)
	}
}
