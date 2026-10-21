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

	/// Mirrors the web view's `nestSubagents`: a subagent's work folds into the
	/// Agent call that launched it, by parent id rather than position; its ask,
	/// and anything whose launcher isn't loaded, stays in the thread.
	func testSubagentStepsFoldIntoTheirAgentCard() {
		let lines = [
			#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a1","name":"Agent","input":{"description":"Scan the docs","subagent_type":"general-purpose"}},{"type":"tool_use","id":"a2","name":"Task","input":{"description":"Check tests"}}]}}"#,
			#"{"type":"assistant","parent_tool_use_id":"a1","message":{"content":[{"type":"text","text":"Reading"},{"type":"tool_use","id":"s1","name":"Read","input":{"file_path":"/path/to/project/README.md"}}]}}"#,
			#"{"type":"assistant","message":{"content":[{"type":"text","text":"Main thread"}]}}"#,
			#"{"type":"assistant","parent_tool_use_id":"a2","message":{"content":[{"type":"tool_use","id":"s2","name":"Bash","input":{"command":"pnpm test"}}]}}"#,
			#"{"type":"user","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_result","tool_use_id":"s1","content":"ok"}]}}"#,
			#"{"type":"assistant","parent_tool_use_id":"a1","message":{"content":[{"type":"tool_use","id":"q","name":"mcp__deck__ask","input":{}}]}}"#,
			#"{"type":"assistant","parent_tool_use_id":"gone","message":{"content":[{"type":"text","text":"Orphan"}]}}"#,
			#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a1","content":"Done"}]}}"#
		]
		var builder = TranscriptBuilder()
		builder.append(contentsOf: lines.map { JSONValue.parse(Data($0.utf8))! })
		let thread = builder.thread
		XCTAssertEqual(thread.items.map(\.id), ["tool-a1", "tool-a2", "2:0", "tool-q", "6:0"])
		XCTAssertEqual(thread.steps["a1"]?.map(\.id), ["1:0", "tool-s1"])
		XCTAssertEqual(thread.steps["a2"]?.map(\.id), ["tool-s2"])
		guard case .tool(let read) = thread.steps["a1"]?.last else { return XCTFail("missing step") }
		XCTAssertEqual(read.output, "ok")
		guard case .tool(let agent) = thread.items.first else { return XCTFail("missing card") }
		XCTAssertEqual(agent.headerArg, "Scan the docs")
		XCTAssertEqual(agent.output, "Done")
		XCTAssertFalse(agent.showsRawInput)
		XCTAssertEqual(thread.threadItemId(for: "tool-s1"), "tool-a1")
		XCTAssertEqual(thread.threadItemId(for: "2:0"), "2:0")
		XCTAssertNil(thread.threadItemId(for: "missing"))
	}

	func testANestedSubagentLandsOnTheOutermostCard() {
		let parents = ["tool-b": "a", "1:0": "b"]
		let items: [TranscriptItem] = [
			.tool(ToolCall(id: "a", name: "Agent", input: .null)),
			.tool(ToolCall(id: "b", name: "Agent", input: .null)),
			.assistant(id: "1:0", text: "deep")
		]
		let thread = TranscriptThread.make(items, parents: parents)
		XCTAssertEqual(thread.items.map(\.id), ["tool-a"])
		XCTAssertEqual(thread.steps["b"]?.map(\.id), ["1:0"])
		XCTAssertEqual(thread.threadItemId(for: "1:0"), "tool-a")
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

	func testANotificationAnswerPostsLikeTheAskCard() async throws {
		let info: [AnyHashable: Any] = ["ask": ["sessionId": "example", "askId": "toolu_1", "header": "Approach", "options": ["Rewrite"], "questions": 1]]
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: 0, typed: nil))
		let sent = await requests { try await answer.post(with: $0) }
		assertShape(sent, "POST", "/api/agent/sessions/example/answer", keys: ["answers", "askId", "text"])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["text"] as? String, "Answering your question:\n- Approach: Rewrite")
	}

	func testANotificationReplyToARunPostsTheRunAnswer() async throws {
		let info: [AnyHashable: Any] = ["ask": ["runId": "r_1", "header": "#7", "options": [], "questions": 1]]
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: nil, typed: "main"))
		let sent = await requests(reply: "{}") { try await answer.post(with: $0) }
		assertShape(sent, "POST", "/api/agent/runs/r_1/answer", keys: ["text"])
	}

	func testANotificationAnswerDeckTurnsDownThrowsItsReason() async throws {
		let info: [AnyHashable: Any] = ["ask": ["sessionId": "example", "options": ["Rewrite"], "questions": 1]]
		let answer = try XCTUnwrap(NotificationAnswer(userInfo: info, optionSlot: 0, typed: nil))
		var thrown: Error?
		_ = await requests(reply: #"{"ok":false,"reason":"already answered"}"#) {
			do { try await answer.post(with: $0) } catch { thrown = error }
		}
		XCTAssertEqual(thrown.map(DeckError.message(for:)), "already answered")
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

	func testSavingAProjectMessageSendsItsProjectId() async {
		let messages = [QuickMessage(id: "a", text: "go on", projectId: "/path/to/project"), QuickMessage(id: "b", text: "hi", projectId: "")]
		let sent = await requests(reply: "[]") { _ = try await $0.saveQuickMessages(messages) }
		let list = sent.first?.json as? [[String: Any]]
		XCTAssertEqual(list?.first?.keys.sorted(), ["id", "projectId", "text"])
		XCTAssertEqual(list?.first?["projectId"] as? String, "/path/to/project")
		XCTAssertEqual(list?.last?.keys.sorted(), ["id", "text"], "a blank projectId is dropped")
	}

	func testQuickMessagesDecodeWithOrWithoutAProject() throws {
		let json = #"[{"id":"a","text":"x","projectId":"/path/to/project"},{"id":"b","label":"L","text":"y"}]"#
		let list = try JSONDecoder().decode([QuickMessage].self, from: Data(json.utf8))
		XCTAssertEqual(list.map(\.projectId), ["/path/to/project", nil], "an older server's messages read as global")
		let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(list[1])) as? [String: Any]
		XCTAssertEqual(encoded?.keys.sorted(), ["id", "label", "text"], "a global message encodes no projectId")
	}

	func testFileStatsUseTheAgentRoute() async {
		let sent = await requests(reply: #"{"files":[]}"#) { _ = try await $0.statFiles(sessionId: "example", paths: ["/path/to/project/out.png"]) }
		assertShape(sent, "POST", "/api/agent/sessions/example/files", keys: ["paths"])
	}

	func testFileBytesUseTheAgentRoute() async {
		let sent = await requests { _ = try await $0.fileData(sessionId: "example", path: "notes.md") }
		assertShape(sent, "GET", "/api/agent/sessions/example/files", query: "path=notes.md")
	}

	func testDirListingUsesTheAgentRoute() async {
		let reply = #"{"path":"src","root":"/path/to/project","entries":[],"truncated":false}"#
		let sent = await requests(reply: reply) { _ = try await $0.listDir(sessionId: "example", path: "src") }
		assertShape(sent, "GET", "/api/agent/sessions/example/dir", query: "path=src")
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

	// MARK: - Server settings

	private static let redactedSettings = #"""
	{"speech":{"ttsUrl":"http://127.0.0.1:3000","sttUrl":"http://127.0.0.1:3000","voice":"example"},
	"operator":{"url":"http://127.0.0.1:3001/v1","model":"example-model","provider":"openai","apiKeyFile":"/path/to/key-file","hasApiKey":true},
	"modelProfiles":[{"id":"local","label":"Local","model":"example","envKeys":["ANTHROPIC_BASE_URL"]}],
	"lastModels":{"claude":{"model":"opus"}},"lastEffort":"high",
	"zedSshTarget":"user@example.test","autoCompact":{"enabled":true,"percent":85}}
	"""#

	func testRedactedServerSettingsDecode() throws {
		let s = try JSONDecoder().decode(ServerSettings.self, from: Data(Self.redactedSettings.utf8))
		XCTAssertEqual(s.speech, SpeechServerSettings(ttsUrl: "http://127.0.0.1:3000", sttUrl: "http://127.0.0.1:3000", voice: "example"))
		XCTAssertEqual(s.operator?.provider, .openai)
		XCTAssertEqual(s.operator?.hasApiKey, true)
		XCTAssertEqual(s.operator?.apiKeyFile, "/path/to/key-file")
		XCTAssertEqual(s.modelProfiles?.first?.envKeys, ["ANTHROPIC_BASE_URL"])
		XCTAssertEqual(s.zedSshTarget, "user@example.test")
		XCTAssertEqual(s.autoCompact, AutoCompactSettings(enabled: true, percent: 85))

		let empty = try JSONDecoder().decode(ServerSettings.self, from: Data("{}".utf8))
		XCTAssertNil(empty.operator)
		let unknownProvider = try JSONDecoder().decode(OperatorServerSettings.self, from: Data(#"{"provider":"other"}"#.utf8))
		XCTAssertNil(unknownProvider.provider)
		XCTAssertFalse(unknownProvider.hasApiKey)
	}

	func testServerSettingsReadTheAgentRoute() async {
		let sent = await requests(reply: Self.redactedSettings) { _ = try await $0.serverSettings() }
		assertShape(sent, "GET", "/api/agent/settings")
	}

	func testEachServerSettingsSaveSendsOnlyItsBlock() async {
		let saves: [(ServerSettingsPatch, String)] = [
			(.speech(SpeechServerSettings(ttsUrl: " http://127.0.0.1:3000 ")), "speech"),
			(.operator(url: "", model: "", provider: nil, apiKeyFile: "", key: .keep), "operator"),
			(.autoCompact(AutoCompactSettings(enabled: true, percent: 80)), "autoCompact"),
			(.zedSshTarget("user@example.test"), "zedSshTarget")
		]
		for (patch, block) in saves {
			let sent = await requests(reply: "{}") { try await $0.patchServerSettings(patch) }
			assertShape(sent, "PATCH", "/api/agent/settings", keys: [block])
		}
		let speech = await requests(reply: "{}") { try await $0.patchServerSettings(.speech(SpeechServerSettings(ttsUrl: " http://127.0.0.1:3000 "))) }
		let block = (speech.first?.json as? [String: Any])?["speech"] as? [String: Any]
		XCTAssertEqual(block?["ttsUrl"] as? String, "http://127.0.0.1:3000")
		XCTAssertEqual(block?["sttUrl"] as? String, "", "a blank field clears on the server")
	}

	private func operatorBlock(_ key: OperatorKeyChange) async -> [String: Any]? {
		let sent = await requests(reply: "{}") {
			try await $0.patchServerSettings(.operator(url: "http://127.0.0.1:3001/v1", model: "m", provider: nil, apiKeyFile: "", key: key))
		}
		return (sent.first?.json as? [String: Any])?["operator"] as? [String: Any]
	}

	func testOperatorKeyIsSentOnlyWhenReplacedOrRemoved() async {
		let kept = await operatorBlock(.keep)
		XCTAssertEqual(kept?.keys.sorted(), ["apiKeyFile", "model", "provider", "url"], "no apiKey: the stored key is kept")
		XCTAssertTrue(kept?["provider"] is NSNull, "no provider: read from the URL")

		let replaced = await operatorBlock(.replace(" example-key "))
		XCTAssertEqual(replaced?["apiKey"] as? String, "example-key")

		let removed = await operatorBlock(.remove)
		XCTAssertTrue(removed?.keys.contains("apiKey") == true)
		XCTAssertTrue(removed?["apiKey"] is NSNull)
	}

	func testAutoCompactIsClampedAndABlankZedTargetClears() {
		let compact = ServerSettingsPatch.autoCompact(AutoCompactSettings(enabled: true, percent: 99)).json["autoCompact"] as? [String: Any]
		XCTAssertEqual(compact?["percent"] as? Int, 95)
		XCTAssertEqual(AutoCompactSettings.clamp(10), 50)
		XCTAssertTrue(ServerSettingsPatch.zedSshTarget("  ").json["zedSshTarget"] is NSNull)
	}

	@MainActor
	func testTheModelSendsTheKeyOnlyWhenTypedAndKeepsOtherDrafts() async {
		let recorder = Recorder()
		RequestStub.status = 200
		RequestStub.handler = { request in
			let data = Self.bodyData(request)
			let json = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)
			recorder.sent.append(Sent(method: request.httpMethod ?? "GET", path: request.url?.path ?? "", query: nil, accept: nil, contentType: nil, keys: (json as? [String: Any]).map { $0.keys.sorted() }, json: json))
			if request.url?.path == "/api/agent/settings/skill" { return Data("[]".utf8) }
			return Data(Self.redactedSettings.utf8)
		}
		let model = ServerSettingsModel(client: Self.stubbedClient())
		await model.load()
		XCTAssertTrue(model.hasApiKey)
		XCTAssertEqual(model.newApiKey, "", "the stored key is never fetched into the form")

		model.zedSshTarget = "unsaved@example.test"
		model.operatorModel = "other-model"
		await model.saveOperator()
		var body = (recorder.sent.last?.json as? [String: Any])?["operator"] as? [String: Any]
		XCTAssertEqual(recorder.sent.last?.keys, ["operator"])
		XCTAssertNil(body?["apiKey"])
		XCTAssertEqual(model.zedSshTarget, "unsaved@example.test", "saving one block leaves another's draft alone")

		model.replacingKey = true
		model.newApiKey = "example-key"
		await model.saveOperator()
		body = (recorder.sent.last?.json as? [String: Any])?["operator"] as? [String: Any]
		XCTAssertEqual(body?["apiKey"] as? String, "example-key")
		XCTAssertEqual(model.newApiKey, "", "cleared once saved")
		XCTAssertFalse(model.replacingKey)

		await model.removeApiKey()
		body = (recorder.sent.last?.json as? [String: Any])?["operator"] as? [String: Any]
		XCTAssertTrue(body?["apiKey"] is NSNull)
	}

	func testSpeechDetectAndSkillInstallUseTheAgentRoutes() async {
		let detect = await requests(reply: #"{"found":false}"#) { _ = try await $0.detectSpeechServer() }
		assertShape(detect, "POST", "/api/agent/settings/speech/detect", keys: [])
		let list = await requests(reply: "[]") { _ = try await $0.skillStatuses() }
		assertShape(list, "GET", "/api/agent/settings/skill")
		let install = await requests(reply: #"{"kind":"claude","available":true,"supported":true,"installed":true,"installedVersion":"1","shippedVersion":"1","upToDate":true}"#) {
			_ = try await $0.installSkill(kind: "claude")
		}
		assertShape(install, "POST", "/api/agent/settings/skill", keys: ["kind"])
	}

	func testSkillStatusSummaries() throws {
		let rows = try JSONDecoder().decode([SkillInstallStatus].self, from: Data(#"""
		[{"kind":"claude","available":true,"supported":true,"installed":true,"installedVersion":"1","shippedVersion":"2","upToDate":false},
		{"kind":"codex","available":false,"supported":true,"installed":false,"installedVersion":null,"shippedVersion":"2","upToDate":false},
		{"kind":"pi","available":true,"supported":true,"installed":false,"installedVersion":null,"shippedVersion":"2","upToDate":false}]
		"""#.utf8))
		XCTAssertEqual(rows.map(\.summary), ["v1 installed, v2 available", "Not installed on the server", "Skill not installed"])
		XCTAssertEqual(rows.map(\.canInstall), [true, false, true])
	}

	// MARK: - Projects (plan item P17a)

	private static let record = #"{"path":"/path/to/project","name":"example","group":"apps"}"#

	func testRegisteringAProjectPostsOnlyWhatWasGiven() async {
		let sent = await requests(reply: Self.record, status: 201) { _ = try await $0.registerProject(path: "~/code/example", name: " ", group: "apps") }
		assertShape(sent, "POST", "/api/agent/projects", keys: ["group", "path"])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["path"] as? String, "~/code/example")
	}

	func testEditingAProjectPatchesOnlyTheChangedFields() async {
		let original = ProjectDraft(name: "example", group: "apps", template: "fix [issue_id]", reviewPrompt: "")
		var draft = original
		draft.group = ""
		draft.reviewPrompt = "review [pr_url] "
		let sent = await requests(reply: Self.record) { _ = try await $0.updateProject(path: "/path/to/project", changes: draft.changes(from: original)) }
		assertShape(sent, "PATCH", "/api/agent/projects/config", keys: ["group", "path", "reviewPrompt"])
		let body = sent.first?.json as? [String: Any]
		XCTAssertEqual(body?["group"] as? String, "", "a blank clears the group")
		XCTAssertEqual(body?["reviewPrompt"] as? String, "review [pr_url]")
	}

	func testCloningPostsTheUrlAndParent() async {
		let sent = await requests(reply: Self.record, status: 201) {
			_ = try await $0.cloneProject(url: "https://github.com/acme/repo.git", parent: "~/code", name: "repo", group: nil)
		}
		assertShape(sent, "POST", "/api/agent/projects/clone", keys: ["name", "parent", "url"])
	}

	func testRemovingAProjectDeletesItByPath() async {
		let sent = await requests { try await $0.removeProject(path: "/path/to/project") }
		assertShape(sent, "DELETE", "/api/agent/projects", query: "path=/path/to/project")
	}

	func testFolderSuggestionsUseTheAgentRoute() async {
		let sent = await requests(reply: #"["~/code/example"]"#) { _ = try await $0.completePath("~/code/ex") }
		assertShape(sent, "GET", "/api/agent/fs/complete", query: "q=~/code/ex")
	}

	func testAServerRefusalIsShownAsItWasSent() async {
		var thrown: Error?
		_ = await requests(reply: #"{"message":"path must be under your home directory"}"#, status: 403) {
			do { _ = try await $0.registerProject(path: "/elsewhere") } catch { thrown = error; throw error }
		}
		XCTAssertEqual(thrown.map(DeckError.message(for:)), "path must be under your home directory")
	}

	@MainActor
	func testAProjectEditWithNoChangesSendsNothing() async throws {
		let sent = await requests { client in
			let store = DeckStore(client: client)
			try await store.updateProject(path: "/path/to/project", changes: [:])
		}
		XCTAssertTrue(sent.isEmpty)
	}

	// MARK: - Dev config (plan item P17b)

	func testSavingTheDevConfigPatchesOnlyDev() async {
		let dev = DevConfig(
			copyFromMain: ["apps/api/.env.local"],
			setup: [DevSetupStep(label: "install", run: "pnpm i")],
			servers: [DevServer(name: "web", run: "pnpm dev", setup: [], ports: [DevPort(port: 5173, primary: true)], readyPattern: #"Local:\s+(http\S+)"#)])
		let sent = await requests(reply: Self.record) { _ = try await $0.saveDevConfig(path: "/path/to/project", dev: dev) }
		assertShape(sent, "PATCH", "/api/agent/projects/config", keys: ["dev", "path"])
		let body = (sent.first?.json as? [String: Any])?["dev"] as? [String: Any]
		XCTAssertEqual(Set(body?.keys.map { $0 } ?? []), ["copyFromMain", "setup", "servers"])
		let server = (body?["servers"] as? [[String: Any]])?.first
		XCTAssertEqual(Set(server?.keys.map { $0 } ?? []), ["name", "run", "setup", "ports", "readyPattern"], "blank optionals are left out")
		XCTAssertEqual(server?["readyPattern"] as? String, #"Local:\s+(http\S+)"#)
		XCTAssertEqual((server?["ports"] as? [[String: Any]])?.first?["port"] as? Int, 5173)
	}

	func testADevConfigRefusalIsShownAsItWasSent() async {
		var thrown: Error?
		_ = await requests(reply: #"{"message":"duplicate server name: web"}"#, status: 400) {
			do { _ = try await $0.saveDevConfig(path: "/path/to/project", dev: DevConfig()) } catch { thrown = error; throw error }
		}
		XCTAssertEqual(thrown.map(DeckError.message(for:)), "duplicate server name: web")
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
	func testPairingListUsesTheAgentRoute() async {
		let sent = await requests(reply: #"{"pending":[]}"#) { _ = try await $0.pairingRequests() }
		assertShape(sent, "GET", "/api/agent/pairing")
	}

	func testDecidingAPairingPostsApproveAlone() async {
		let sent = await requests { _ = try await $0.decidePairing(id: "pair_a", approve: false) }
		assertShape(sent, "POST", "/api/agent/pairing/pair_a", keys: ["approve"])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["approve"] as? Bool, false)
	}

	func testReviewsUseTheAgentRoute() async throws {
		let reply = #"{"status":"ok","updatedAt":"2026-01-01T00:00:00Z","inFlight":{"repo":"acme/web","pr":4,"headSha":"abc","phase":"model","startedAt":"2026-01-01T00:00:00Z"},"recent":[{"repo":"acme/web","pr":3,"headSha":"def","decision":"REQUEST_CHANGES","reviewId":11,"url":"https://example.test/r/11","reviewedAt":"2026-01-01T00:00:00Z"}],"recentErrors":[{"repo":"acme/web","pr":2,"headSha":"0a1","phase":"prepare","message":"no diff","url":"https://example.test/pr/2","failedAt":"2026-01-01T00:00:00Z"}]}"#
		var decoded: ReviewsSnapshot?
		let sent = await requests(reply: reply) { decoded = try await $0.reviews() }
		assertShape(sent, "GET", "/api/agent/reviews")
		let reviews = try XCTUnwrap(decoded)
		XCTAssertEqual(reviews.inFlight?.phaseLabel, "Reviewing")
		XCTAssertEqual(reviews.recent.first?.decisionLabel, "Changes requested")
		XCTAssertEqual(reviews.recentErrors.first?.phaseLabel, "Preparation")
		XCTAssertTrue(reviews.isShown)
	}

	@MainActor
	func testAPairingEventAddsARequestAndADecisionRemovesIt() async throws {
		_ = await requests { _ in }
		let store = DeckStore(client: Self.stubbedClient())
		let asked = try JSONDecoder().decode(EventsResponse.self, from: Data("""
		{ "events": [{ "seq": 1, "sessionId": "pair_a", "type": "pairing", "pairingId": "pair_a", "code": "123456", "state": "pending" },
		             { "seq": 2, "sessionId": "pair_b", "type": "pairing", "pairingId": "pair_b", "code": "654321", "state": "pending" }], "seq": 2 }
		""".utf8))
		store.apply(asked)
		store.apply(asked)
		XCTAssertEqual(store.pairingRequests, [PairingRequest(id: "pair_a", code: "123456"), PairingRequest(id: "pair_b", code: "654321")], "a repeated event is applied once")

		try await store.decidePairing(id: "pair_a", approve: true)
		XCTAssertEqual(store.pairingRequests.map(\.id), ["pair_b"])

		let decidedElsewhere = try JSONDecoder().decode(EventsResponse.self, from: Data("""
		{ "events": [{ "seq": 3, "sessionId": "pair_b", "type": "pairing", "pairingId": "pair_b", "state": "denied" }], "seq": 3 }
		""".utf8))
		store.apply(decidedElsewhere)
		XCTAssertTrue(store.pairingRequests.isEmpty)
	}

	// MARK: - Issue sources (plan item P18)

	func testAGithubSourcePostsOwnerAndRepo() async {
		let sent = await requests(reply: #"{"id":"src_1","type":"github","owner":"acme","repo":"web"}"#, status: 201) {
			try await $0.addIssueSource(projectPath: "/path/to/project", body: IssueSourceBody.github(owner: " acme ", repo: "web"))
		}
		assertShape(sent, "POST", "/api/agent/projects/sources", keys: ["owner", "projectPath", "repo", "type"])
		let body = sent.first?.json as? [String: Any]
		XCTAssertEqual(body?["owner"] as? String, "acme")
		XCTAssertEqual(body?["type"] as? String, "github")
	}

	func testALinearSourceWithANewKeyPostsTheKey() async {
		let body = IssueSourceBody.linear(
			key: .new("example-key"), teamId: "team_1", teamName: "Example", assigneeEmail: "someone@example.com", stateIds: ["s1"])
		let sent = await requests(reply: #"{"id":"src_2","type":"linear"}"#, status: 201) {
			try await $0.addIssueSource(projectPath: "/path/to/project", body: body)
		}
		assertShape(sent, "POST", "/api/agent/projects/sources", keys: [
			"apiKey", "assigneeEmail", "projectPath", "stateIds", "teamId", "teamName", "type"
		])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["stateIds"] as? [String], ["s1"])
	}

	func testAClickupSourcePostsItsPlaceAndANumericAssignee() async {
		var place = IssueSourceBody.ClickupPlace()
		place.teamId = "t1"; place.teamName = "Acme"
		place.spaceId = "sp1"; place.spaceName = "Eng"
		place.folderId = "f1"; place.folderName = "Sprint"
		place.listId = "l1"; place.listName = "Backlog"
		let body = IssueSourceBody.clickup(
			key: .saved("cred_1"), place: place, statuses: ["to do"], assigneeUserId: 42, assigneeName: "someone")
		let sent = await requests(reply: #"{"id":"src_3","type":"clickup"}"#, status: 201) {
			try await $0.addIssueSource(projectPath: "/path/to/project", body: body)
		}
		assertShape(sent, "POST", "/api/agent/projects/sources", keys: [
			"assigneeName", "assigneeUserId", "credentialId", "folderId", "folderName", "listId", "listName",
			"projectPath", "spaceId", "spaceName", "statuses", "teamId", "teamName", "type"
		])
		XCTAssertEqual((sent.first?.json as? [String: Any])?["assigneeUserId"] as? Int, 42)

		place.folderId = ""
		let folderless = IssueSourceBody.clickup(key: .saved("cred_1"), place: place, statuses: [], assigneeUserId: 42, assigneeName: "")
		XCTAssertNil(folderless["folderId"], "a folderless list sends no folder")
		XCTAssertNil(folderless["folderName"])
	}

	func testAKeyNeverPrints() {
		XCTAssertFalse(String(describing: IssueSourceKey.new("example-key")).contains("example-key"))
	}

	func testSavedCredentialsAreListedByType() async throws {
		var list: [SavedCredential] = []
		let sent = await requests(reply: #"[{"id":"cred_1","type":"linear","label":"someone@example.com","projects":["example"]}]"#) {
			list = try await $0.issueCredentials(type: .linear)
		}
		assertShape(sent, "GET", "/api/agent/credentials", query: "type=linear")
		XCTAssertEqual(list.first?.displayLabel, "someone@example.com, used by example")
	}

	func testLookupRequestShapes() async {
		let cases: [(IssueSourceType, String, [String: String], [String])] = [
			(.linear, "me", [:], ["action", "apiKey", "type"]),
			(.linear, "teams", [:], ["action", "apiKey", "type"]),
			(.linear, "states", ["teamId": "t1"], ["action", "apiKey", "teamId", "type"]),
			(.clickup, "spaces", ["teamId": "t1"], ["action", "apiKey", "teamId", "type"]),
			(.clickup, "folders", ["spaceId": "sp1"], ["action", "apiKey", "spaceId", "type"]),
			(.clickup, "lists", ["folderId": "f1"], ["action", "apiKey", "folderId", "type"]),
			(.clickup, "statuses", ["listId": "l1"], ["action", "apiKey", "listId", "type"])
		]
		for (type, action, params, keys) in cases {
			let sent = await requests(reply: "[]") {
				let _: [ClickupStatus] = try await $0.issueSourceLookup(type: type, action: action, key: .new("example-key"), params: params)
			}
			assertShape(sent, "POST", "/api/agent/projects/sources/lookup", keys: keys)
			let body = sent.first?.json as? [String: Any]
			XCTAssertEqual(body?["action"] as? String, action)
			XCTAssertEqual(body?["type"] as? String, type.rawValue)
		}
	}

	func testRemovingASourceDeletesItByProjectAndId() async {
		let sent = await requests { try await $0.removeIssueSource(projectPath: "/path/to/project", id: "src_1") }
		assertShape(sent, "DELETE", "/api/agent/projects/sources", query: "project=/path/to/project&id=src_1")
	}

	func testAProjectsSourcesReadItsRecord() async throws {
		var sources: [IssueSource] = []
		let sent = await requests(reply: #"{"path":"/path/to/project","name":"example","sources":[{"id":"a","type":"github","owner":"acme","repo":"web"},{"id":"b","type":"linear","teamId":"t","teamName":"Example","assigneeEmail":"","stateIds":["1","2"]},{"id":"c","type":"clickup","listName":"Backlog","statuses":["to do"],"assigneeUserId":1}]}"#) {
			sources = try await $0.issueSources(projectPath: "/path/to/project")
		}
		assertShape(sent, "GET", "/api/agent/projects/config", query: "path=/path/to/project")
		XCTAssertEqual(sources.map(\.summary), ["acme/web", "Example · 2 state(s)", "Backlog · 1 status(es)"])
	}

	/// Answers each cascade step the way the server's lookups do.
	private func cascade(_ recorder: Recorder, status: Int = 200, credentials: String) {
		RequestStub.status = status
		RequestStub.handler = { request in
			let data = Self.bodyData(request)
			let json = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)
			recorder.sent.append(Sent(method: request.httpMethod ?? "GET", path: request.url?.path ?? "", query: request.url?.query, accept: nil, contentType: nil, keys: (json as? [String: Any]).map { $0.keys.sorted() }, json: json))
			if status != 200 { return Data(#"{"message":"Linear: authentication failed"}"#.utf8) }
			if request.url?.path == "/api/agent/credentials" { return Data(credentials.utf8) }
			let action = (json as? [String: Any])?["action"] as? String
			let replies = [
				"me": #"{"name":"Someone","email":"someone@example.com","id":42,"username":"someone"}"#,
				"teams": #"[{"id":"t1","name":"Example","key":"EX"}]"#,
				"states": #"[{"id":"s1","name":"Todo","type":"unstarted"},{"id":"s2","name":"Done","type":"completed"}]"#,
				"spaces": #"[{"id":"sp1","name":"Eng"}]"#,
				"folders": #"[{"id":"f1","name":"Sprint"}]"#,
				"lists": #"[{"id":901,"name":"Backlog"}]"#,
				"statuses": #"[{"status":"to do","type":"open"},{"status":"in progress","type":"custom"}]"#
			]
			return Data((action.flatMap { replies[$0] } ?? #"{"id":"src","type":"linear"}"#).utf8)
		}
	}

	@MainActor
	func testReusingASavedKeySendsNoApiKey() async {
		let recorder = Recorder()
		cascade(recorder, credentials: #"[{"id":"cred_1","type":"clickup","label":"someone","projects":["example"]}]"#)
		let setup = IssueSourceSetup(client: Self.stubbedClient(), type: .clickup)
		await setup.start()
		XCTAssertEqual(setup.credentialId, "cred_1", "the first saved key is picked")
		await setup.connect()
		await setup.selectClickupTeam("t1")
		await setup.selectClickupSpace("sp1")
		await setup.selectClickupFolder("f1")
		await setup.selectClickupList("901")
		XCTAssertEqual(setup.clickupSelected, ["to do"])
		let saved = await setup.save(projectPath: "/path/to/project")
		XCTAssertTrue(saved)

		let posts = recorder.sent.filter { $0.method == "POST" }
		XCTAssertEqual(posts.compactMap { ($0.json as? [String: Any])?["action"] as? String },
			["me", "teams", "spaces", "folders", "lists", "lists", "statuses"])
		XCTAssertTrue(posts.allSatisfy { $0.keys?.contains("apiKey") == false }, "a reused key is never sent")
		XCTAssertTrue(posts.allSatisfy { $0.keys?.contains("credentialId") == true })
		let source = posts.last?.json as? [String: Any]
		XCTAssertEqual(source?["listId"] as? String, "901")
		XCTAssertEqual(source?["folderName"] as? String, "Sprint")
		XCTAssertEqual(source?["assigneeUserId"] as? Int, 42)
	}

	@MainActor
	func testATypedKeyIsSentForTheCascadeThenDropped() async {
		let recorder = Recorder()
		cascade(recorder, credentials: "[]")
		let setup = IssueSourceSetup(client: Self.stubbedClient(), type: .linear)
		await setup.start()
		XCTAssertEqual(setup.credentialId, "")
		setup.apiKey = "example-key"
		await setup.connect()
		await setup.selectLinearTeam("t1")
		XCTAssertEqual(setup.linearStateIds, ["s1"], "unstarted states are preselected")
		let saved = await setup.save(projectPath: "/path/to/project")
		XCTAssertTrue(saved)
		XCTAssertEqual(setup.apiKey, "", "the key is gone once the server has it")

		let source = recorder.sent.last?.json as? [String: Any]
		XCTAssertEqual(recorder.sent.last?.path, "/api/agent/projects/sources")
		XCTAssertEqual(source?["apiKey"] as? String, "example-key")
		XCTAssertNil(source?["credentialId"])
		XCTAssertEqual(source?["assigneeEmail"] as? String, "someone@example.com")
		XCTAssertEqual(source?["teamName"] as? String, "Example")
	}

	@MainActor
	func testAProviderErrorIsShownAsReturned() async {
		let recorder = Recorder()
		cascade(recorder, status: 400, credentials: "[]")
		let setup = IssueSourceSetup(client: Self.stubbedClient(), type: .linear)
		setup.apiKey = "example-key"
		await setup.connect()
		XCTAssertFalse(setup.connected)
		XCTAssertEqual(setup.errorMessage, "Linear: authentication failed")
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
