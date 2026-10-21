import XCTest
@testable import DeckKit

final class WorkflowPickerTests: XCTestCase {
	private func decode(_ json: String) -> [WorkflowDef] {
		try! JSONDecoder().decode(WorkflowsResponse.self, from: Data(json.utf8)).workflows
	}

	/// The shape deck actually serves from GET /api/agent/workflows, including
	/// `default`, which is a keyword in Swift and so is decoded as `isDefault`.
	private var served: [WorkflowDef] {
		decode(#"""
		{"workflows":[
			{"id":"dev","name":"Dev workflow","category":"dev","default":true,"steps":[]},
			{"id":"review","name":"PR review","category":"review","default":true,"steps":[]}
		],"problems":[]}
		"""#)
	}

	func testDecodesWhatDeckServes() {
		XCTAssertEqual(served.map(\.id), ["dev", "review"])
		XCTAssertEqual(served.first?.isDefault, true)
		XCTAssertFalse(served[0].isReview)
		XCTAssertTrue(served[1].isReview)
	}

	func testAFormStartsOnTheDefaultDevWorkflow() {
		// Both are marked default, one per category; starting from an issue is
		// the common case, so dev wins.
		XCTAssertEqual(WorkflowPicker.initial(served)?.id, "dev")
	}

	func testFallsBackToAnyDevThenToAnythingAtAll() {
		let noDefault = decode(#"{"workflows":[{"id":"d","name":"D","category":"dev","steps":[]}],"problems":[]}"#)
		XCTAssertEqual(WorkflowPicker.initial(noDefault)?.id, "d")
		let reviewOnly = decode(#"{"workflows":[{"id":"r","name":"R","category":"review","steps":[]}],"problems":[]}"#)
		XCTAssertEqual(WorkflowPicker.initial(reviewOnly)?.id, "r")
		XCTAssertNil(WorkflowPicker.initial([]))
	}

	func testGroupsByCategoryForThePicker() {
		let groups = WorkflowPicker.grouped(served)
		XCTAssertEqual(groups.map(\.category), ["dev", "review"])
		XCTAssertEqual(groups.first?.workflows.map(\.id), ["dev"])
	}

	func testProblemsSurviveDecodingSoTheyCanBeShown() {
		let response = try! JSONDecoder().decode(
			WorkflowsResponse.self,
			from: Data(#"{"workflows":[],"problems":["mine.json: no steps"]}"#.utf8))
		XCTAssertEqual(response.problems, ["mine.json: no steps"])
	}
}
