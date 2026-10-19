import XCTest
@testable import DeckKit

private final class RequestStub: URLProtocol {
	static var handler: ((URLRequest) throws -> Data)?
	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		do {
			let data = try Self.handler!(request)
			client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
			client?.urlProtocol(self, didLoad: data)
			client?.urlProtocolDidFinishLoading(self)
		} catch {
			client?.urlProtocol(self, didFailWithError: error)
		}
	}
	override func stopLoading() {}
}

final class ParityTests: XCTestCase {
	private func client(check: @escaping (URLRequest, [String: Any]) -> Void) -> DeckClient {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RequestStub.self]
		RequestStub.handler = { request in
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
			let body = try JSONSerialization.jsonObject(with: data) as! [String: Any]
			check(request, body)
			return Data(#"{"id":"example","ok":true}"#.utf8)
		}
		return DeckClient(credentials: Credentials(baseURL: URL(string: "https://example.test")!, token: "example-token"), configuration: configuration)
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
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [RequestStub.self]
		RequestStub.handler = { request in
			XCTAssertEqual(request.url?.path, "/api/agent/defaults")
			XCTAssertEqual(request.url?.query, "project=/path/to/project")
			return Data(#"{"path":"/path/to/project","base":"main","prompts":{"work":"Fix [issue_body]"},"kinds":{"claude":{"model":"sonnet","effort":"high","permissionMode":"bypassPermissions"},"pi":{"model":"gpt","provider":"openai"}}}"#.utf8)
		}
		let client = DeckClient(credentials: Credentials(baseURL: URL(string: "https://example.test")!, token: "example-token"), configuration: configuration)
		let project = try await client.startDefaults(project: "/path/to/project")
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

	func testAutomationSavePreservesTheProjectName() async throws {
		let client = client { request, body in
			XCTAssertEqual(request.url?.path, "/api/projects")
			XCTAssertEqual(body["name"] as? String, "Web")
			let automation = body["automation"] as? [String: Any]
			XCTAssertEqual(automation?["work"] as? Bool, true)
			XCTAssertEqual((automation?["reviewAgent"] as? [String: Any])?.isEmpty, true, "an untouched claude lane clears to the default")
			XCTAssertEqual((automation?["workAgent"] as? [String: Any])?["model"] as? String, "gpt-5")
			XCTAssertNil((automation?["workAgent"] as? [String: Any])?["effort"], "effort is claude-only")
		}
		let project = ProjectDetail(path: "/path/to/project", name: "Web", group: nil, automation: nil)
		let automation = ProjectAutomation(work: true, review: false, workAgent: AutomationAgent(kind: "codex", model: "gpt-5", effort: "high"), reviewAgent: AutomationAgent())
		_ = try? await client.saveAutomation(project: project, automation: automation)
	}
}
