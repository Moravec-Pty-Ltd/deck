import XCTest
@testable import DeckKit

/// The same cases as the web's src/lib/ansi.test.ts.
final class AnsiParserTests: XCTestCase {
	private let esc = "\u{1b}"

	private func joined(_ runs: [AnsiRun]) -> String { runs.map(\.text).joined() }

	func testUnstyledTextIsOnePlainRun() {
		let runs = AnsiParser.parse("hello world")
		XCTAssertEqual(runs.count, 1)
		XCTAssertEqual(runs[0].text, "hello world")
		XCTAssertNil(runs[0].style.foreground)
	}

	func testBasicForegroundClearsOnDefaultForeground() {
		let runs = AnsiParser.parse("\(esc)[31mred\(esc)[39m plain")
		XCTAssertEqual(runs.map(\.text), ["red", " plain"])
		XCTAssertEqual(runs[0].style.foreground, AnsiColor(red: 0xcc, green: 0, blue: 0))
		XCTAssertNil(runs[1].style.foreground)
	}

	func testFullResetClearsColoursNotJustAttributes() {
		let runs = AnsiParser.parse("\(esc)[31;44mred\(esc)[0m plain")
		XCTAssertEqual(runs.map(\.text), ["red", " plain"])
		XCTAssertEqual(runs[0].style.foreground, AnsiColor(red: 0xcc, green: 0, blue: 0))
		XCTAssertEqual(runs[0].style.background, AnsiColor(red: 0x34, green: 0x65, blue: 0xa4))
		XCTAssertNil(runs[1].style.foreground)
		XCTAssertNil(runs[1].style.background)
	}

	func testEmptySgrResetsAttributes() {
		let runs = AnsiParser.parse("\(esc)[1mbold\(esc)[mafter")
		XCTAssertTrue(runs[0].style.bold)
		XCTAssertEqual(runs[1].text, "after")
		XCTAssertFalse(runs[1].style.bold)
	}

	func test256ColourAndTruecolor() {
		let runs = AnsiParser.parse("\(esc)[38;5;196mx\(esc)[38;2;10;20;30my")
		XCTAssertEqual(runs[0].style.foreground, AnsiColor(red: 255, green: 0, blue: 0))
		XCTAssertEqual(runs[1].style.foreground, AnsiColor(red: 10, green: 20, blue: 30))
	}

	func testInverseTurnsOnAndOff() {
		let runs = AnsiParser.parse("\(esc)[7minv\(esc)[27mnorm")
		XCTAssertTrue(runs[0].style.inverse)
		XCTAssertFalse(runs[1].style.inverse)
	}

	func testOscHyperlinkIsStrippedWithoutLeaking() {
		let osc = "\(esc)]8;;https://example.com\(esc)\\link\(esc)]8;;\(esc)\\"
		let text = joined(AnsiParser.parse("before \(osc) after"))
		XCTAssertTrue(text.contains("link"))
		XCTAssertFalse(text.contains(esc))
		XCTAssertFalse(text.contains("example.com"))
	}

	func testBellTerminatedOscTitleIsStripped() {
		XCTAssertEqual(joined(AnsiParser.parse("a\(esc)]0;window title\u{07}b")), "ab")
	}

	func testCursorMovesAreDropped() {
		let text = joined(AnsiParser.parse("one\(esc)[2Atwo\(esc)[Kthree"))
		XCTAssertEqual(text, "onetwothree")
		XCTAssertFalse(text.contains(esc))
	}

	func testBracketedPasteMarkersAreDropped() {
		let text = joined(AnsiParser.parse("a\(esc)[200~paste\(esc)[201~b"))
		XCTAssertEqual(text, "apasteb")
		XCTAssertFalse(text.contains("~"))
	}

	func testPrivateModeTogglesAreDropped() {
		XCTAssertEqual(joined(AnsiParser.parse("x\(esc)[?2004hy\(esc)[?25lz")), "xyz")
	}

	func testStylingSurvivesAStrippedEscape() {
		let runs = AnsiParser.parse("\(esc)[32ma\(esc)[Kb")
		XCTAssertTrue(runs.allSatisfy { $0.style.foreground == AnsiColor(red: 0x4e, green: 0x9a, blue: 0x06) })
		XCTAssertEqual(joined(runs), "ab")
	}

	func testEmptyInputHasNoRuns() {
		XCTAssertEqual(AnsiParser.parse(""), [])
	}

	// Beyond the web's cases: things only the Swift scanner could get wrong.

	func testTextBeforeAnSgrKeepsTheEarlierStyle() {
		let runs = AnsiParser.parse("plain\(esc)[31mred")
		XCTAssertNil(runs[0].style.foreground)
		XCTAssertEqual(runs[1].style.foreground, AnsiColor(red: 0xcc, green: 0, blue: 0))
	}

	func testATruncatedEscapeIsStripped() {
		XCTAssertEqual(joined(AnsiParser.parse("tail\(esc)[38;5")), "tail")
	}

	func testNonAsciiTextSurvives() {
		XCTAssertEqual(joined(AnsiParser.parse("\(esc)[1m✓ done\(esc)[0m é")), "✓ done é")
	}
}

final class TerminalKeyTests: XCTestCase {
	func testOnlyTheServersKeysCanBeBuilt() {
		XCTAssertEqual(TerminalKey(name: "Enter"), .enter)
		XCTAssertEqual(TerminalKey(name: "C-c"), TerminalKey.control("c"))
		XCTAssertEqual(TerminalKey.control("D")?.name, "C-d")
		XCTAssertNil(TerminalKey(name: "C-1"))
		XCTAssertNil(TerminalKey(name: "M-x"))
		XCTAssertNil(TerminalKey(name: "enter"))
		XCTAssertNil(TerminalKey.control("é"))
		XCTAssertEqual(TerminalKey.named.map(\.name), [
			"Enter", "Escape", "Tab", "BTab", "BSpace", "DC", "Space", "Up", "Down",
			"Left", "Right", "Home", "End", "PPage", "NPage"
		])
	}
}
