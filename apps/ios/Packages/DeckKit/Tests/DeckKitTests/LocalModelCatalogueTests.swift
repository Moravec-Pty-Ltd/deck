import XCTest
@testable import DeckLocalModel

/// The shortlist deck offers and the validator for a typed repo id (deck#239).
/// Pure: no MLX is loaded and nothing is downloaded.
final class LocalModelCatalogueTests: XCTestCase {
	func testTheShortlistIsOrderedSmallestFirst() {
		let sizes = LocalModelCatalogue.suggested.map(\.weightsBytes)
		XCTAssertEqual(sizes, sizes.sorted(), "the list is read as a size ladder, so it has to be in size order")
		XCTAssertFalse(LocalModelCatalogue.suggested.isEmpty)
	}

	func testTheSuggestedModelIsOnTheShortlist() {
		XCTAssertNotNil(
			LocalModelCatalogue.suggestedOption,
			"the default has to be one of the options, or choosing it would show nothing")
		XCTAssertEqual(LocalModelCatalogue.suggestedOption?.id, LocalModelCatalogue.suggestedId)
	}

	// Every entry is a repo id the download will be handed, so each one has to
	// pass the same check a typed id does. A typo here would ship broken.
	func testEveryShortlistEntryIsAUsableRepoId() {
		for option in LocalModelCatalogue.suggested {
			XCTAssertNil(LocalModelCatalogue.repoProblem(option.id), "\(option.id) is not a usable repo id")
			XCTAssertTrue(option.id.contains("/"), "\(option.id) should be owner/name")
			XCTAssertFalse(option.name.isEmpty)
			XCTAssertFalse(option.note.isEmpty, "\(option.id) needs a line saying when to pick it")
		}
	}

	func testSizesReadAsGigabytesOrMegabytes() {
		XCTAssertEqual(LocalModelOption(id: "a/b", name: "n", weightsBytes: 1_720_000_000, note: "x").size, "1.7 GB")
		XCTAssertEqual(LocalModelOption(id: "a/b", name: "n", weightsBytes: 970_000_000, note: "x").size, "970 MB")
		XCTAssertEqual(LocalModelOption(id: "a/b", name: "n", weightsBytes: 340_000_000, note: "x").size, "340 MB")
	}

	func testNamesAModelItHasAnEntryFor() {
		XCTAssertEqual(LocalModelCatalogue.displayName(for: LocalModelCatalogue.suggestedId), "Qwen3.5 2B")
	}

	// A hand-typed model still has to read as something in a list, and the repo
	// name is what tells one from another.
	func testNamesATypedModelByItsRepoName() {
		XCTAssertEqual(LocalModelCatalogue.displayName(for: "someone/My-Tuned-Qwen-4bit"), "My-Tuned-Qwen-4bit")
		XCTAssertEqual(LocalModelCatalogue.displayName(for: "nameless"), "nameless")
	}

	func testAcceptsARepoIdThatLooksRight() {
		XCTAssertNil(LocalModelCatalogue.repoProblem("mlx-community/Qwen3.5-2B-4bit"))
		XCTAssertNil(LocalModelCatalogue.repoProblem("someone/model_v2.1"))
		// Trimmed, because a pasted id arrives with whitespace around it.
		XCTAssertNil(LocalModelCatalogue.repoProblem("  mlx-community/Qwen3-4B-4bit \n"))
	}

	func testExplainsWhatIsWrongRatherThanJustRefusing() {
		XCTAssertEqual(
			LocalModelCatalogue.repoProblem(""),
			"Enter a Hugging Face repo, like mlx-community/Qwen3.5-2B-4bit.")
		XCTAssertEqual(
			LocalModelCatalogue.repoProblem("Qwen3.5-2B-4bit"),
			"That needs to be owner/name, like mlx-community/Qwen3.5-2B-4bit.")
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("a/b/c"), "three parts is not owner/name")
	}

	// The id becomes a directory under the model cache, so anything that could
	// climb out of it has to be refused here.
	func testRefusesAnIdThatCouldReachOutsideTheCache() {
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("../etc/passwd"))
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("owner/.."))
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("owner/~root"))
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("owner/a b"))
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("owner/"))
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("/name"))
		// A leading dot or dash would be a hidden file or read as a flag.
		XCTAssertNotNil(LocalModelCatalogue.repoProblem("owner/-model"))
		XCTAssertNotNil(LocalModelCatalogue.repoProblem(".owner/model"))
	}

	func testNormaliseTrimsAndLeavesCaseAlone() {
		// Hugging Face repo names are case-sensitive, so lowercasing would turn
		// a working id into a 404.
		XCTAssertEqual(LocalModelCatalogue.normalise("  mlx-community/Qwen3.5-2B-4bit  "), "mlx-community/Qwen3.5-2B-4bit")
	}
}
