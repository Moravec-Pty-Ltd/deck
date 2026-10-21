import XCTest
@testable import DeckKit

/// The same cases as deck's file-browser-core tests.
final class FileBrowserTests: XCTestCase {
	func testTucksDotfilesAndGeneratedFolders() {
		XCTAssertTrue(FileBrowser.isTucked(DirEntry(name: ".env", dir: false)))
		XCTAssertTrue(FileBrowser.isTucked(DirEntry(name: ".git", dir: true)))
		XCTAssertTrue(FileBrowser.isTucked(DirEntry(name: "node_modules", dir: true)))
		XCTAssertTrue(FileBrowser.isTucked(DirEntry(name: "build", dir: true)))
	}

	func testKeepsOrdinaryEntriesIncludingAFileNamedLikeANoiseFolder() {
		XCTAssertFalse(FileBrowser.isTucked(DirEntry(name: "src", dir: true)))
		XCTAssertFalse(FileBrowser.isTucked(DirEntry(name: "README.md", dir: false)))
		XCTAssertFalse(FileBrowser.isTucked(DirEntry(name: "build", dir: false)))
	}

	func testFlagsEnvFilesKeysAndCredentialFiles() {
		for n in [".env", ".env.local", ".env.production", "prod.env", "server.pem", "tls.key", "id_ed25519", "credentials.json", "secrets.yaml", ".npmrc"] {
			XCTAssertTrue(FileBrowser.isSecretName(n), n)
		}
	}

	func testLeavesTemplatesAndOrdinaryFilesAlone() {
		for n in [".env.example", ".env.sample", ".env.template", "README.md", "id_ed25519.pub", "environment.ts", "keys.ts"] {
			XCTAssertFalse(FileBrowser.isSecretName(n), n)
		}
	}

	func testBuildsCrumbsFromTheSessionFolder() {
		let crumbs = FileBrowser.crumbs(root: "/path/to/project", path: "src/lib")
		XCTAssertEqual(crumbs.map(\.label), ["project", "src", "lib"])
		XCTAssertEqual(crumbs.map(\.path), ["", "src", "src/lib"])
	}

	func testAnEntryOpensByItsAbsolutePath() throws {
		let json = #"{"path":"docs","root":"/path/to/project","entries":[{"name":"clip.MOV","dir":false,"size":3,"mtimeMs":1.5}],"truncated":false}"#
		let listing = try JSONDecoder().decode(DirListing.self, from: Data(json.utf8))
		let file = listing.file(listing.entries[0])
		XCTAssertEqual(file.path, "/path/to/project/docs/clip.MOV")
		XCTAssertTrue(file.isVideo)
		XCTAssertFalse(file.image)
	}
}
