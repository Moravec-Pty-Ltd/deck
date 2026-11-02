import XCTest
@testable import DeckKit

final class DeleteWarningTests: XCTestCase {
	private func digest(_ id: String, _ status: String, awaiting: Bool = false) -> SessionDigest {
		let json = #"{"id":"\#(id)","title":"\#(id)","status":"\#(status)","awaitingInput":\#(awaiting)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	func testCountsOnlySessionsMidTurn() {
		let list = [digest("a", "running"), digest("b", "idle"), digest("c", "running", awaiting: true)]
		XCTAssertEqual(DeleteWarning.running(list).map(\.id), ["a"])
	}

	func testIdleConfirmUnchanged() {
		XCTAssertNil(DeleteWarning.message([digest("a", "idle")]))
		XCTAssertNil(DeleteWarning.message([digest("a", "running", awaiting: true)]))
		XCTAssertEqual(DeleteWarning.buttonLabel([digest("a", "idle")], plain: "Delete"), "Delete")
	}

	func testOneRunningSession() {
		let one = [digest("a", "running")]
		XCTAssertEqual(DeleteWarning.message(one), "This session is still working. Deleting it stops the current turn and any subagents, and the work in progress is lost.")
		XCTAssertEqual(DeleteWarning.buttonLabel(one, plain: "Delete"), "Stop and Delete")
	}

	func testBatchNamesHowManyAndWhich() {
		let list = [digest("a", "running"), digest("b", "idle"), digest("c", "running")]
		XCTAssertEqual(DeleteWarning.message(list), "2 of these sessions are still working: a, c.")
		XCTAssertEqual(DeleteWarning.message([digest("a", "running"), digest("b", "idle")]), "1 of these sessions is still working: a.")
		XCTAssertEqual(DeleteWarning.buttonLabel(list, plain: "Delete"), "Stop and Delete 3 Sessions")
	}
}
