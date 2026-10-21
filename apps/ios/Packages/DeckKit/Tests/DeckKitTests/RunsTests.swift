import XCTest
@testable import DeckKit

/// Serves canned replies by path (or by "METHOD path", which wins) and records
/// what was asked, so a test can check the client posts actions and draws what
/// comes back.
private final class RunStub: URLProtocol {
	typealias Request = (method: String, path: String, query: String?, auth: String?, body: [String: Any])
	nonisolated(unsafe) static var replies: [String: (Int, String)] = [:]
	nonisolated(unsafe) static var requests: [Request] = []

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		let path = request.url!.path
		let method = request.httpMethod ?? "GET"
		var data = request.httpBody ?? Data()
		if let stream = request.httpBodyStream {
			stream.open()
			defer { stream.close() }
			var buffer = [UInt8](repeating: 0, count: 4096)
			while stream.hasBytesAvailable {
				let count = stream.read(&buffer, maxLength: buffer.count)
				if count <= 0 { break }
				data.append(contentsOf: buffer.prefix(count))
			}
		}
		let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
		Self.requests.append((method, path, request.url!.query, request.value(forHTTPHeaderField: "Authorization"), body))
		let (status, reply) = Self.replies["\(method) \(path)"] ?? Self.replies[path] ?? (404, #"{"message":"no stub"}"#)
		client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: Data(reply.utf8))
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}

/// The digest as deck's llms.txt documents it, every field filled.
private func digest(id: String = "r_1", status: String = "blocked", phase: String = "review", updatedAt: Int = 2000, block: Bool = true) -> String {
	"""
	{ "id": "\(id)", "url": "http://deck.test/runs/\(id)",
	  "workflow": { "id": "dev", "name": "Dev workflow", "category": "dev" },
	  "title": "#7", "projectPath": "/code/proj", "cwd": "/code/proj-wt", "branch": "jin/proj-7", "base": "main",
	  "issue": { "source": "github", "id": "owner/repo#7", "url": "https://github.com/owner/repo/issues/7" },
	  "pr": { "repo": "owner/repo", "number": 9, "url": "https://github.com/owner/repo/pull/9", "title": "Fix", "baseRefName": "main" },
	  "status": "\(status)", "phase": "\(phase)", "round": 2, "cap": 5, "loop": true, "blockers": 1,
	  "findings": [{ "file": "src/a.ts", "line": 3, "severity": "blocker", "defect": "d", "fix": "f", "keep": "k" }],
	  "escalations": { "implementer": false, "disagreement": true, "cap": false },
	  "humanTouched": false,
	  "phases": [
	    { "id": "implement", "label": "Implement", "role": "implement", "status": "pass", "visits": 1, "next": "review",
	      "sessions": [{ "sessionId": "c_impl", "visit": 1, "result": "pass", "startedAt": 100, "endedAt": 200 }], "decisions": [] },
	    { "id": "review", "label": "Review", "role": "review", "status": "active", "visits": 2, "cap": 5,
	      "next": "pr", "onFail": "fix",
	      "sessions": [
	        { "sessionId": "c_r1", "visit": 1, "result": "fail", "detail": "1 blocker", "startedAt": 300, "endedAt": 400, "humanTouched": false },
	        { "sessionId": "c_r2", "visit": 2, "startedAt": 500 }],
	      "decisions": [{ "at": 450, "by": "overseer", "step": "review", "action": "retry", "reason": "flaky reviewer" }] },
	    { "id": "verify", "label": "Verify", "role": "verify", "status": "pending", "visits": 0, "next": "pr",
	      "sessions": [{ "visit": 1, "startedAt": 50 }], "decisions": [] }],
	  \(block ? #""block": { "question": "Which base?", "at": 1500, "by": "engine", "step": "review" },"# : "")
	  "handoff": { "text": "left off at the null case", "tree": "abc123", "at": 1400 },
	  "error": "phase crashed once",
	  "createdAt": 1000, "updatedAt": \(updatedAt), "handoffStale": true }
	"""
}

@MainActor
final class RunsTests: XCTestCase {
	private func makeStore() -> DeckStore {
		RunStub.replies = [:]
		RunStub.requests = []
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RunStub.self]
		let client = DeckClient(credentials: Credentials(baseURL: URL(string: "https://deck.test")!, token: "t"), configuration: configuration)
		return DeckStore(client: client)
	}

	private var posts: [RunStub.Request] {
		RunStub.requests.filter { $0.method == "POST" }
	}

	func testDecodesEveryDocumentedDigestField() throws {
		let run = try JSONDecoder().decode(RunDigest.self, from: Data(digest().utf8))
		XCTAssertEqual(run.workflow.category, "dev")
		XCTAssertEqual(run.issue?.issueId, "owner/repo#7")
		XCTAssertEqual(run.pr?.baseRefName, "main")
		XCTAssertEqual(run.status, .blocked)
		XCTAssertEqual(run.cap, 5)
		XCTAssertTrue(run.loop)
		XCTAssertEqual(run.findings.first?.keep, "k")
		XCTAssertTrue(run.escalations.disagreement)
		XCTAssertEqual(run.block?.step, "review")
		XCTAssertEqual(run.handoff?.tree, "abc123")
		XCTAssertEqual(run.error, "phase crashed once")
		XCTAssertEqual(run.handoffStale, true)
		let review = try XCTUnwrap(run.currentPhase)
		XCTAssertEqual(review.visits, 2)
		XCTAssertEqual(review.onFail, "fix")
		XCTAssertEqual(review.sessions.map(\.sessionId), ["c_r1", "c_r2"])
		XCTAssertEqual(review.decisions.first?.reason, "flaky reviewer")
		XCTAssertNil(run.phases[2].sessions.first?.sessionId, "a command step has no session")
	}

	func testUnknownStatusesFallBack() throws {
		let run = try JSONDecoder().decode(RunDigest.self, from: Data(digest(status: "exploded").utf8))
		XCTAssertEqual(run.status, .unknown)
	}

	func testLatestSessionIsTheCurrentPhasesLastRound() throws {
		let run = try JSONDecoder().decode(RunDigest.self, from: Data(digest().utf8))
		XCTAssertEqual(run.latestSessionId, "c_r2")
	}

	func testOnlyABlockedRunIsAnAsk() throws {
		let blocked = try JSONDecoder().decode(RunDigest.self, from: Data(digest().utf8))
		let ask = try XCTUnwrap(blocked.ask)
		XCTAssertEqual(ask.runId, "r_1")
		XCTAssertEqual(ask.sessionId, "c_r2")
		XCTAssertEqual(ask.questions.first?.question, "Which base?")
		XCTAssertEqual(ask.questions.first?.header, "#7")
		let running = try JSONDecoder().decode(RunDigest.self, from: Data(digest(status: "running").utf8))
		XCTAssertNil(running.ask)
	}

	/// deck lists a blocked run among the asks, without a sessionId when the
	/// run has no phase session. That entry must not sink the whole list.
	func testAsksListDecodesRunEntries() throws {
		let json = """
		[{ "sessionId": "c_1", "source": "mcp", "askId": "toolu_1", "askedAt": 1,
		   "questions": [{ "question": "Go?", "header": "Go", "multiSelect": false, "options": [{ "label": "Yes" }] }] },
		 { "source": "run", "runId": "r_1", "questions": [{ "question": "Which base?", "header": "#7", "options": [] }], "askedAt": 2 },
		 { "source": "run", "runId": "r_2", "sessionId": "c_9", "questions": [{ "question": "Q", "header": "#8", "options": [] }], "askedAt": 3 }]
		"""
		let asks = try JSONDecoder().decode([DeckAsk].self, from: Data(json.utf8))
		XCTAssertEqual(asks.map(\.runId), [nil, "r_1", "r_2"])
		XCTAssertEqual(asks.map(\.sessionId), ["c_1", "r_1", "c_9"])
		XCTAssertEqual(Set(asks.map(\.id)).count, 3)
	}

	func testBoardPutsWhatNeedsYouFirstAndFinishedLast() throws {
		func run(_ id: String, _ status: String, _ updatedAt: Int) throws -> RunDigest {
			try JSONDecoder().decode(RunDigest.self, from: Data(digest(id: id, status: status, updatedAt: updatedAt).utf8))
		}
		let board = RunBoard.sorted([
			try run("done", "done", 9000),
			try run("old-running", "running", 3000),
			try run("blocked", "blocked", 1000),
			try run("new-running", "waiting", 5000),
			try run("paused", "paused", 2000)
		])
		XCTAssertEqual(board.map(\.id), ["blocked", "paused", "new-running", "old-running", "done"])
	}

	func testRefreshRunsShowsBlockedRunsAsAsks() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest()), \(digest(id: "r_2", status: "running"))]")
		await store.refreshRuns()
		XCTAssertEqual(store.runs.map(\.id), ["r_1", "r_2"])
		XCTAssertEqual(store.asks.compactMap(\.runId), ["r_1"])
		XCTAssertEqual(store.awaitingCount, 1)
		XCTAssertTrue(posts.isEmpty)
	}

	/// An older deck has no runs route: the board stays empty and nothing fails.
	func testADeckWithoutRunsLeavesTheBoardEmpty() async {
		let store = makeStore()
		await store.refreshRuns()
		XCTAssertTrue(store.runs.isEmpty)
	}

	/// The client names the action and shows the digest deck answers with. Here
	/// deck answers a pause with a run still running, and that is what shows:
	/// the store never moves a run on its own.
	func testActionsPostAndShowOnlyWhatDeckReturns() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest(status: "running", block: false))]")
		await store.refreshRuns()
		RunStub.replies["/api/agent/runs/r_1/pause"] = (200, digest(status: "running", updatedAt: 3000, block: false))
		try await store.runAction(.pause, run: "r_1")
		XCTAssertEqual(store.runs.first?.status, .running)
		XCTAssertEqual(store.runs.first?.updatedAt, 3000)

		RunStub.replies["/api/agent/runs/r_1/resume"] = (200, digest(status: "running", phase: "implement", updatedAt: 4000, block: false))
		try await store.runAction(.resume, run: "r_1", phase: "implement")
		XCTAssertEqual(store.runs.first?.phase, "implement")
		XCTAssertEqual(posts.map(\.path), ["/api/agent/runs/r_1/pause", "/api/agent/runs/r_1/resume"])
		XCTAssertEqual(posts.last?.body["phase"] as? String, "implement")
	}

	/// A refused action (deck answers 409) changes nothing locally.
	func testARefusedActionLeavesTheRunAsItWas() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest())]")
		await store.refreshRuns()
		RunStub.replies["/api/agent/runs/r_1/pause"] = (409, #"{"message":"blocked: take it over instead"}"#)
		do {
			try await store.runAction(.pause, run: "r_1")
			XCTFail("a 409 should throw")
		} catch {}
		XCTAssertEqual(store.runs.first?.status, .blocked)
		XCTAssertEqual(store.asks.compactMap(\.runId), ["r_1"])
	}

	/// Answering a run's ask goes to the run's answer action with the reply as
	/// written, and the question leaves the inbox once deck says it resumed.
	func testAnsweringARunAskPostsTheReplyToTheRun() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest())]")
		await store.refreshRuns()
		let ask = try XCTUnwrap(store.asks.first { $0.runId == "r_1" })
		var draft = AskAnswerDraft(questions: ask.questions)
		draft.setReply("main", question: 0)
		RunStub.replies["/api/agent/runs/r_1/answer"] = (200, digest(status: "running", updatedAt: 3000, block: false))
		try await store.answer(ask: ask, text: draft.text, answers: draft.answers)
		XCTAssertEqual(posts.map(\.path), ["/api/agent/runs/r_1/answer"])
		XCTAssertEqual(posts.first?.body["text"] as? String, "main")
		XCTAssertTrue(store.asks.isEmpty)
		XCTAssertEqual(store.runs.first?.status, .running)
	}

	/// A run-updated event makes the store fetch that run's digest.
	func testRunUpdatedEventRefetchesTheRun() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs/r_1"] = (200, digest(status: "paused", block: false))
		let events = try JSONDecoder().decode(EventsResponse.self, from: Data("""
		{ "events": [{ "seq": 5, "sessionId": "r_1", "type": "run-updated", "at": 1,
		  "runId": "r_1", "status": "paused", "phase": "review", "updatedAt": 2000 }], "seq": 5 }
		""".utf8))
		store.apply(events)
		for _ in 0..<50 where store.runs.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
		XCTAssertEqual(store.runs.first?.status, .paused)
		XCTAssertTrue(posts.isEmpty)
	}

	/// An older digest landing after a newer one (two fetches out of order)
	/// does not roll the run back.
	func testAnOlderDigestDoesNotReplaceANewerOne() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs/r_1"] = (200, digest(status: "paused", updatedAt: 5000, block: false))
		await store.refreshRun(id: "r_1")
		RunStub.replies["/api/agent/runs/r_1"] = (200, digest(status: "running", updatedAt: 4000, block: false))
		await store.refreshRun(id: "r_1")
		XCTAssertEqual(store.runs.first?.status, .paused)
	}

	/// The phase session's own question events never clear a run's question.
	func testSessionAskEventsLeaveTheRunAskAlone() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest())]")
		await store.refreshRuns()
		let events = try JSONDecoder().decode(EventsResponse.self, from: Data("""
		{ "events": [{ "seq": 6, "sessionId": "c_r2", "type": "awaiting-input", "awaitingInput": false }], "seq": 6 }
		""".utf8))
		store.apply(events)
		XCTAssertEqual(store.asks.compactMap(\.runId), ["r_1"])
	}

	/// A deleted run leaves the board and the inbox; a question its phase
	/// session asked on its own stays.
	func testRunDeletedEventDropsTheRunAndItsAsk() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest()), \(digest(id: "r_2"))]")
		await store.refreshRuns()
		RunStub.replies["/api/agent/asks"] = (200, """
		[{ "sessionId": "c_r2", "source": "mcp", "askId": "toolu_1", "askedAt": 1,
		   "questions": [{ "question": "Go?", "header": "Go", "multiSelect": false, "options": [{ "label": "Yes" }] }] },
		 { "source": "run", "runId": "r_1", "sessionId": "c_r2", "questions": [{ "question": "Which base?", "header": "#7", "options": [] }], "askedAt": 2 },
		 { "source": "run", "runId": "r_2", "sessionId": "c_r2", "questions": [{ "question": "Which base?", "header": "#7", "options": [] }], "askedAt": 2 }]
		""")
		await store.refreshAsks()
		let events = try JSONDecoder().decode(EventsResponse.self, from: Data("""
		{ "events": [{ "seq": 7, "sessionId": "r_1", "type": "run-deleted", "runId": "r_1" }], "seq": 7 }
		""".utf8))
		store.apply(events)
		XCTAssertEqual(store.runs.map(\.id), ["r_2"])
		XCTAssertEqual(store.asks.compactMap(\.runId), ["r_2"])
		XCTAssertEqual(store.asks.filter { $0.runId == nil }.map(\.sessionId), ["c_r2"])
		XCTAssertTrue(posts.isEmpty)
	}

	// MARK: - Fix remaining findings, deleting runs

	private func decode(_ json: String) throws -> RunDigest {
		try JSONDecoder().decode(RunDigest.self, from: Data(json.utf8))
	}

	func testFixFindingsOnlyOffersOnAFinishedDevRunWithAPRAndFindings() throws {
		let done = digest(status: "done", block: false)
		XCTAssertTrue(try decode(done).canFixFindings)
		XCTAssertFalse(try decode(digest(status: "running", block: false)).canFixFindings, "not finished")
		XCTAssertFalse(try decode(digest(status: "cancelled", block: false)).canFixFindings, "cancelled is not done")
		XCTAssertFalse(try decode(done.replacingOccurrences(of: #""category": "dev""#, with: #""category": "review""#)).canFixFindings, "review run")
		let noPR = done.replacingOccurrences(
			of: #""pr": { "repo": "owner/repo", "number": 9, "url": "https://github.com/owner/repo/pull/9", "title": "Fix", "baseRefName": "main" },"#,
			with: "")
		XCTAssertNil(try decode(noPR).pr)
		XCTAssertFalse(try decode(noPR).canFixFindings, "no PR")
		let clean = done.replacingOccurrences(
			of: #"[{ "file": "src/a.ts", "line": 3, "severity": "blocker", "defect": "d", "fix": "f", "keep": "k" }]"#,
			with: "[]")
		XCTAssertFalse(try decode(clean).canFixFindings, "no findings")
	}

	func testFollowUpDecodesAndIsAbsentOnOlderDecks() throws {
		XCTAssertNil(try decode(digest()).followUp)
		let following = digest(status: "running", block: false)
			.replacingOccurrences(of: #""handoffStale": true"#, with: #""handoffStale": true, "followUp": true"#)
		XCTAssertEqual(try decode(following).followUp, true)
	}

	/// The button posts fix-findings with an empty body and shows the digest
	/// deck answers with, follow-up flag and all.
	func testFixFindingsPostsAnEmptyBodyAndShowsTheFollowUp() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest(status: "done", block: false))]")
		await store.refreshRuns()
		let running = digest(status: "running", updatedAt: 3000, block: false)
			.replacingOccurrences(of: #""handoffStale": true"#, with: #""handoffStale": true, "followUp": true"#)
		RunStub.replies["/api/agent/runs/r_1/fix-findings"] = (200, running)
		try await store.runAction(.fixFindings, run: "r_1")
		XCTAssertEqual(posts.map(\.path), ["/api/agent/runs/r_1/fix-findings"])
		XCTAssertTrue(posts.first?.body.isEmpty ?? false)
		XCTAssertEqual(store.runs.first?.status, .running)
		XCTAssertEqual(store.runs.first?.followUp, true)
	}

	/// A 409 carries deck's reason, which is what the person needs to read.
	func testARefusedFixFindingsCarriesDecksMessage() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest(status: "done", block: false))]")
		await store.refreshRuns()
		RunStub.replies["/api/agent/runs/r_1/fix-findings"] = (409, #"{"message":"the PR is merged, so there is nothing to push to"}"#)
		do {
			try await store.runAction(.fixFindings, run: "r_1")
			XCTFail("a 409 should throw")
		} catch DeckError.http(let status, let message) {
			XCTAssertEqual(status, 409)
			XCTAssertEqual(message, "the PR is merged, so there is nothing to push to")
		} catch {
			XCTFail("unexpected \(error)")
		}
		XCTAssertEqual(store.runs.first?.status, .done)
	}

	func testDeletingARunDropsItAndItsAsk() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest()), \(digest(id: "r_2", status: "done", block: false))]")
		await store.refreshRuns()
		RunStub.replies["/api/agent/runs/r_1"] = (200, #"{"ok":true}"#)
		try await store.deleteRun(id: "r_1")
		XCTAssertEqual(RunStub.requests.last?.method, "DELETE")
		XCTAssertEqual(RunStub.requests.last?.path, "/api/agent/runs/r_1")
		XCTAssertEqual(store.runs.map(\.id), ["r_2"])
		XCTAssertTrue(store.asks.isEmpty)
	}

	/// A failed delete leaves the run where it was.
	func testAFailedDeleteKeepsTheRun() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest())]")
		await store.refreshRuns()
		RunStub.replies["/api/agent/runs/r_1"] = (409, #"{"message":"run is active"}"#)
		do {
			try await store.deleteRun(id: "r_1")
			XCTFail("a 409 should throw")
		} catch {}
		XCTAssertEqual(store.runs.map(\.id), ["r_1"])
	}

	/// Clearing finished runs asks deck once and re-reads the board from it.
	func testClearingFinishedRunsAsksDeckAndRereadsTheBoard() async throws {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest()), \(digest(id: "r_2", status: "done", block: false))]")
		await store.refreshRuns()
		XCTAssertEqual(store.asks.compactMap(\.runId), ["r_1"])
		RunStub.requests = []
		RunStub.replies["DELETE /api/agent/runs"] = (200, #"{"deleted":1}"#)
		RunStub.replies["/api/agent/runs"] = (200, "[\(digest(id: "r_3", status: "running", block: false))]")
		let deleted = try await store.deleteFinishedRuns()
		XCTAssertEqual(deleted, 1)
		let deletes = RunStub.requests.filter { $0.method == "DELETE" }
		XCTAssertEqual(deletes.map(\.path), ["/api/agent/runs"])
		XCTAssertTrue(deletes.first?.query?.contains("finished=1") ?? false)
		XCTAssertEqual(deletes.first?.auth?.hasPrefix("Bearer "), true)
		XCTAssertTrue(RunStub.requests.contains { $0.method == "GET" && $0.path == "/api/agent/runs" })
		XCTAssertEqual(store.runs.map(\.id), ["r_3"])
		XCTAssertTrue(store.asks.isEmpty)
	}

	/// The board carries the overseer's session so it is one tap away; a deck
	/// without one leaves it nil.
	func testRefreshRunsReadsTheOverseer() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[]")
		await store.refreshRuns()
		XCTAssertNil(store.overseer)
		RunStub.replies["/api/agent/overseer"] = (200, #"{"sessionId":"c_over","active":true,"busy":false}"#)
		await store.refreshRuns()
		XCTAssertEqual(store.overseer?.sessionId, "c_over")
		XCTAssertEqual(store.overseer?.active, true)
	}

	/// A failed overseer read keeps the last one; only a 404 clears it.
	func testOverseerSurvivesAFailedReadButNotA404() async {
		let store = makeStore()
		RunStub.replies["/api/agent/runs"] = (200, "[]")
		RunStub.replies["/api/agent/overseer"] = (200, #"{"sessionId":"c_over","active":true,"busy":false}"#)
		await store.refreshRuns()
		RunStub.replies["/api/agent/overseer"] = (500, #"{"message":"boom"}"#)
		await store.refreshOverseer()
		XCTAssertEqual(store.overseer?.sessionId, "c_over")
		RunStub.replies["/api/agent/overseer"] = nil
		await store.refreshOverseer()
		XCTAssertNil(store.overseer)
	}
}
