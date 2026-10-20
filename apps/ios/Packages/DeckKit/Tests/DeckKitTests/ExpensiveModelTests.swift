import XCTest
@testable import DeckKit

final class ExpensiveModelTests: XCTestCase {
	private let list = ["fable", "sol"]

	func testKindRowsDecodeTheExpensiveFlag() throws {
		let json = #"[{"kind":"pi","available":true,"models":[{"provider":"acme","model":"big","expensive":true},{"provider":"acme","model":"small"}]}]"#
		let kinds = try JSONDecoder().decode([AgentKind].self, from: Data(json.utf8))
		XCTAssertEqual(kinds[0].models?.map(\.expensive), [true, nil])
	}

	func testDefaultsDecodeTheServerList() throws {
		let json = #"{"path":"/path/to/project","prompts":{},"kinds":{},"expensiveModels":["fable","sol"]}"#
		let defaults = try JSONDecoder().decode(ProjectStartDefaults.self, from: Data(json.utf8))
		XCTAssertEqual(defaults.expensiveModels, ["fable", "sol"])
	}

	func testDefaultsFromAnOlderServerHaveNoList() throws {
		let json = #"{"path":"/path/to/project","prompts":{},"kinds":{}}"#
		XCTAssertNil(try JSONDecoder().decode(ProjectStartDefaults.self, from: Data(json.utf8)).expensiveModels)
	}

	func testAListedModelAsksCaseInsensitivelyBySubstring() {
		XCTAssertTrue(ExpensiveModels.needsConfirm(model: "fable", list: list))
		XCTAssertTrue(ExpensiveModels.needsConfirm(model: "Claude-FABLE-5", list: list))
		XCTAssertTrue(ExpensiveModels.needsConfirm(model: "acme/sol-large", list: list))
		XCTAssertFalse(ExpensiveModels.needsConfirm(model: "sonnet", list: list))
	}

	func testTheProviderCanMatchToo() {
		XCTAssertTrue(ExpensiveModels.needsConfirm(model: "large", provider: "sol", list: list))
	}

	func testAMarkedRowAsksEvenOffTheList() {
		let rows = [KindModel(provider: "acme", model: "big", expensive: true), KindModel(provider: "acme", model: "small", expensive: nil)]
		XCTAssertTrue(ExpensiveModels.needsConfirm(model: "big", provider: "acme", list: [], rows: rows))
		XCTAssertFalse(ExpensiveModels.needsConfirm(model: "small", provider: "acme", list: [], rows: rows))
	}

	func testTheDefaultAndTheCurrentModelNeverAsk() {
		XCTAssertFalse(ExpensiveModels.needsConfirm(model: nil, list: list))
		XCTAssertFalse(ExpensiveModels.needsConfirm(model: "  ", list: list))
		XCTAssertFalse(ExpensiveModels.needsConfirm(model: "fable", current: "fable", list: list))
	}

	func testNoServerListMeansNoConfirm() {
		XCTAssertFalse(ExpensiveModels.needsConfirm(model: "fable", list: []), "the client keeps no list of its own")
	}
}
