import XCTest
@testable import DeckKit

private final class RequestStub: URLProtocol {
	static var handler: ((URLRequest) throws -> Data)?
	static var status = 200
	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		do {
			let data = try Self.handler!(request)
			client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
			client?.urlProtocol(self, didLoad: data)
			client?.urlProtocolDidFinishLoading(self)
		} catch {
			client?.urlProtocol(self, didFailWithError: error)
		}
	}
	override func stopLoading() {}
}

final class ParityTests: XCTestCase {
	private static func bodyData(_ request: URLRequest) -> Data {
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
		return data
	}

	private static func stubbedClient() -> DeckClient {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RequestStub.self]
		return DeckClient(credentials: Credentials(baseURL: URL(string: "https://example.test")!, token: "example-token"), configuration: configuration)
	}

	private func client(check: @escaping (URLRequest, [String: Any]) -> Void) -> DeckClient {
		RequestStub.status = 200
		RequestStub.handler = { request in
			let body = try JSONSerialization.jsonObject(with: Self.bodyData(request)) as! [String: Any]
			check(request, body)
			return Data(#"{"id":"example","ok":true}"#.utf8)
		}
		return Self.stubbedClient()
	}

	/// One request as the server would see it.
	private struct Sent {
		let method: String
		let path: String
		let query: String?
		let accept: String?
		let contentType: String?
		/// The JSON body's top-level keys, sorted; nil when the body was empty or not an object.
		let keys: [String]?
		let json: Any?
	}

	private final class Recorder: @unchecked Sendable {
		var sent: [Sent] = []
	}

	/// Run `call` against a stub answering `reply` with `status`, and return
	/// every request it made. The call's own result (or decode failure) is
	/// ignored: these tests are about what goes out.
	private func requests(
		reply: String = #"{"ok":true}"#,
		status: Int = 200,
		_ call: (DeckClient) async throws -> Void
	) async -> [Sent] {
		let recorder = Recorder()
		RequestStub.status = status
		RequestStub.handler = { request in
			let data = Self.bodyData(request)
			let json = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)
			recorder.sent.append(Sent(
				method: request.httpMethod ?? "GET",
				path: request.url?.path ?? "",
				query: request.url?.query,
				accept: request.value(forHTTPHeaderField: "Accept"),
				contentType: request.value(forHTTPHeaderField: "Content-Type"),
				keys: (json as? [String: Any]).map { $0.keys.sorted() },
				json: json))
			return Data(reply.utf8)
		}
		try? await call(Self.stubbedClient())
		return recorder.sent
	}

	private func assertShape(
		_ sent: [Sent], _ method: String, _ path: String, query: String? = nil, keys: [String]? = nil,
		file: StaticString = #filePath, line: UInt = #line
	) {
		guard sent.count == 1, let request = sent.first else {
			return XCTFail("expected one request, got \(sent.map(\.path))", file: file, line: line)
		}
		XCTAssertEqual(request.method, method, file: file, line: line)
		XCTAssertEqual(request.path, path, file: file, line: line)
		XCTAssertTrue(request.path.hasPrefix("/api/agent"), "only agent routes", file: file, line: line)
		if let query { XCTAssertEqual(request.query, query, file: file, line: line) }
		XCTAssertEqual(request.keys, keys, file: file, line: line)
	}

	func testIssueDiscoverySurvivesCreationWithRawTemplate() async throws {
		let issue = try JSONDecoder().decode(DeckIssue.self, from: Data(#"{"source":"linear","sourceId":"source-a","id":"EX-1"}"#.utf8))
		let client = client { request, body in
			XCTAssertEqual(request.url?.path, "/api/agent/sessions")
			XCTAssertEqual((body["issue"] as? [String: Any])?["sourceId"] as? String, "source-a")
			XCTAssertEqual(body["prompt"] as? String, "[issue_body]\n[issue_comments]")
		}
		_ = try await client.createWorkSession(cwd: "/path/to/project", prompt: "[issue_body]\n[issue_comments]", issue: issue)
		let legacy = try JSONDecoder().decode(DeckIssue.self, from: Data(#"{"source":"linear","id":"EX-1"}"#.utf8))
		XCTAssertNil(legacy.sourceId)
	}

	func testMultipleIssuesPreserveSourcesAndRetryKey() async throws {
		let client = client { request, body in
			let issues = body["issues"] as? [[String: String]]
			XCTAssertEqual(issues?.map { $0["sourceId"] }, ["source-a", "source-b"])
			XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "operation-a")
		}
		_ = try await client.createWorkSession(
			cwd: "/path/to/project",
			issue: DeckIssue(source: "linear", sourceId: "source-a", issueId: "EX-1"),
			additionalIssues: [DeckIssue(source: "linear", sourceId: "source-b", issueId: "EX-2")],
			idempotencyKey: "operation-a")
	}

	func testImagesDoNotExpandLiteralMessageText() async throws {
		let client = client { _, body in
			XCTAssertEqual(body["text"] as? String, "Explain [title]")
			XCTAssertNil(body["expand"])
			XCTAssertEqual((body["images"] as? [[String: String]])?.first?["media_type"], "image/png")
		}
		try await client.sendMessage(sessionId: "example", text: "Explain [title]", images: [DeckImage(mediaType: "image/png", data: "aGVsbG8=")])
	}

	func testQuickMessagesOptIntoServerExpansion() async throws {
		let client = client { _, body in XCTAssertEqual(body["expand"] as? Bool, true) }
		try await client.sendQuickMessage(sessionId: "example", text: "[issue_body]")
	}

	func testConflictRetrySendsOnExistingUnderTheSameKey() async {
		var request = CreateSessionRequest(mode: .work, cwd: "/path/to/project")
		request.worktree = WorktreeOptions(branch: "EX-1", base: "main", onExisting: .recreate)
		let recorder = Recorder()
		RequestStub.status = 201
		RequestStub.handler = { sent in
			recorder.sent.append(Sent(
				method: sent.httpMethod ?? "", path: sent.url?.path ?? "", query: nil,
				accept: sent.value(forHTTPHeaderField: "Idempotency-Key"), contentType: nil, keys: nil,
				json: try? JSONSerialization.jsonObject(with: Self.bodyData(sent))))
			return Data(#"{"id":"example","url":"https://example.test/s/example"}"#.utf8)
		}
		_ = try? await Self.stubbedClient().createSession(request, idempotencyKey: "item-a")
		XCTAssertEqual(recorder.sent.first?.path, "/api/agent/sessions")
		XCTAssertEqual(recorder.sent.first?.accept, "item-a", "the Idempotency-Key header")
		let worktree = (recorder.sent.first?.json as? [String: Any])?["worktree"] as? [String: Any]
		XCTAssertEqual(worktree?["onExisting"] as? String, "recreate")
		XCTAssertEqual(worktree?["branch"] as? String, "EX-1")
	}

	func testABranchConflictDecodesIntoTheConflict() async {
		RequestStub.status = 409
		RequestStub.handler = { _ in
			Data(#"{"message":"The branch EX-1 already exists.","code":"branch-exists","branch":"EX-1"}"#.utf8)
		}
		do {
			_ = try await Self.stubbedClient().createSession(CreateSessionRequest(mode: .work, cwd: "/path/to/project"))
			XCTFail("a 409 must throw")
		} catch DeckError.worktreeConflict(let conflict) {
			XCTAssertEqual(conflict, WorktreeConflict(code: .branchExists, branch: "EX-1", message: "The branch EX-1 already exists."))
		} catch {
			XCTFail("expected a worktree conflict, got \(error)")
		}
	}

	func testABusy409StaysAnHTTPError() async {
		RequestStub.status = 409
		RequestStub.handler = { _ in Data(#"{"message":"a turn is already running"}"#.utf8) }
		do {
			_ = try await Self.stubbedClient().createSession(CreateSessionRequest(mode: .work, cwd: "/path/to/project"))
			XCTFail("a 409 must throw")
		} catch DeckError.http(let status, _) {
			XCTAssertEqual(status, 409)
		} catch {
			XCTFail("expected a plain HTTP error, got \(error)")
		}
	}

	func testReviewPreservesBaseBranch() async throws {
		let client = client { _, body in
			XCTAssertEqual((body["worktree"] as? [String: String])?["base"], "release")
		}
		_ = try await client.createReviewSession(cwd: "/path/to/project", pr: DeckPR(repo: "acme/web", number: 12, baseRefName: "release"))
	}

	func testAgentSwitchUsesSharedServerRoute() async throws {
		let client = client { request, body in
			XCTAssertEqual(request.url?.path, "/api/agent/sessions/example/agent")
			XCTAssertEqual(body["kind"] as? String, "codex")
		}
		try await client.changeAgent(sessionId: "example", kind: "codex")
	}

	// The stub's canned reply is not a schedule, so both of these discard the
	// decode failure and check `sent` instead. Without that the assertions would
	// simply never run and the test would pass having proved nothing.
	func testASchedulePostsBothHalvesOfItsTarget() async throws {
		var sent = false
		let client = client { request, body in
			sent = true
			XCTAssertEqual(request.url?.path, "/api/agent/schedules")
			XCTAssertEqual(body["cwd"] as? String, "/path/to/project")
			// Blank rather than omitted: deck reads an omitted field as "carry
			// what is stored", so moving a schedule's target needs both halves.
			XCTAssertEqual(body["sessionId"] as? String, "")
			XCTAssertEqual(body["cron"] as? String, "0 9 * * mon-fri")
		}
		_ = try? await client.createSchedule(
			ScheduleDraft(title: "Morning sweep", cron: "0 9 * * mon-fri", prompt: "go", cwd: "/path/to/project"))
		XCTAssertTrue(sent, "the request never went out")
	}

	// Pausing must send `enabled` alone. The whole draft would carry the form's
	// idea of every other field, and a toggle in a list has no form behind it.
	func testPausingASchedulePatchesNothingElse() async throws {
		var sent = false
		let client = client { request, body in
			sent = true
			XCTAssertEqual(request.httpMethod, "PATCH")
			XCTAssertEqual(request.url?.path, "/api/agent/schedules/sch_a")
			XCTAssertEqual(body["enabled"] as? Bool, false)
			XCTAssertEqual(body.count, 1)
		}
		_ = try? await client.setScheduleEnabled(id: "sch_a", enabled: false)
		XCTAssertTrue(sent, "the request never went out")
	}

	func testChatGroupsWorkWithoutHidingQuestionsOrProse() {
		let tool = ToolCall(id: "a", name: "Bash", input: .null)
		let other = ToolCall(id: "b", name: "Read", input: .null)
		let ask = ToolCall(id: "c", name: "mcp__deck__ask", input: .null)
		let items: [TranscriptItem] = [.tool(tool), .thinking(id: "thinking", text: "inspect"), .tool(other), .tool(ask), .assistant(id: "reply", text: "Done")]
		let groups = TranscriptGroup.make(items, condensed: true)
		XCTAssertEqual(groups.count, 3)
		XCTAssertEqual(groups[0].toolCount, 2)
		XCTAssertEqual(groups.flatMap(\.items), items)
		XCTAssertEqual(TranscriptGroup.make(items, condensed: false).count, items.count)
		XCTAssertFalse(TranscriptGroup.make([.tool(tool)], condensed: true)[0].isCollapsedRun)
	}

	func testAgentHandoffIsVisibleInTranscript() {
		var builder = TranscriptBuilder()
		builder.append(JSONValue.parse(Data(#"{"type":"deck.agent","kind":"codex"}"#.utf8))!)
		builder.append(JSONValue.parse(Data(#"{"type":"deck.agent","from":"claude","kind":"pi"}"#.utf8))!)
		guard case .notice(_, let text, let level) = builder.items.first else { return XCTFail("missing handoff") }
		XCTAssertEqual(text, "agent → codex")
		XCTAssertEqual(level, .info)
		guard case .notice(_, let handoff, _) = builder.items.last else { return XCTFail("missing handoff") }
		XCTAssertEqual(handoff, "agent claude → pi")
	}

	func testStructuredAnswersTravelWithTheAskId() async throws {
		let client = client { request, body in
			XCTAssertEqual(request.url?.path, "/api/agent/sessions/example/answer")
			XCTAssertEqual(body["askId"] as? String, "toolu_1")
			XCTAssertEqual(body["text"] as? String, "Answering your question:\n- Approach: Rewrite")
			XCTAssertEqual((body["answers"] as? [[String: Any]])?.first?["labels"] as? [String], ["Rewrite"])
		}
		var draft = AskAnswerDraft(questions: [AskQuestion(question: "How?", header: "Approach", options: [AskOption(label: "Rewrite")])])
		draft.toggle("Rewrite", question: 0)
		_ = try await client.answer(sessionId: "example", text: draft.text, askId: "toolu_1", answers: draft.answers)
	}

	func testStartDefaultsComeFromTheServer() async throws {
		RequestStub.status = 200
		RequestStub.handler = { request in
			XCTAssertEqual(request.url?.path, "/api/agent/defaults")
			XCTAssertEqual(request.url?.query, "project=/path/to/project")
			return Data(#"{"path":"/path/to/project","base":"main","prompts":{"work":"Fix [issue_body]"},"kinds":{"claude":{"model":"sonnet","effort":"high","permissionMode":"bypassPermissions"},"pi":{"model":"gpt","provider":"openai"}}}"#.utf8)
		}
		let project = try await Self.stubbedClient().startDefaults(project: "/path/to/project")
		let claude = StartDefaults.resolve(kind: "claude", project: project)
		XCTAssertEqual(claude.modelId, "sonnet")
		XCTAssertEqual(claude.effort, "high")
		XCTAssertEqual(claude.base, "main")
		XCTAssertEqual(claude.permissionMode, "bypassPermissions")
		XCTAssertEqual(claude.firstPrompt, "Fix [issue_body]")
		let pi = StartDefaults.resolve(kind: "pi", review: true, project: project)
		XCTAssertEqual(pi.model.provider, "openai")
		XCTAssertNil(pi.permissionMode)
		XCTAssertEqual(pi.firstPrompt, FallbackPrompt.review, "no review prompt configured: keyboardless surfaces fall back")
		let unknown = StartDefaults.resolve(kind: "codex", project: nil)
		XCTAssertNil(unknown.modelId)
		XCTAssertNil(unknown.firstPrompt, "nothing fetched leaves the choice to the server")
	}

	func testExistingWorktreeStartsInThatDirectory() async throws {
		let client = client { _, body in
			XCTAssertEqual(body["cwd"] as? String, "/path/to/project-worktrees/task")
			XCTAssertNil(body["worktree"])
		}
		_ = try await client.createWorkSession(cwd: "/path/to/project-worktrees/task", issue: DeckIssue(source: "github", issueId: "acme/web#1"))
	}


	// MARK: - Every call goes to its agent route (plan item P9)

	func testAutomationSavePatchesOnlyTheAutomation() async throws {
		let sent = await requests { client in
			let automation = ProjectAutomation(work: true, review: false, workAgent: AutomationAgent(kind: "codex", model: "gpt-5", effort: "high"), reviewAgent: AutomationAgent())
			_ = try await client.saveAutomation(projectPath: "/path/to/project", automation: automation)
		}
		assertShape(sent, "PATCH", "/api/agent/projects/config", keys: ["automation", "path"])
		let automation = (sent.first?.json as? [String: Any])?["automation"] as? [String: Any]
		XCTAssertEqual(automation?["work"] as? Bool, true)
		XCTAssertEqual((automation?["reviewAgent"] as? [String: Any])?.isEmpty, true, "an untouched claude lane clears to the default")
		XCTAssertEqual((automation?["workAgent"] as? [String: Any])?["model"] as? String, "gpt-5")
		XCTAssertNil((automation?["workAgent"] as? [String: Any])?["effort"], "effort is claude-only")
	}

	func testProjectDetailsReadTheConfigRecords() async {
		let sent = await requests(reply: "[]") { _ = try await $0.projectDetails() }
		assertShape(sent, "GET", "/api/agent/projects/config")
		XCTAssertNil(sent.first?.query, "no path: every record")
	}

	func testWorktreesUseTheAgentGitRoute() async {
		let sent = await requests(reply: "[]") { _ = try await $0.worktrees(repo: "/path/to/project") }
		assertShape(sent, "GET", "/api/agent/git/worktrees", query: "repo=/path/to/project")
	}

	func testBranchesUseTheAgentGitRoute() async {
		let sent = await requests(reply: "[]") { _ = try await $0.branches(repo: "/path/to/project") }
		assertShape(sent, "GET", "/api/agent/git/branches", query: "repo=/path/to/project")
	}

	func testUserLoginUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"login":"octocat"}"#) { _ = try await $0.currentUserLogin() }
		assertShape(sent, "GET", "/api/agent/user")
	}

	func testBackScrollReadsHistory() async {
		let sent = await requests(reply: #"{"start":0,"events":[]}"#) { _ = try await $0.transcriptRange(sessionId: "example", before: 500, limit: 250) }
		assertShape(sent, "GET", "/api/agent/sessions/example/history", query: "before=500&limit=250")
	}

	func testImageBytesUseTheAgentRoute() async {
		let sent = await requests { _ = try await $0.imageData(sessionId: "example", file: "a.png") }
		assertShape(sent, "GET", "/api/agent/sessions/example/images/a.png")
	}

	func testDiffUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"git":false}"#) { _ = try await $0.diff(sessionId: "example") }
		assertShape(sent, "GET", "/api/agent/sessions/example/diff")
	}

	func testServerStatesUseTheAgentRoute() async {
		let sent = await requests(reply: "{}") { _ = try await $0.serverStates() }
		assertShape(sent, "GET", "/api/agent/servers")
	}

	func testSessionServersUseTheAgentRoute() async {
		let sent = await requests(reply: #"{"servers":[]}"#) { _ = try await $0.servers(sessionId: "example") }
		assertShape(sent, "GET", "/api/agent/sessions/example/servers")
	}

	func testServerActionPostsTheStep() async {
		let sent = await requests { try await $0.serverAction(sessionId: "example", name: "web", action: "step", step: 1, label: "install") }
		assertShape(sent, "POST", "/api/agent/sessions/example/servers/web", keys: ["action", "label", "step"])
	}

	func testServerLogsSendTheTag() async {
		let sent = await requests(reply: #"{"text":""}"#) { _ = try await $0.serverLogs(sessionId: "example", name: "web", tag: "abc") }
		assertShape(sent, "GET", "/api/agent/sessions/example/servers/web/logs", query: "h=abc")
	}

	// MARK: - Terminals

	func testTerminalSnapshotSendsTheTag() async {
		let sent = await requests(reply: #"{"text":""}"#) { _ = try await $0.terminal(sessionId: "example", tag: "abc", lines: 200) }
		assertShape(sent, "GET", "/api/agent/sessions/example/terminal", query: "lines=200&h=abc")
	}

	func testTerminalTypesTextWithSubmit() async {
		let sent = await requests { try await $0.typeInTerminal(sessionId: "example", text: "ls -la", submit: false) }
		assertShape(sent, "POST", "/api/agent/sessions/example/terminal", keys: ["submit", "text"])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["submit"] as? Bool, false)
	}

	func testTerminalPressesAKeyByItsTmuxName() async {
		let sent = await requests { try await $0.pressInTerminal(sessionId: "example", key: .control("c")!) }
		assertShape(sent, "POST", "/api/agent/sessions/example/terminal", keys: ["key"])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["key"] as? String, "C-c")
	}

	func testAShellStartsInShellMode() async {
		let sent = await requests(reply: #"{"id":"example"}"#) { _ = try await $0.createShellSession(cwd: "/path/to/project") }
		assertShape(sent, "POST", "/api/agent/sessions", keys: ["cwd", "mode"])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["mode"] as? String, "shell")
	}

	@MainActor
	func testThePollerSendsTheTagBackUntilAKeystroke() async {
		let recorder = Recorder()
		RequestStub.status = 200
		RequestStub.handler = { request in
			recorder.sent.append(Sent(
				method: request.httpMethod ?? "GET", path: request.url?.path ?? "", query: request.url?.query,
				accept: nil, contentType: nil, keys: nil, json: nil))
			return Data(#"{"text":"\u001b[32m$ \u001b[0m","cleared":false,"dead":false,"h":"t1"}"#.utf8)
		}
		let poller = TerminalPoller.shell(client: Self.stubbedClient(), sessionId: "example")
		await poller.refresh()
		XCTAssertEqual(poller.runs.first?.text, "$ ")
		XCTAssertEqual(poller.tag, "t1")
		await poller.refresh()
		await poller.press(.enter)
		let gets = recorder.sent.filter { $0.method == "GET" }.map(\.query)
		XCTAssertEqual(gets, [nil, "h=t1", nil], "a keystroke asks for the whole screen again")
	}

	@MainActor
	func testThePollerKeepsTheScreenWhenUnchangedAndFlagsDeadOrCleared() {
		let poller = TerminalPoller(fetch: { _ in throw CancellationError() })
		XCTAssertFalse(poller.canType)
		poller.apply(TerminalSnapshot(text: "last output", cleared: true, dead: false, h: "a", unchanged: nil))
		XCTAssertTrue(poller.cleared)
		poller.apply(TerminalSnapshot(text: nil, cleared: nil, dead: nil, h: "a", unchanged: true))
		XCTAssertEqual(poller.text, "last output")
		XCTAssertTrue(poller.cleared)
		poller.apply(TerminalSnapshot(text: "(session is dead)", cleared: nil, dead: true, h: nil, unchanged: nil))
		XCTAssertTrue(poller.dead)
		XCTAssertNil(poller.tag)
		XCTAssertEqual(poller.interval, TerminalPoller.idleInterval)
		poller.focused = true
		XCTAssertEqual(poller.interval, TerminalPoller.focusedInterval)
	}

	@MainActor
	func testTerminalOverlappingRefreshesKeepTheNewerScreen() async {
		let gate = AsyncGate()
		let poller = TerminalPoller(fetch: { tag in
			if tag == "old" {
				await gate.wait()
				return TerminalSnapshot(text: "stale", cleared: nil, dead: nil, h: "stale", unchanged: nil)
			}
			return TerminalSnapshot(text: "newer", cleared: nil, dead: nil, h: "new", unchanged: nil)
		})
		poller.apply(TerminalSnapshot(text: "first", cleared: nil, dead: nil, h: "old", unchanged: nil))
		let slow = Task { await poller.refresh() }
		while !(await gate.isWaiting) { await Task.yield() }
		poller.apply(TerminalSnapshot(text: "first", cleared: nil, dead: nil, h: nil, unchanged: nil))
		await poller.refresh()
		XCTAssertEqual(poller.text, "newer")
		await gate.open()
		await slow.value
		XCTAssertEqual(poller.text, "newer")
		XCTAssertEqual(poller.tag, "new")
	}

	func testModelChangeHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { try await $0.changeModel(sessionId: "example", model: "opus") }
		assertShape(sent, "POST", "/api/agent/sessions/example/model", keys: ["model"])
	}

	func testCompactHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { try await $0.compact(sessionId: "example") }
		assertShape(sent, "POST", "/api/agent/sessions/example/compact", keys: [])
	}

	func testRestartHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { try await $0.restart(sessionId: "example") }
		assertShape(sent, "POST", "/api/agent/sessions/example/restart", keys: [])
	}

	func testDismissingAPRDeletesItWithNoBody() async {
		let sent = await requests { try await $0.dismissPR(sessionId: "example") }
		assertShape(sent, "DELETE", "/api/agent/sessions/example/pr", keys: nil)
	}

	func testRenameHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { _ = try await $0.rename(sessionId: "example", title: "New") }
		assertShape(sent, "POST", "/api/agent/sessions/example/title", keys: ["title"])
	}

	func testHidingASessionHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { try await $0.setHidden(sessionId: "example", hidden: true) }
		assertShape(sent, "POST", "/api/agent/sessions/example/hidden", keys: ["hidden"])
	}

	func testHidingAProjectHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { try await $0.setHidden(projectPath: "/path/to/project", hidden: true) }
		assertShape(sent, "POST", "/api/agent/projects/hidden", keys: ["hidden", "path"])
	}

	func testEffortChangeHasNoBrowserFallback() async {
		let sent = await requests(status: 404) { try await $0.changeEffort(sessionId: "example", effort: "high") }
		assertShape(sent, "POST", "/api/agent/sessions/example/effort", keys: ["effort"])
	}

	func testUploadHasNoBrowserFallback() async {
		let file = SharedFile(name: "report.pdf", data: Data("pdf".utf8))
		let sent = await requests(status: 404) { try await $0.upload(sessionId: "example", files: [file], text: "see this") }
		assertShape(sent, "POST", "/api/agent/sessions/example/upload", keys: ["files", "text"])
	}

	func testImagesGoToTheMessageRoute() async {
		let sent = await requests { try await $0.sendMessage(sessionId: "example", text: "Explain [title]", images: [DeckImage(mediaType: "image/png", data: "aGVsbG8=")]) }
		assertShape(sent, "POST", "/api/agent/sessions/example/message", keys: ["images", "text"])
	}

	func testQuickMessagesGoToTheMessageRoute() async {
		let sent = await requests { try await $0.sendQuickMessage(sessionId: "example", text: "[issue_body]") }
		assertShape(sent, "POST", "/api/agent/sessions/example/message", keys: ["expand", "text"])
	}

	func testQuickMessageListUsesTheAgentRoute() async {
		let sent = await requests(reply: "[]") { _ = try await $0.quickMessages() }
		assertShape(sent, "GET", "/api/agent/quick-messages")
	}

	func testSavingQuickMessagesPutsTheWholeList() async {
		let sent = await requests(reply: "[]") { _ = try await $0.saveQuickMessages([QuickMessage(id: "a", label: "", text: "go on")]) }
		assertShape(sent, "PUT", "/api/agent/quick-messages")
		let list = sent.first?.json as? [[String: Any]]
		XCTAssertEqual(list?.first?.keys.sorted(), ["id", "text"], "a blank label is dropped")
	}

	func testFileStatsUseTheAgentRoute() async {
		let sent = await requests(reply: #"{"files":[]}"#) { _ = try await $0.statFiles(sessionId: "example", paths: ["/path/to/project/out.png"]) }
		assertShape(sent, "POST", "/api/agent/sessions/example/files", keys: ["paths"])
	}

	func testFileBytesUseTheAgentRoute() async {
		let sent = await requests { _ = try await $0.fileData(sessionId: "example", path: "notes.md") }
		assertShape(sent, "GET", "/api/agent/sessions/example/files", query: "path=notes.md")
	}

	func testSpeechCapabilitiesUseTheAgentRoute() async {
		let sent = await requests(reply: #"{"tts":true,"stt":true}"#) { _ = try await $0.speechCapabilities() }
		assertShape(sent, "GET", "/api/agent/speech")
	}

	func testSpeechSegmentsUseTheAgentRoute() async {
		let sent = await requests(reply: #"{"segments":[]}"#) { _ = try await $0.speechSegments(text: "Done.") }
		assertShape(sent, "POST", "/api/agent/speech/segments", keys: ["text"])
	}

	func testSpeechAudioUsesTheAgentRoute() async {
		let sent = await requests { _ = try await $0.speechAudio(id: "abc") }
		assertShape(sent, "GET", "/api/agent/speech/audio/abc")
	}

	func testTranscriptionUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"text":""}"#) { _ = try await $0.transcribe(audio: Data([1, 2, 3]), mimeType: "audio/mp4") }
		XCTAssertEqual(sent.first?.contentType, "audio/mp4")
		assertShape(sent, "POST", "/api/agent/speech/transcribe")
	}

	func testSearchUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"query":"deck","hits":[]}"#) { _ = try await $0.search(query: "deck", limit: 40) }
		assertShape(sent, "GET", "/api/agent/search", query: "q=deck&limit=40")
	}

	func testOperatorStatusUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"configured":true}"#) { _ = try await $0.operatorStatus() }
		assertShape(sent, "GET", "/api/agent/operator")
	}

	func testOperatorTurnUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"text":"ok","actions":[]}"#) { _ = try await $0.operatorSend("status?", source: "watch") }
		assertShape(sent, "POST", "/api/agent/operator", keys: ["source", "text"])
	}

	func testOperatorHistoryUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"turns":[]}"#) { _ = try await $0.operatorHistory(limit: 60) }
		assertShape(sent, "GET", "/api/agent/operator/history", query: "limit=60")
	}

	func testOperatorResetUsesTheAgentRoute() async {
		let sent = await requests { try await $0.operatorReset() }
		assertShape(sent, "POST", "/api/agent/operator/reset")
	}

	func testOperatorAnnouncementsStreamFromTheAgentRoute() async {
		let sent = await requests(reply: "") { client in
			for try await _ in client.operatorAnnouncements() {}
		}
		assertShape(sent, "GET", "/api/agent/operator/events")
		XCTAssertEqual(sent.first?.accept, "text/event-stream")
	}

	func testSessionStreamUsesTheAgentRoute() async {
		let sent = await requests(reply: "") { client in
			for try await _ in client.sessionEventStream(sessionId: "example") {}
		}
		assertShape(sent, "GET", "/api/agent/sessions/example/stream")
		XCTAssertEqual(sent.first?.accept, "text/event-stream")
	}

	// MARK: - Capability gating

	func testServerInfoReadsTheCapabilities() async throws {
		var info: ServerInfo?
		let sent = await requests(reply: #"{"version":"1.0","capabilities":["stream","search"]}"#) { info = try await $0.serverInfo() }
		assertShape(sent, "GET", "/api/agent")
		XCTAssertEqual(info?.capabilities, ["stream", "search"])
	}

	func testAServerWithoutCapabilitiesIsOlderThanEveryToken() async throws {
		var info: ServerInfo?
		_ = await requests(reply: #"{"message":"not found"}"#, status: 404) { info = try await $0.serverInfo() }
		XCTAssertEqual(info, .legacy)
		XCTAssertEqual(info?.missing(), DeckCapability.allCases)
	}

	@MainActor
	func testAFeatureTheServerLacksIsHiddenAndFlagged() async {
		RequestStub.status = 200
		let recorder = Recorder()
		RequestStub.handler = { request in
			let path = request.url?.path ?? ""
			recorder.sent.append(Sent(method: request.httpMethod ?? "GET", path: path, query: nil, accept: nil, contentType: nil, keys: nil, json: nil))
			if path == "/api/agent" { return Data(#"{"version":"1.0","capabilities":["stream","user"]}"#.utf8) }
			if path == "/api/agent/user" { return Data(#"{"login":"octocat"}"#.utf8) }
			return Data("[]".utf8)
		}
		let store = DeckStore(client: Self.stubbedClient())
		XCTAssertTrue(store.supports(.quickMessages), "assumed until the server has said")
		XCTAssertFalse(store.serverTooOld)

		await store.refreshServerInfo()
		XCTAssertTrue(store.supports(.stream))
		XCTAssertFalse(store.supports(.quickMessages))
		XCTAssertTrue(store.serverTooOld)
		XCTAssertEqual(store.missing([.stream, .search, .diff]), [.search, .diff])

		await store.refreshQuickMessages()
		await store.refreshProjectDetails()
		await store.refreshUser()
		XCTAssertEqual(recorder.sent.map(\.path), ["/api/agent", "/api/agent/user"], "unadvertised routes are never called")
		XCTAssertEqual(store.userLogin, "octocat")
	}

	@MainActor
	func testAServerWithEveryCapabilityIsNotTooOld() async {
		let tokens = DeckCapability.allCases.map { "\"\($0.rawValue)\"" }.joined(separator: ",")
		_ = await requests(reply: #"{"version":"1.0","capabilities":[\#(tokens)]}"#) { _ in }
		let store = DeckStore(client: Self.stubbedClient())
		await store.refreshServerInfo()
		XCTAssertFalse(store.serverTooOld)
	}
}

private actor AsyncGate {
	private var waiter: CheckedContinuation<Void, Never>?
	private var opened = false

	var isWaiting: Bool { waiter != nil }

	func wait() async {
		if opened { return }
		await withCheckedContinuation { waiter = $0 }
	}

	func open() {
		opened = true
		waiter?.resume()
		waiter = nil
	}
}
