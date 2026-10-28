import XCTest
import AppKit
import UniformTypeIdentifiers
import ImageIO
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

	private func pixels(_ base64: String) throws -> (width: Int, height: Int) {
		let rep = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(Data(base64Encoded: base64))))
		return (rep.pixelsWide, rep.pixelsHigh)
	}

	/// A noisy 6000x4000 photo, the size of a 24 MP camera shot, so the JPEG is
	/// as hard to compress as a real one.
	private func photo(width: Int = 6000, height: Int = 4000) -> Data {
		let rep = NSBitmapImageRep(
			bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
			samplesPerPixel: 3, hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
		)!
		arc4random_buf(rep.bitmapData!, rep.bytesPerRow * height)
		return rep.representation(using: .png, properties: [:])!
	}

	func testLargeImagesAreScaledDownToJPEG() throws {
		let image = try XCTUnwrap(ImagePaste.image(from: photo()))
		XCTAssertEqual(image.mediaType, "image/jpeg")
		let size = try pixels(image.data)
		XCTAssertEqual(size.width, 2048)
		XCTAssertEqual(size.height, 1365, accuracy: 1)
		// Base64 is what goes in the body; the server takes 4 MB.
		XCTAssertLessThan(image.data.utf8.count, 4_000_000)
	}

	func testPortraitIsScaledByItsLongEdge() throws {
		let image = try XCTUnwrap(ImagePaste.image(from: photo(width: 1000, height: 3000)))
		let size = try pixels(image.data)
		XCTAssertEqual(size.height, 2048)
		XCTAssertEqual(size.width, 683, accuracy: 1)
	}

	/// A portrait camera shot is stored landscape with an EXIF orientation;
	/// the JPEG sent must be upright, since it no longer carries that tag.
	func testOrientationIsApplied() throws {
		let source = try XCTUnwrap(CGImageSourceCreateWithData(photo(width: 3000, height: 1000) as CFData, nil))
		let landscape = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
		let rotated = NSMutableData()
		let destination = try XCTUnwrap(CGImageDestinationCreateWithData(rotated, UTType.jpeg.identifier as CFString, 1, nil))
		CGImageDestinationAddImage(destination, landscape, [kCGImagePropertyOrientation: 6] as CFDictionary)
		XCTAssertTrue(CGImageDestinationFinalize(destination))
		let size = try pixels(XCTUnwrap(ImagePaste.image(from: rotated as Data)).data)
		XCTAssertEqual(size.height, 2048)
		XCTAssertEqual(size.width, 683, accuracy: 1)
	}

	func testImagesWithinTheLimitKeepTheirSize() throws {
		let small = photo(width: 2048, height: 100)
		let image = try XCTUnwrap(ImagePaste.image(from: small))
		XCTAssertEqual(image.mediaType, "image/png")
		XCTAssertEqual(image.data, small.base64EncodedString())
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
