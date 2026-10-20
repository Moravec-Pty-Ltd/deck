import Foundation
import Network

/// A stand-in deck the UI tests host themselves, and a record of every request
/// made to it. It serves three workflow runs (one blocked on a question, one
/// running a looping review, one finished) and two schedules (one spawning, one
/// pointed at a session that has gone). State changes only when the app asks for
/// it, the way deck's engine would answer, so a test can tell what the app asked
/// for apart from what it drew.
final class RunStubServer: @unchecked Sendable {
	struct Request {
		let method: String
		let path: String
		let body: [String: Any]
	}

	static let token = "stub-token"

	private let listener: NWListener
	private let queue = DispatchQueue(label: "run-stub")
	private var runs: [String: [String: Any]]
	private var schedules: [String: [String: Any]]
	private var seq = 1
	private var pending: [[String: Any]] = []
	private var log: [Request] = []

	/// Answer fix-findings with deck's 409 for a merged PR.
	var prMerged = false

	private(set) var port: UInt16 = 0
	var url: String { "http://127.0.0.1:\(port)" }

	init() throws {
		listener = try NWListener(using: .tcp, on: .any)
		runs = Dictionary(uniqueKeysWithValues: [Self.blockedRun, Self.reviewRun, Self.doneRun].map { ($0["id"] as! String, $0) })
		schedules = Dictionary(uniqueKeysWithValues: [Self.spawnSchedule, Self.brokenSchedule].map { ($0["id"] as! String, $0) })
	}

	func start() throws {
		let ready = DispatchSemaphore(value: 0)
		listener.stateUpdateHandler = { state in
			if case .ready = state { ready.signal() }
		}
		listener.newConnectionHandler = { [weak self] connection in
			guard let self else { return }
			connection.start(queue: self.queue)
			self.receive(connection, buffer: Data())
		}
		listener.start(queue: queue)
		guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port?.rawValue else {
			throw NSError(domain: "RunStubServer", code: 1)
		}
		self.port = port
	}

	func stop() { listener.cancel() }

	/// Every POST the app made, in order.
	var posts: [Request] { queue.sync { log.filter { $0.method == "POST" } } }

	var deletes: [Request] { queue.sync { log.filter { $0.method == "DELETE" } } }

	var patches: [Request] { queue.sync { log.filter { $0.method == "PATCH" } } }

	func requested(_ fragment: String) -> Bool {
		queue.sync { log.contains { $0.path.contains(fragment) } }
	}

	// MARK: - HTTP

	private func receive(_ connection: NWConnection, buffer: Data) {
		connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
			guard let self else { return }
			var buffer = buffer
			if let data { buffer.append(data) }
			if let request = Self.parse(buffer) {
				self.respond(to: request, on: connection)
			} else if done || error != nil {
				connection.cancel()
			} else {
				self.receive(connection, buffer: buffer)
			}
		}
	}

	/// A complete request (headers plus Content-Length bytes of body), or nil
	/// while more is still to come.
	private static func parse(_ data: Data) -> Request? {
		guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
		let head = String(decoding: data[..<end.lowerBound], as: UTF8.self)
		let lines = head.components(separatedBy: "\r\n")
		let start = lines[0].split(separator: " ")
		guard start.count >= 2 else { return nil }
		let length = lines.dropFirst().compactMap { line -> Int? in
			let parts = line.split(separator: ":", maxSplits: 1)
			guard parts.count == 2, parts[0].lowercased() == "content-length" else { return nil }
			return Int(parts[1].trimmingCharacters(in: .whitespaces))
		}.first ?? 0
		let body = data[end.upperBound...]
		guard body.count >= length else { return nil }
		let json = (try? JSONSerialization.jsonObject(with: Data(body.prefix(length)))) as? [String: Any]
		return Request(method: String(start[0]), path: String(start[1]), body: json ?? [:])
	}

	private func respond(to request: Request, on connection: NWConnection) {
		log.append(request)
		let (status, json, delay) = route(request)
		queue.asyncAfter(deadline: .now() + delay) { [weak self] in
			guard let self else { return }
			// The long-poll is answered when it is sent, so it carries events
			// posted while it waited.
			let payload = json ?? self.drainEvents()
			let body = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
			let head = "HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
			connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
		}
	}

	private func drainEvents() -> Any {
		defer { pending = [] }
		return ["events": pending, "seq": seq]
	}

	/// Status, body (nil means "the event batch, built at send time"), delay.
	private func route(_ request: Request) -> (Int, Any?, TimeInterval) {
		let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
		let parts = path.split(separator: "/").map(String.init)
		switch (request.method, path) {
		case ("GET", "/api/agent/events"):
			if request.path.contains("since=") { return (200, nil, pending.isEmpty ? 1 : 0) }
			return (200, ["snapshot": [], "seq": seq], 0)
		case ("GET", "/api/agent/runs"):
			return (200, runs.values.sorted { ($0["createdAt"] as! Double) > ($1["createdAt"] as! Double) }, 0)
		case ("GET", "/api/agent/overseer"):
			return (200, ["sessionId": "c_overseer", "active": true, "busy": false], 0)
		case ("GET", "/api/agent/asks"):
			return (200, runs.values.compactMap(Self.ask), 0)
		case ("GET", "/api/agent/schedules"):
			return (200, schedules.values.sorted { ($0["createdAt"] as! Double) > ($1["createdAt"] as! Double) }, 0)
		case ("GET", "/api/agent/schedules/preview"):
			// deck walks the expression; the stub only has to answer in its
			// shape, so the form's Save button stops waiting on it.
			return (200, ["cron": "", "next": [Self.now + 3_600_000]], 0)
		case ("GET", "/api/agent"):
			return (200, ["version": "stub", "capabilities": [
				"stream", "history", "images", "files", "diff", "servers", "speech", "operator", "search", "user",
				"quick-messages", "project-config", "git", "pr-dismiss", "expensive-models"
			]], 0)
		case ("GET", "/api/agent/sessions"), ("GET", "/api/agent/projects"), ("GET", "/api/agent/kinds"),
			("GET", "/api/agent/quick-messages"), ("GET", "/api/agent/projects/config"):
			return (200, [], 0)
		default:
			break
		}
		if parts.count == 4, parts[2] == "runs", request.method == "GET", let run = runs[parts[3]] {
			return (200, run, 0)
		}
		if parts.count == 4, parts[2] == "runs", request.method == "DELETE", runs[parts[3]] != nil {
			runs[parts[3]] = nil
			seq += 1
			pending.append(["seq": seq, "sessionId": parts[3], "type": "run-deleted", "runId": parts[3]])
			return (200, ["ok": true], 0)
		}
		if parts.count == 4, parts[2] == "schedules", var schedule = schedules[parts[3]] {
			switch request.method {
			case "PATCH":
				// Only the fields the body names, as deck's PATCH does.
				for (key, value) in request.body { schedule[key] = value }
				schedules[parts[3]] = schedule
				return (200, schedule, 0)
			case "DELETE":
				schedules[parts[3]] = nil
				return (200, ["ok": true], 0)
			default:
				return (200, schedule, 0)
			}
		}
		if parts.count == 5, parts[2] == "schedules", parts[4] == "run", let schedule = schedules[parts[3]] {
			return (200, schedule, 0)
		}
		if parts.count == 5, parts[2] == "runs", request.method == "POST", runs[parts[3]] != nil {
			if parts[4] == "fix-findings", prMerged {
				return (409, ["message": "the PR is merged, so there is nothing to push to"], 0)
			}
			return (200, act(parts[4], on: parts[3], body: request.body), 0)
		}
		return (404, ["message": "not in the stub"], 0)
	}

	/// What deck's engine does for each action, reduced to the fields the app
	/// draws, plus the run-updated event deck publishes.
	private func act(_ action: String, on id: String, body: [String: Any]) -> [String: Any] {
		var run = runs[id]!
		switch action {
		case "answer":
			run["status"] = "running"
			run["block"] = nil
		case "pause", "takeover":
			run["status"] = "paused"
			if action == "takeover" { run["humanTouched"] = true }
		case "resume":
			run["status"] = "running"
			if let phase = body["phase"] as? String { run["phase"] = phase }
		case "fix-findings":
			run["status"] = "running"
			run["followUp"] = true
		default:
			break
		}
		run["updatedAt"] = (run["updatedAt"] as! Double) + 1000
		runs[id] = run
		seq += 1
		pending.append(["seq": seq, "sessionId": id, "type": "run-updated", "runId": id,
			"status": run["status"]!, "phase": run["phase"]!, "updatedAt": run["updatedAt"]!])
		return run
	}

	private static func ask(_ run: [String: Any]) -> [String: Any]? {
		guard run["status"] as? String == "blocked", let block = run["block"] as? [String: Any] else { return nil }
		return ["source": "run", "runId": run["id"]!, "askedAt": block["at"]!,
			"questions": [["question": block["question"]!, "header": run["title"]!, "options": []]]]
	}

	// MARK: - Fixtures

	static let now = Date().timeIntervalSince1970 * 1000

	private static func phase(
		_ id: String, _ label: String, _ status: String, next: String, sessions: [[String: Any]] = [],
		cap: Int? = nil, decisions: [[String: Any]] = []
	) -> [String: Any] {
		var phase: [String: Any] = ["id": id, "label": label, "role": id, "status": status,
			"visits": sessions.count, "next": next, "sessions": sessions, "decisions": decisions]
		if let cap { phase["cap"] = cap }
		return phase
	}

	private static func visit(_ sessionId: String, _ n: Int, _ result: String?) -> [String: Any] {
		var visit: [String: Any] = ["sessionId": sessionId, "visit": n, "startedAt": now - Double(10 - n) * 60_000]
		if let result { visit["result"] = result; visit["endedAt"] = now - Double(9 - n) * 60_000 }
		return visit
	}

	private static func run(
		id: String, title: String, status: String, phase: String, phases: [[String: Any]],
		createdAt: Double, block: [String: Any]? = nil, pr: [String: Any]? = nil
	) -> [String: Any] {
		var run: [String: Any] = [
			"id": id, "url": "http://deck.test/runs/\(id)",
			"workflow": ["id": "dev", "name": "Dev workflow", "category": "dev"],
			"title": title, "projectPath": "/code/stub-proj", "cwd": "/code/stub-proj-wt", "branch": "jin/stub",
			"base": "main", "issue": ["source": "github", "id": "owner/stub-proj#7", "url": "https://github.com/owner/stub-proj/issues/7"],
			"status": status, "phase": phase, "round": 2, "cap": 5, "loop": false, "blockers": 1,
			"findings": [["file": "src/a.ts", "line": 3, "severity": "blocker", "defect": "null case unhandled", "fix": "guard it", "keep": "the fast path"]],
			"escalations": ["implementer": false, "disagreement": false, "cap": false],
			"humanTouched": false, "phases": phases, "createdAt": createdAt, "updatedAt": createdAt
		]
		if let block { run["block"] = block }
		if let pr { run["pr"] = pr }
		return run
	}

	static let blockedRun = run(
		id: "r_blocked", title: "Blocked stub run", status: "blocked", phase: "pr",
		phases: [
			phase("implement", "Implement", "pass", next: "review", sessions: [visit("c_impl", 1, "pass")]),
			phase("review", "Review", "pass", next: "pr", sessions: [visit("c_rev_b", 1, "pass")], cap: 5),
			phase("pr", "Open PR", "active", next: "done", sessions: [visit("c_pr", 1, nil)])
		],
		createdAt: now - 3_600_000,
		block: ["question": "Which base branch should the PR target?", "at": now - 60_000, "by": "engine", "step": "pr"])

	static let reviewRun = run(
		id: "r_review", title: "Looping stub run", status: "running", phase: "review",
		phases: [
			phase("implement", "Implement", "pass", next: "review", sessions: [visit("c_impl2", 1, "pass")]),
			phase("review", "Review", "active", next: "pr",
				sessions: [visit("c_round_one", 1, "fail"), visit("c_round_two", 2, nil)], cap: 5,
				decisions: [["at": now - 120_000, "by": "overseer", "step": "review", "action": "retry",
					"reason": "The reviewer timed out, not a real failure."]]),
			phase("pr", "Open PR", "pending", next: "done")
		],
		createdAt: now - 1_800_000)

	/// Finished, with its PR open and a finding the review left behind.
	static let doneRun = run(
		id: "r_done", title: "Finished stub run", status: "done", phase: "pr",
		phases: [
			phase("implement", "Implement", "pass", next: "review", sessions: [visit("c_impl3", 1, "pass")]),
			phase("review", "Review", "pass", next: "pr", sessions: [visit("c_rev3", 1, "pass")], cap: 5),
			phase("pr", "Open PR", "pass", next: "done", sessions: [visit("c_pr3", 1, "pass")])
		],
		createdAt: now - 7_200_000,
		pr: ["repo": "owner/stub-proj", "number": 12, "url": "https://github.com/owner/stub-proj/pull/12"])

	/// A schedule that starts a fresh session per run, and has run before.
	static let spawnSchedule: [String: Any] = [
		"id": "sch_spawn", "title": "Morning sweep", "cron": "0 9 * * mon-fri",
		"prompt": "Summarise what changed overnight.", "enabled": true,
		"cwd": "/path/to/example", "projectName": "example",
		"createdAt": now - 86_400_000, "nextRunAt": now + 3_600_000, "lastRunAt": now - 7_200_000,
		"lastOutcome": "ran", "lastSessionId": "c_last", "runs": 12
	]

	/// Pointed at a session deck can no longer find, which is why deck switched
	/// it off. No `sessionTitle`: its absence is the signal.
	static let brokenSchedule: [String: Any] = [
		"id": "sch_broken", "title": "Hourly check", "cron": "0 * * * *",
		"prompt": "Anything new?", "enabled": false, "sessionId": "c_gone",
		"createdAt": now - 172_800_000, "lastRunAt": now - 3_600_000,
		"lastOutcome": "failed",
		"lastNote": "the session this schedule sends to no longer exists", "runs": 3
	]
}
