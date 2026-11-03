import XCTest
@testable import DeckKit

final class SelectableMarkdownTests: XCTestCase {
	private func plain(_ markdown: String) -> String {
		String(SelectableMarkdown.attributed(markdown).characters)
	}

	func testInlineMarkupIsDroppedSoACopyReadsAsRendered() {
		XCTAssertEqual(plain("Run `pnpm test` in **apps/web**, see [the docs](https://example.com)."),
			"Run pnpm test in apps/web, see the docs.")
	}

	func testBlocksBecomeLinesAndListsKeepTheirMarkers() {
		let markdown = """
		# Plan

		First paragraph.

		- one
		  - nested
		1. step

		```
		let x = 1
		```

		---

		| a | b |
		|---|---|
		| 1 | 2 |
		"""
		XCTAssertEqual(plain(markdown), "Plan\n\nFirst paragraph.\n\n• one\n  • nested\n1. step\n\nlet x = 1\n\na\tb\n1\t2")
	}

	func testLinksAndCodeKeepTheirAttributes() {
		let text = SelectableMarkdown.attributed("see [docs](https://example.com) and `x`")
		XCTAssertTrue(text.runs.contains { $0.link == URL(string: "https://example.com") })
		XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent == .code && String(text[$0.range].characters) == "x" })
	}

	func testAHeadingIsBoldAndKeepsItsInlineCode() {
		let text = SelectableMarkdown.attributed("## Run `pnpm test`")
		XCTAssertTrue(text.runs.allSatisfy { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
		XCTAssertTrue(text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
	}
}
