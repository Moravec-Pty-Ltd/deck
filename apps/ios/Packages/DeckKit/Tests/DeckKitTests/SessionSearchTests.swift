import XCTest
@testable import DeckKit

/// The same cases as deck's `matchSessionNames` tests, because two copies of
/// one rule drift the moment nothing compares them.
final class SessionSearchTests: XCTestCase {
	private func digest(_ id: String, _ title: String?) -> SessionDigest {
		let titleJSON = title.map { "\"\($0)\"" } ?? "null"
		let json = #"{"id":"\#(id)","title":\#(titleJSON),"status":"idle"}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private var sessions: [SessionDigest] {
		[
			digest("c_1", "deck enhancements"),
			digest("c_2", "deck"),
			digest("c_3", "Auth: token refresh"),
			digest("c_4", "unrelated work"),
			digest("c_5", ""),
			digest("c_6", nil),
		]
	}

	func testFindsEveryTitleHoldingAllTheWordsInAnyOrder() {
		XCTAssertEqual(SessionSearch.byName("auth token", in: sessions).map(\.id), ["c_3"])
		XCTAssertEqual(SessionSearch.byName("token auth", in: sessions).map(\.id), ["c_3"])
	}

	func testExactTitleThenPrefixThenTheRest() {
		XCTAssertEqual(SessionSearch.byName("deck", in: sessions).map(\.id), ["c_2", "c_1"])
	}

	func testKeepsCallerOrderWithinARankSoRecencySurvives() {
		let recent = [digest("newer", "build the thing"), digest("older", "build the other thing")]
		XCTAssertEqual(SessionSearch.byName("build", in: recent).map(\.id), ["newer", "older"])
	}

	func testIgnoresCaseAndSurroundingWhitespace() {
		XCTAssertEqual(SessionSearch.byName("  AUTH  ", in: sessions).map(\.id), ["c_3"])
	}

	func testNothingForATooShortQueryOrNoMatch() {
		XCTAssertTrue(SessionSearch.byName("a", in: sessions).isEmpty)
		XCTAssertTrue(SessionSearch.byName("", in: sessions).isEmpty)
		XCTAssertTrue(SessionSearch.byName("nothing like this", in: sessions).isEmpty)
	}

	func testSkipsSessionsWithNoTitle() {
		let ids = SessionSearch.byName("deck", in: sessions).map(\.id)
		XCTAssertFalse(ids.contains("c_5"))
		XCTAssertFalse(ids.contains("c_6"))
	}

	func testRankOrdersExactThenPrefixThenWordWise() throws {
		let query = try XCTUnwrap(SessionSearch.Query("auth token"))
		XCTAssertEqual(SessionSearch.rank("Auth Token", against: query), 0)
		XCTAssertEqual(SessionSearch.rank("auth token refresh", against: query), 1)
		XCTAssertEqual(SessionSearch.rank("Refresh the token for auth", against: query), 2)
		XCTAssertNil(SessionSearch.rank("token refresh", against: query))
		XCTAssertNil(SessionSearch.rank("   ", against: query))
	}

	func testRankFindsWordsInExtraWithoutCountingItAsTheTitle() throws {
		let query = try XCTUnwrap(SessionSearch.Query("new session"))
		XCTAssertNil(SessionSearch.rank("Start", against: query))
		XCTAssertEqual(SessionSearch.rank("Start", against: query, extra: "New Session create"), 2)
		// A title match still outranks one that leans on extra.
		XCTAssertEqual(SessionSearch.rank("New session", against: query, extra: "anything"), 0)
	}

	// MARK: - Issue and PR references

	private func linked(_ id: String, _ title: String, issues: String = "[]", pr: String = "null") -> SessionDigest {
		let json = #"{"id":"\#(id)","title":"\#(title)","status":"idle","issues":\#(issues),"pr":\#(pr)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	private var linkedSessions: [SessionDigest] {
		[
			linked("byIssue", "Fix login", issues: #"[{"source":"github","id":"owner/repo#315","title":"Login redirect loops"}]"#),
			linked("byPR", "Other work", pr: #"{"repo":"owner/repo","number":315}"#),
			linked("byTitle", "Ticket 315 cleanup"),
			linked("linear", "Billing", issues: #"[{"source":"linear","id":"ENG-123"}]"#),
		]
	}

	func testRefsFindSessionsByIssueAndPRNumber() {
		for q in ["315", "#315", "owner/repo#315", "repo#315"] {
			XCTAssertEqual(Set(SessionSearch.byName(q, in: linkedSessions).map(\.id)), q == "315" ? ["byIssue", "byPR", "byTitle"] : ["byIssue", "byPR"], q)
		}
		XCTAssertEqual(SessionSearch.byName("31", in: linkedSessions).map(\.id), ["byTitle"])
	}

	func testLinearIdMatchesAnyCase() {
		XCTAssertEqual(SessionSearch.byName("eng-123", in: linkedSessions).map(\.id), ["linear"])
		XCTAssertEqual(SessionSearch.byName("ENG-123", in: linkedSessions).map(\.id), ["linear"])
	}

	func testTitleMatchRanksAboveRefOnlyMatch() {
		XCTAssertEqual(SessionSearch.byName("315", in: linkedSessions).map(\.id).first, "byTitle")
	}

	func testIssueTitleWordsMatch() {
		XCTAssertEqual(SessionSearch.byName("redirect loops", in: linkedSessions).map(\.id), ["byIssue"])
	}

	// MARK: - Issue titles

	func testTrimTitle() {
		XCTAssertEqual(DeckIssue.trimTitle("  Fix   the\n bug "), "Fix the bug")
		let sentence = "Name sessions started on an issue after the issue title and show the number separately "
		XCTAssertEqual(DeckIssue.trimTitle(sentence + sentence), "Name sessions started on an issue after the issue title and\u{2026}")
		XCTAssertEqual(DeckIssue.trimTitle("Fix " + String(repeating: "x", count: 80)), "Fix " + String(repeating: "x", count: 55) + "\u{2026}")
		// Same cut as the web: code points, so the second emoji is the one dropped.
		XCTAssertEqual(DeckIssue.trimTitle("Fix " + String(repeating: "x", count: 54) + "🔥🔥 more words"), "Fix " + String(repeating: "x", count: 54) + "🔥\u{2026}")
		let hard = DeckIssue.trimTitle(String(repeating: "x", count: 150))
		XCTAssertEqual(hard.count, 60)
		XCTAssertTrue(hard.hasSuffix("\u{2026}"))
	}

	func testSingleTitle() {
		let titled = DeckIssue(source: "github", issueId: "owner/repo#315", title: " Fix it ")
		XCTAssertEqual(DeckIssue.singleTitle([titled]), "Fix it")
		XCTAssertEqual(DeckIssue.singleTitle([DeckIssue(source: "github", issueId: "owner/repo#315")]), "#315")
		XCTAssertEqual(DeckIssue.singleTitle([DeckIssue(source: "linear", issueId: "ENG-1", title: "  ")]), "ENG-1")
		XCTAssertEqual(DeckIssue.singleTitle([]), "")
		XCTAssertEqual(DeckIssue.singleTitle([titled, titled]), "")
	}

	func testChipLabel() {
		let one = DeckIssue(source: "github", issueId: "owner/repo#315")
		XCTAssertNil(DeckIssue.chipLabel(nil))
		XCTAssertNil(DeckIssue.chipLabel([]))
		XCTAssertEqual(DeckIssue.chipLabel([one]), "#315")
		XCTAssertEqual(DeckIssue.chipLabel([one, DeckIssue(source: "linear", issueId: "ENG-1"), one]), "#315 +2")
	}
}
