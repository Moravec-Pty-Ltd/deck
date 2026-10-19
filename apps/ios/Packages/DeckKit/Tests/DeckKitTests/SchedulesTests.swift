import XCTest
@testable import DeckKit

/// The client side of schedules (deck#235). deck owns the clock, so there is no
/// cron walk to test here; what matters is that the digest deck serves decodes
/// whole, and that a draft's request body says what the form meant.
final class SchedulesTests: XCTestCase {
	private func decode(_ json: String) -> [DeckSchedule] {
		try! JSONDecoder().decode([DeckSchedule].self, from: Data(json.utf8))
	}

	/// The shape deck serves from GET /api/agent/schedules: one spawning
	/// schedule that has run, and one pointed at a session that has gone.
	private var served: [DeckSchedule] {
		decode(#"""
		[
			{"id":"sch_a","title":"Morning sweep","cron":"0 9 * * mon-fri",
			 "prompt":"Summarise what changed overnight.","enabled":true,
			 "cwd":"/path/to/example","projectName":"example",
			 "agent":{"kind":"claude","model":"opus"},
			 "createdAt":1000,"nextRunAt":2000,"lastRunAt":1500,
			 "lastOutcome":"ran","lastSessionId":"c_x","runs":12},
			{"id":"sch_b","title":"Hourly check","cron":"0 * * * *",
			 "prompt":"Anything new?","enabled":false,
			 "sessionId":"c_gone",
			 "createdAt":1000,"lastOutcome":"failed",
			 "lastNote":"the session this schedule sends to no longer exists","runs":3}
		]
		"""#)
	}

	func testDecodesWhatDeckServes() {
		let all = served
		XCTAssertEqual(all.map(\.id), ["sch_a", "sch_b"])
		XCTAssertEqual(all[0].runs, 12)
		XCTAssertEqual(all[0].agent?.model, "opus")
		XCTAssertEqual(all[0].lastOutcome, .ran)
		XCTAssertEqual(all[1].lastOutcome, .failed)
		XCTAssertFalse(all[1].enabled)
	}

	func testTellsTheTwoShapesApart() {
		XCTAssertFalse(served[0].isOngoing)
		XCTAssertTrue(served[1].isOngoing)
	}

	// A session target with no title is a session deck can no longer find, and
	// that is the reason the schedule stopped. The row has to say so rather than
	// render a blank.
	func testAMissingSessionReadsAsMissing() {
		XCTAssertTrue(served[1].targetMissing)
		XCTAssertEqual(served[1].targetLabel, "session no longer exists")
		XCTAssertFalse(served[0].targetMissing)
	}

	func testNamesTheProjectOrFallsBackToTheDirectory() {
		XCTAssertEqual(served[0].targetLabel, "example")
		let unregistered = decode(#"""
		[{"id":"sch_c","title":"t","cron":"0 9 * * *","prompt":"p","enabled":true,
		  "cwd":"/home/someone/notes","createdAt":0,"runs":0}]
		"""#)
		XCTAssertEqual(unregistered[0].targetLabel, "notes")
	}

	// An outcome this build has not heard of must not fail the whole list.
	func testAnUnknownOutcomeDecodesRatherThanThrowing() {
		let odd = decode(#"""
		[{"id":"sch_d","title":"t","cron":"0 9 * * *","prompt":"p","enabled":true,
		  "cwd":"/x","createdAt":0,"runs":0,"lastOutcome":"deferred"}]
		"""#)
		XCTAssertEqual(odd[0].lastOutcome, .unknown)
	}

	func testTurnsMillisecondsIntoDates() {
		XCTAssertEqual(served[0].nextRun, Date(timeIntervalSince1970: 2))
		XCTAssertEqual(served[0].lastRun, Date(timeIntervalSince1970: 1.5))
		XCTAssertNil(served[1].nextRun)
	}

	// MARK: Drafts

	func testADraftSendsBothHalvesOfTheTarget() {
		// Blank for the half this shape does not use, so moving an existing
		// schedule from one to the other clears what it used to point at. An
		// omitted key would carry the stored value instead.
		let spawning = ScheduleDraft(title: "t", cron: "0 9 * * *", prompt: "p", cwd: "/x").json
		XCTAssertEqual(spawning["cwd"] as? String, "/x")
		XCTAssertEqual(spawning["sessionId"] as? String, "")

		let ongoing = ScheduleDraft(title: "t", cron: "0 9 * * *", prompt: "p", sessionId: "c_x").json
		XCTAssertEqual(ongoing["sessionId"] as? String, "c_x")
		XCTAssertEqual(ongoing["cwd"] as? String, "")
	}

	func testADraftTrimsTheFieldsThatAreIdentifiers() {
		let json = ScheduleDraft(title: "  Morning  ", cron: " 0 9 * * * ", prompt: "p", cwd: "/x").json
		XCTAssertEqual(json["title"] as? String, "Morning")
		XCTAssertEqual(json["cron"] as? String, "0 9 * * *")
	}

	// The prompt is the one field kept verbatim: its leading indentation may be
	// deliberate, and deck trims it where it matters.
	func testADraftKeepsThePromptAsTyped() {
		let json = ScheduleDraft(cron: "0 9 * * *", prompt: "  check\n  twice  ", cwd: "/x").json
		XCTAssertEqual(json["prompt"] as? String, "  check\n  twice  ")
	}

	func testADraftRoundTripsASchedule() {
		let draft = ScheduleDraft(editing: served[0])
		XCTAssertEqual(draft.title, "Morning sweep")
		XCTAssertEqual(draft.cron, "0 9 * * mon-fri")
		XCTAssertEqual(draft.cwd, "/path/to/example")
		XCTAssertNil(draft.sessionId)
		XCTAssertEqual(draft.agent.model, "opus")
	}

	func testCompletenessWantsATargetAPromptAndAnExpression() {
		XCTAssertFalse(ScheduleDraft().isComplete, "a blank draft has no prompt and no target")
		XCTAssertFalse(ScheduleDraft(prompt: "p").isComplete, "no target")
		XCTAssertFalse(ScheduleDraft(prompt: "   ", cwd: "/x").isComplete, "a blank prompt is no prompt")
		XCTAssertFalse(ScheduleDraft(cron: " ", prompt: "p", cwd: "/x").isComplete)
		XCTAssertTrue(ScheduleDraft(prompt: "p", cwd: "/x").isComplete)
		XCTAssertTrue(ScheduleDraft(prompt: "p", sessionId: "c_x").isComplete)
	}

	// MARK: Preview

	func testThePreviewKeepsProblemAndEmptinessApart() {
		let unreadable = try! JSONDecoder().decode(
			SchedulePreview.self,
			from: Data(#"{"cron":"nope","problem":"expected 5 fields","next":[]}"#.utf8))
		XCTAssertEqual(unreadable.problem, "expected 5 fields")
		XCTAssertTrue(unreadable.dates.isEmpty)

		// Reads fine, never happens (30 February). No problem to report, and
		// still nothing to show, which is why they are separate fields.
		let impossible = try! JSONDecoder().decode(
			SchedulePreview.self,
			from: Data(#"{"cron":"0 9 30 2 *","problem":null,"next":[]}"#.utf8))
		XCTAssertNil(impossible.problem)
		XCTAssertTrue(impossible.dates.isEmpty)
	}

	func testThePreviewTurnsMillisecondsIntoDates() {
		let preview = try! JSONDecoder().decode(
			SchedulePreview.self,
			from: Data(#"{"cron":"0 9 * * *","problem":null,"next":[1000,2000]}"#.utf8))
		XCTAssertEqual(preview.dates, [Date(timeIntervalSince1970: 1), Date(timeIntervalSince1970: 2)])
	}

	// The presets are offered by both apps, so they have to be the same list and
	// every one of them has to be something deck will accept.
	func testEveryPresetIsFiveFields() {
		XCTAssertFalse(CronPreset.all.isEmpty)
		for preset in CronPreset.all {
			XCTAssertEqual(
				preset.cron.split(separator: " ").count, 5,
				"\(preset.label) is not five fields: \(preset.cron)")
		}
	}
}
