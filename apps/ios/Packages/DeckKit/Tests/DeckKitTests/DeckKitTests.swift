import XCTest
@testable import DeckKit

final class DeckKitTests: XCTestCase {
	func testDecodeSessionDigest() throws {
		let json = """
		[{
			"id": "c_abc123", "url": "http://localhost:4818/s/c_abc123",
			"kind": "claude", "title": "Fix login", "cwd": "/path/to/worktree",
			"status": "running", "awaitingInput": false,
			"createdAt": 1752900000000, "lastActiveAt": 1752900500000, "model": "opus",
			"worktree": { "repo": "/path/to/project", "branch": "fix-login", "createdBranch": true, "base": "main" },
			"issues": [{ "source": "github", "id": "acme/app#1", "url": "https://example.com" }],
			"pr": { "repo": "acme/app", "number": 42, "url": "https://example.com", "state": "open",
				"reviewDecision": "APPROVED", "mergeable": "MERGEABLE", "approvals": 1, "changesRequested": 0 },
			"cost": { "costUsd": 0.42, "turns": 12, "durationMs": 258000, "results": 12 }
		}]
		"""
		let sessions = try JSONDecoder().decode([SessionDigest].self, from: Data(json.utf8))
		XCTAssertEqual(sessions.count, 1)
		XCTAssertEqual(sessions[0].id, "c_abc123")
		XCTAssertEqual(sessions[0].status, .running)
		XCTAssertEqual(sessions[0].issues?.first?.issueId, "acme/app#1")
		XCTAssertEqual(sessions[0].pr?.number, 42)
	}

	func testGitHubIssueIdShortensForDisplay() {
		let github = DeckIssue(source: "github", issueId: "acme/app#1")
		XCTAssertEqual(github.shortId, "#1")
		XCTAssertEqual(github.repo, "acme/app")
		XCTAssertEqual(github.issueId, "acme/app#1", "the identifier itself must not change")
	}

	func testNonGitHubIssueIdsPassThrough() {
		let linear = DeckIssue(source: "linear", issueId: "ABC-123")
		XCTAssertEqual(linear.shortId, "ABC-123")
		XCTAssertNil(linear.repo)

		let clickup = DeckIssue(source: "clickup", issueId: "#abc123")
		XCTAssertEqual(clickup.shortId, "#abc123")
		XCTAssertNil(clickup.repo)
	}

	func testMalformedGitHubIdIsLeftAlone() {
		// No number after the hash, or no hash at all: nothing safe to shorten to.
		XCTAssertEqual(DeckIssue(source: "github", issueId: "acme/app#").shortId, "acme/app#")
		XCTAssertEqual(DeckIssue(source: "github", issueId: "acme/app#x1").shortId, "acme/app#x1")
		XCTAssertEqual(DeckIssue(source: "github", issueId: "acme/app").shortId, "acme/app")
		XCTAssertNil(DeckIssue(source: "github", issueId: "acme/app").repo)
	}

	private func events(_ json: String) -> [JSONValue] {
		JSONValue.parse(Data(json.utf8))?.array ?? []
	}

	func testTranscriptPairsToolCallsWithResults() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[
			{ "type": "deck.user", "text": "fix the build" },
			{ "type": "assistant", "message": { "content": [
				{ "type": "text", "text": "Looking now." },
				{ "type": "tool_use", "id": "t1", "name": "Bash",
					"input": { "command": "pnpm build", "description": "Build the app" } }
			] } },
			{ "type": "user", "message": { "content": [
				{ "type": "tool_result", "tool_use_id": "t1", "content": "boom", "is_error": true }
			] } }
		]
		"""))

		XCTAssertEqual(builder.items.count, 3)
		guard case let .user(_, prompt, _) = builder.items[0] else { return XCTFail("user bubble") }
		XCTAssertEqual(prompt, "fix the build")
		guard case .assistant = builder.items[1] else { return XCTFail("assistant bubble") }
		guard case let .tool(call) = builder.items[2] else { return XCTFail("tool card") }
		XCTAssertEqual(call.name, "Bash")
		XCTAssertEqual(call.command, "pnpm build")
		XCTAssertEqual(call.headerArg, "Build the app")
		XCTAssertEqual(call.output, "boom")
		XCTAssertTrue(call.isError)
	}

	func testToolResultBlocksNeverBecomeUserBubbles() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[{ "type": "user", "message": { "content": [
			{ "type": "tool_result", "tool_use_id": "gone", "content": "orphan" }
		] } }]
		"""))
		XCTAssertTrue(builder.items.isEmpty, "a result with no matching call renders nothing")
	}

	func testToolHeadersMatchTheTool() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[{ "type": "assistant", "message": { "content": [
			{ "type": "tool_use", "id": "a", "name": "Read",
				"input": { "file_path": "/tmp/one/two/three/four/five.ts", "offset": 10, "limit": 20 } },
			{ "type": "tool_use", "id": "b", "name": "Grep", "input": { "pattern": "TODO" } },
			{ "type": "tool_use", "id": "c", "name": "TodoWrite", "input": { "todos": [
				{ "content": "one", "status": "completed" }, { "content": "two", "status": "in_progress" }
			] } }
		] } }]
		"""))

		let calls: [ToolCall] = builder.items.compactMap {
			if case let .tool(call) = $0 { return call }
			return nil
		}
		XCTAssertEqual(calls.count, 3)
		XCTAssertEqual(calls[0].headerArg, "…/three/four/five.ts:10+20")
		XCTAssertEqual(calls[1].headerArg, "TODO")
		XCTAssertEqual(calls[2].headerArg, "2 items")
		XCTAssertEqual(calls[2].todos.first?.isDone, true)
		XCTAssertEqual(calls[2].todos.last?.isActive, true)
	}

	func testStreamingEventsAndNoiseAreSkipped() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[
			{ "type": "system", "subtype": "init" },
			{ "type": "stream_event", "event": { "type": "content_block_delta" } },
			{ "type": "assistant", "message": { "content": [{ "type": "text", "text": "   " }] } },
			{ "type": "deck.effort", "effort": "high" }
		]
		"""))
		XCTAssertEqual(builder.items.count, 1, "only the effort notice is renderable")
		guard case let .notice(_, text, level) = builder.items[0] else { return XCTFail("notice") }
		XCTAssertEqual(text, "thinking → high")
		XCTAssertEqual(level, .info)
	}

	func testTurnFootersWarningsAndErrorsRenderAsNotices() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[
			{ "type": "result", "duration_ms": 12345, "num_turns": 4, "total_cost_usd": 0.0123, "subtype": "success" },
			{ "type": "result", "subtype": "error_max_turns" },
			{ "type": "deck.warning", "text": "Issue context could not be fetched" },
			{ "type": "deck.error", "text": "agent exited" }
		]
		"""))
		let notices: [(String, NoticeLevel)] = builder.items.compactMap {
			if case let .notice(_, text, level) = $0 { return (text, level) }
			return nil
		}
		XCTAssertEqual(notices.map(\.0), ["12.3s · 4 turns · $0.0123", "error_max_turns", "Issue context could not be fetched", "agent exited"])
		XCTAssertEqual(notices.map(\.1), [.info, .info, .warning, .error])
	}

	func testUserMessagesCarryTheirAttachments() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[
			{ "type": "deck.user", "text": "", "images": [{ "file": "abc.png", "media_type": "image/png" }] },
			{ "type": "deck.user", "text": "see this", "images": [{ "media_type": "image/jpeg", "data": "aGVsbG8=" }] }
		]
		"""))
		XCTAssertEqual(builder.items.count, 2, "an image-only message still renders")
		guard case let .user(_, _, stored) = builder.items[0] else { return XCTFail("user bubble") }
		XCTAssertEqual(stored, [TranscriptImage(file: "abc.png", mediaType: "image/png")])
		guard case let .user(_, text, inline) = builder.items[1] else { return XCTFail("user bubble") }
		XCTAssertEqual(text, "see this")
		XCTAssertEqual(inline.first?.data, "aGVsbG8=")
	}

	func testAskCallsShowTheirQuestionsAndRecordedAnswers() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[
			{ "type": "assistant", "message": { "content": [
				{ "type": "tool_use", "id": "toolu_1", "name": "mcp__deck__ask", "input": { "questions": [
					{ "question": "How?", "header": "Approach", "multiSelect": false, "options": [{ "label": "Rewrite" }, { "label": "Patch", "description": "minimal" }] }
				] } }
			] } }
		]
		"""))
		guard case let .tool(pending) = builder.items[0] else { return XCTFail("ask card") }
		XCTAssertTrue(pending.isAsk)
		XCTAssertEqual(pending.questions.first?.options?.map(\.label), ["Rewrite", "Patch"])
		XCTAssertNil(pending.answers)
		XCTAssertFalse(pending.showsRawInput)

		builder.append(contentsOf: events("""
		[{ "type": "deck.answer", "answersFor": "toolu_1", "answers": [{ "header": "Approach", "labels": ["Patch"] }] }]
		"""))
		guard case let .tool(answered) = builder.items[0] else { return XCTFail("ask card") }
		XCTAssertEqual(answered.answers, [StructuredAnswer(header: "Approach", labels: ["Patch"])])
		XCTAssertEqual(builder.items.count, 1, "the answer marker renders on the card, not as a row")
	}

	func testOlderHistoryPrependsWithoutRenumberingLoadedRows() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[
			{ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }] } },
			{ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Done." }] } }
		]
		"""), startIndex: 5)
		XCTAssertEqual(builder.items.map(\.id), ["6:0"], "ids come from absolute indexes")
		XCTAssertEqual(builder.nextIndex, 7)

		builder.prepend(contentsOf: events("""
		[
			{ "type": "deck.user", "text": "start" },
			{ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }
		]
		"""), startIndex: 3)
		XCTAssertEqual(builder.items.map(\.id), ["3", "tool-t1", "6:0"])
		XCTAssertEqual(builder.startIndex, 3)
		guard case let .tool(call) = builder.items[1] else { return XCTFail("tool card") }
		XCTAssertEqual(call.output, "ok", "a result already loaded pairs with the call that arrived later")
	}

	func testAnswerDraftCollectsEveryQuestion() {
		let questions = [
			AskQuestion(question: "How?", header: "Approach", multiSelect: false, options: [AskOption(label: "Rewrite"), AskOption(label: "Patch")]),
			AskQuestion(question: "Which files?", multiSelect: true, options: [AskOption(label: "a.ts"), AskOption(label: "b.ts")])
		]
		var draft = AskAnswerDraft(questions: questions)
		XCTAssertFalse(draft.isComplete)
		draft.toggle("Rewrite", question: 0)
		draft.toggle("Patch", question: 0)
		XCTAssertEqual(draft.labels(question: 0), ["Patch"], "single select keeps one pick")
		XCTAssertFalse(draft.isComplete, "the second question is still open")
		draft.toggle("b.ts", question: 1)
		draft.toggle("a.ts", question: 1)
		draft.setReply(" also c.ts ", question: 1)
		XCTAssertTrue(draft.isComplete)
		XCTAssertEqual(draft.labels(question: 1), ["a.ts", "b.ts", "also c.ts"], "option order, then the typed reply")
		XCTAssertEqual(draft.answers.map(\.header), ["Approach", "Which files?"])
		XCTAssertEqual(draft.text, "Answering your questions:\n- Approach: Patch\n- Which files?: a.ts, b.ts, also c.ts")
		draft.toggle("Patch", question: 0)
		XCTAssertFalse(draft.isAnswered(question: 0), "tapping the pick again clears it")
	}

	func testDiffPatchSplitsFilesAndHunks() {
		let patch = """
		diff --git a/src/a.ts b/src/a.ts
		index 1..2 100644
		--- a/src/a.ts
		+++ b/src/a.ts
		@@ -1,2 +1,2 @@
		 context
		-old
		+new
		diff --git a/old name.md b/new name.md
		similarity index 90%
		rename from old name.md
		rename to new name.md
		"""
		let parsed = DiffPatch.parse(patch)
		XCTAssertEqual(parsed.files.map(\.path), ["src/a.ts", "new name.md"])
		XCTAssertEqual(parsed.files[1].oldPath, "old name.md")
		XCTAssertNil(parsed.files[0].oldPath)
		let kinds = parsed.files[0].lines.map(\.kind)
		XCTAssertEqual(kinds, [.meta, .meta, .meta, .hunk, .context, .removed, .added])
		XCTAssertEqual(parsed.files[0].lines.last?.text, "new")
		XCTAssertNil(parsed.file(at: "missing.ts"))
	}

	func testAppendingKeepsEarlierItemsAndIds() {
		var builder = TranscriptBuilder()
		builder.reset(with: events("""
		[{ "type": "assistant", "message": { "content": [
			{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/a/b.ts" } }
		] } }]
		"""))
		let before = builder.items.map(\.id)
		builder.append(contentsOf: events("""
		[{ "type": "user", "message": { "content": [
			{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }
		] } }]
		"""))
		XCTAssertEqual(builder.items.map(\.id), before, "a result must not add or renumber rows")
		guard case let .tool(call) = builder.items[0] else { return XCTFail("tool card") }
		XCTAssertEqual(call.output, "ok")
	}

	func testDecodeUnknownStatusFallsBack() throws {
		let json = """
		[{ "id": "x", "status": "hibernating" }]
		"""
		let sessions = try JSONDecoder().decode([SessionDigest].self, from: Data(json.utf8))
		XCTAssertEqual(sessions[0].status, .unknown)
	}

	func testDecodeAsk() throws {
		let json = """
		[{ "sessionId": "c_abc123", "source": "workflow", "askId": "wfask-1", "askedAt": 0,
			"questions": [{ "question": "Merge now?", "header": "Ship", "multiSelect": false,
				"options": [{ "label": "Yes", "description": "Squash merge" }, { "label": "No" }] }] }]
		"""
		let asks = try JSONDecoder().decode([DeckAsk].self, from: Data(json.utf8))
		XCTAssertEqual(asks[0].questions[0].options?.count, 2)
		XCTAssertEqual(asks[0].askId, "wfask-1")
	}

	func testDecodeEventsResponseBootstrap() throws {
		let json = """
		{ "snapshot": [{ "id": "c_1", "status": "idle" }], "seq": 100 }
		"""
		let response = try JSONDecoder().decode(EventsResponse.self, from: Data(json.utf8))
		XCTAssertEqual(response.snapshot?.count, 1)
		XCTAssertEqual(response.seq, 100)
		XCTAssertNil(response.events)
	}

	func testDecodeEvent() throws {
		let json = """
		{ "events": [{ "seq": 101, "sessionId": "c_1", "type": "awaiting-input", "at": 1752900000000,
			"awaitingInput": true, "source": "mcp",
			"questions": [{ "question": "Proceed?" }] }], "seq": 101 }
		"""
		let response = try JSONDecoder().decode(EventsResponse.self, from: Data(json.utf8))
		XCTAssertEqual(response.events?.first?.type, "awaiting-input")
		XCTAssertEqual(response.events?.first?.awaitingInput, true)
	}

	func testMarkdownParsesBlockKinds() {
		let md = """
		# Heading

		Some **bold** and `code` text.

		- first
		- second

		1. one
		2. two

		```swift
		let x = 1
		```

		> a quote

		| a | b |
		| - | - |
		| 1 | 2 |

		---
		"""
		let blocks = MarkdownParser.parse(md)
		guard case .heading(1, "Heading") = blocks[0] else { return XCTFail("heading") }
		guard case .paragraph = blocks[1] else { return XCTFail("paragraph") }
		guard case let .list(unordered) = blocks[2], unordered.count == 2, !unordered[0].ordered else {
			return XCTFail("unordered list")
		}
		guard case let .list(ordered) = blocks[3], ordered.count == 2, ordered[1].number == 2 else {
			return XCTFail("ordered list")
		}
		guard case let .code(code) = blocks[4], code.contains("let x = 1") else { return XCTFail("code") }
		guard case .quote("a quote") = blocks[5] else { return XCTFail("quote") }
		guard case let .table(header, rows) = blocks[6], header == ["a", "b"], rows == [["1", "2"]] else {
			return XCTFail("table")
		}
		guard case .rule = blocks[7] else { return XCTFail("rule") }
	}

	func testMarkdownPlainTextIsSingleParagraph() {
		let blocks = MarkdownParser.parse("just some plain text")
		XCTAssertEqual(blocks, [.paragraph("just some plain text")])
	}

	func testQRParse() {
		let credentials = DeckQR.parse("https://deck.example.com/?token=abc123")
		XCTAssertEqual(credentials?.baseURL.absoluteString, "https://deck.example.com")
		XCTAssertEqual(credentials?.token, "abc123")

		let withPort = DeckQR.parse("http://192.168.1.5:4818/?token=t0k3n")
		XCTAssertEqual(withPort?.baseURL.absoluteString, "http://192.168.1.5:4818")

		XCTAssertNil(DeckQR.parse("https://deck.example.com/"))
		XCTAssertNil(DeckQR.parse("not a url"))
		XCTAssertNil(DeckQR.parse("ftp://deck.example.com/?token=x"))
	}

	func testMergeAppendsLocalProfilesAfterClaudeShortnames() {
		// Built-ins stay first so the usual default pick is unaffected.
		XCTAssertEqual(
			DeckModels.merge(kind: "claude", enumerated: ["strix-local"]),
			DeckModels.claude + ["strix-local"])
	}

	func testMergeDoesNotDuplicateBuiltInShortnames() {
		XCTAssertEqual(DeckModels.merge(kind: "claude", enumerated: ["opus"]), DeckModels.claude)
	}

	func testMergeLeavesOtherKindsToTheirOwnEnumeration() {
		XCTAssertEqual(
			DeckModels.merge(kind: "opencode", enumerated: ["gpu-box/qwen38-q4"]),
			["gpu-box/qwen38-q4"])
	}

}

final class MessageFilesTests: XCTestCase {
	func testFindsAbsoluteHomeFileURLAndExplicitRelativePaths() {
		XCTAssertEqual(
			MessageFiles.paths(in: "Saved to /tmp/shot.png and ~/Desktop/report.pdf, see file:///Users/me/a.csv or ./out/b.json and ../c.txt"),
			["/tmp/shot.png", "~/Desktop/report.pdf", "/Users/me/a.csv", "./out/b.json", "../c.txt"])
	}

	func testDropsPunctuationQuotesBracketsAndBackticks() {
		XCTAssertEqual(
			MessageFiles.paths(in: "Done: /tmp/a.png. Also (`/tmp/b.jpg`), \"/tmp/c.gif\"; [/tmp/d.webp]!"),
			["/tmp/a.png", "/tmp/b.jpg", "/tmp/c.gif", "/tmp/d.webp"])
		XCTAssertEqual(MessageFiles.paths(in: "/tmp/a.png.bak and /src/x.test.ts:12"), ["/tmp/a.png.bak", "/src/x.test.ts"])
	}

	func testIgnoresURLsBareReferencesAndDirectoriesAndDedupes() {
		XCTAssertEqual(MessageFiles.paths(in: "see https://example.com/a.png and src/lib/foo.ts in /Users/me/proj/"), [])
		XCTAssertEqual(MessageFiles.paths(in: "/a/b.png /a/b.png /a/c.png"), ["/a/b.png", "/a/c.png"])
		XCTAssertEqual(MessageFiles.paths(in: (0..<30).map { "/a/\($0).png" }.joined(separator: " ")).count, 20)
	}

	func testImagesAndSizes() {
		XCTAssertTrue(MessageFiles.isImage("/a/b.PNG"))
		XCTAssertFalse(MessageFiles.isImage("/a/b.pdf"))
		XCTAssertEqual(MessageFiles.formatBytes(512), "512 B")
		XCTAssertEqual(MessageFiles.formatBytes(2048), "2.0 KB")
		XCTAssertEqual(MessageFiles.formatBytes(200 * 1024), "200 KB")
		XCTAssertEqual(MessageFiles.formatBytes(3 * 1024 * 1024), "3.0 MB")
	}
}
