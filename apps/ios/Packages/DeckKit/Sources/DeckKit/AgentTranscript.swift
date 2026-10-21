import Foundation

/// A decoded JSON value from a raw agent transcript entry. deck streams the
/// agent CLI's own JSONL, so these shapes belong to the CLI rather than to
/// deck's API: keep them as data and read what each renderer needs.
public enum JSONValue: Decodable, Equatable, Sendable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode([JSONValue].self) {
			self = .array(value)
		} else if let value = try? container.decode([String: JSONValue].self) {
			self = .object(value)
		} else {
			self = .null
		}
	}

	public static func parse(_ data: Data) -> JSONValue? {
		try? JSONDecoder().decode(JSONValue.self, from: data)
	}

	public subscript(key: String) -> JSONValue {
		guard case let .object(fields) = self else { return .null }
		return fields[key] ?? .null
	}

	public var string: String? {
		if case let .string(value) = self { return value }
		return nil
	}

	public var int: Int? {
		if case let .number(value) = self { return Int(value) }
		return nil
	}

	public var bool: Bool? {
		if case let .bool(value) = self { return value }
		return nil
	}

	public var array: [JSONValue]? {
		if case let .array(values) = self { return values }
		return nil
	}

	/// Re-encoded for the raw-input disclosure on tools we have no bespoke
	/// rendering for.
	public var prettyPrinted: String {
		guard let data = try? JSONSerialization.data(
			withJSONObject: foundationObject, options: [.prettyPrinted, .sortedKeys]),
			let text = String(data: data, encoding: .utf8)
		else { return "" }
		return text
	}

	private var foundationObject: Any {
		switch self {
		case .null: return NSNull()
		case .bool(let value): return value
		case .number(let value): return value == value.rounded() ? Int(value) : value
		case .string(let value): return value
		case .array(let values): return values.map(\.foundationObject)
		case .object(let fields): return fields.mapValues(\.foundationObject)
		}
	}
}

/// One entry of a TodoWrite checklist.
public struct TodoItem: Identifiable, Equatable, Sendable {
	public let id: Int
	public let content: String
	public let status: String

	public var isDone: Bool { status == "completed" }
	public var isActive: Bool { status == "in_progress" }
}

/// A tool the agent invoked, paired with its result once that arrives.
public struct ToolCall: Identifiable, Equatable, Sendable {
	public let id: String
	public let name: String
	public let input: JSONValue
	public var output: String = ""
	public var isError = false
	/// For an ask tool: the picks recorded against it, once answered.
	public var answers: [StructuredAnswer]? = nil

	public init(id: String, name: String, input: JSONValue, output: String = "", isError: Bool = false, answers: [StructuredAnswer]? = nil) {
		self.id = id
		self.name = name
		self.input = input
		self.output = output
		self.isError = isError
		self.answers = answers
	}

	/// The one detail worth showing beside the tool name, picked per tool the
	/// way deck's web view picks it (path for file tools, description for Bash,
	/// pattern for search, and so on).
	public var headerArg: String {
		if ToolCall.fileTools.contains(name), let path = input["file_path"].string {
			let range = input["offset"].int.map { offset in
				":\(offset)" + (input["limit"].int.map { "+\($0)" } ?? "")
			}
			return shortPath(path) + (range ?? "")
		}
		switch name {
		case "Bash": return firstLine(input["description"].string ?? input["command"].string ?? "")
		case "Grep", "Glob": return input["pattern"].string ?? ""
		case "WebFetch": return input["url"].string ?? ""
		case "WebSearch": return input["query"].string ?? ""
		case "Task": return input["subagent_type"].string ?? input["description"].string ?? ""
		case "TodoWrite": return "\(todos.count) items"
		default:
			return firstLine(
				input["description"].string ?? input["command"].string ?? input["file_path"].string ?? "")
		}
	}

	public var command: String? { name == "Bash" ? input["command"].string : nil }

	public var todos: [TodoItem] {
		guard name == "TodoWrite", let raw = input["todos"].array else { return [] }
		return raw.enumerated().map { index, todo in
			TodoItem(
				id: index,
				content: todo["content"].string ?? "",
				status: todo["status"].string ?? "pending")
		}
	}

	/// Whether this is the blocking question tool (deck's MCP `ask`, or claude's
	/// built-in), which renders as a question card rather than a tool card.
	public var isAsk: Bool { ToolCall.askTools.contains(name) }

	/// The questions an ask call put to the user, from its input.
	public var questions: [AskQuestion] {
		guard isAsk, let raw = input["questions"].array else { return [] }
		return raw.compactMap { q in
			guard let question = q["question"].string else { return nil }
			let options = (q["options"].array ?? []).compactMap { option -> AskOption? in
				guard let label = option["label"].string else { return nil }
				return AskOption(label: label, description: option["description"].string)
			}
			return AskQuestion(
				question: question, header: q["header"].string,
				multiSelect: q["multiSelect"].bool, options: options)
		}
	}

	/// Edit and Write report "file updated" text that adds nothing next to the
	/// tool header; only an error is worth surfacing.
	public var hidesOutput: Bool {
		!isError && ["Edit", "MultiEdit", "Write"].contains(name)
	}

	public var showsRawInput: Bool {
		!ToolCall.fileTools.contains(name) && !ToolCall.knownTools.contains(name) && !isAsk
	}

	static let fileTools: Set<String> = ["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]
	static let knownTools: Set<String> = [
		"Bash", "TodoWrite", "Grep", "Glob", "WebFetch", "WebSearch", "Task"
	]
	public static let askTools: Set<String> = ["mcp__deck__ask", "AskUserQuestion"]
}

/// An attachment a message carried: either a file deck stored out-of-band
/// (fetched through the session's images endpoint) or, in older transcripts,
/// the inline base64 payload.
public struct TranscriptImage: Hashable, Sendable {
	public let file: String?
	public let mediaType: String?
	public let data: String?

	public init(file: String? = nil, mediaType: String? = nil, data: String? = nil) {
		self.file = file
		self.mediaType = mediaType
		self.data = data
	}
}

/// How loudly a one-line aside should read.
public enum NoticeLevel: Sendable {
	case info, warning, error
}

/// One renderable row of a session transcript.
public enum TranscriptItem: Identifiable, Equatable, Sendable {
	case user(id: String, text: String, images: [TranscriptImage])
	case assistant(id: String, text: String)
	case thinking(id: String, text: String)
	case tool(ToolCall)
	/// A one-line aside: a model/effort/agent switch, a turn's cost, a warning
	/// about missing context, or an error deck recorded.
	case notice(id: String, text: String, level: NoticeLevel)

	public var id: String {
		switch self {
		case .user(let id, _, _), .assistant(let id, _), .thinking(let id, _): return id
		case .tool(let call): return "tool-\(call.id)"
		case .notice(let id, _, _): return id
		}
	}
}

/// Folds raw agent transcript events into renderable items, pairing each
/// tool_use with the tool_result that follows it. Mirrors what deck's web
/// session view renders, so the app shows the same work rather than a
/// flattened text transcript.
///
/// Item ids derive from each event's absolute transcript index, so loading
/// older history in front of what is shown keeps every existing row's identity
/// (and the reader's place) intact.
public struct TranscriptBuilder: Sendable {
	public private(set) var items: [TranscriptItem] = []
	/// The raw events folded so far, oldest first; `events[k]` is absolute index
	/// `startIndex + k`.
	public private(set) var events: [JSONValue] = []
	public private(set) var startIndex = 0
	private var toolIndexById: [String: Int] = [:]

	public init() {}

	/// The absolute index the next appended event takes.
	public var nextIndex: Int { startIndex + events.count }

	public mutating func reset(with events: [JSONValue] = [], startIndex: Int = 0) {
		items = []
		toolIndexById = [:]
		self.events = []
		self.startIndex = startIndex
		append(contentsOf: events)
	}

	public mutating func append(contentsOf events: [JSONValue]) {
		for event in events { append(event) }
	}

	public mutating func append(_ event: JSONValue) {
		let index = nextIndex
		events.append(event)
		fold(event, at: index)
	}

	/// Put older history in front of what is loaded. `startIndex` is the
	/// absolute index of `older[0]`; it must run right up to the current start.
	/// Everything is refolded so tool results in the loaded part can pair with
	/// calls that were only just loaded.
	public mutating func prepend(contentsOf older: [JSONValue], startIndex: Int) {
		guard !older.isEmpty else { return }
		let combined = older + events
		reset(with: combined, startIndex: startIndex)
	}

	private mutating func fold(_ event: JSONValue, at index: Int) {
		let id = String(index)
		switch event["type"].string {
		case "deck.user":
			addUser(id: id, event)
		case "deck.error":
			addNotice(id: id, event["text"].string, level: .error)
		case "deck.warning":
			addNotice(id: id, event["text"].string, level: .warning)
		case "deck.model":
			if let model = event["model"].string {
				addNotice(id: id, "model → \(model)", level: .info)
			}
		case "deck.agent":
			let kind = event["kind"].string ?? "agent"
			let from = event["from"].string.map { "agent \($0) → " } ?? "agent → "
			addNotice(id: id, from + kind, level: .info)
		case "deck.effort":
			let effort = event["effort"].string ?? "default"
			addNotice(id: id, "thinking → \(effort)", level: .info)
		case "deck.answer":
			attachAnswers(event)
		case "result":
			addNotice(id: id, TranscriptBuilder.costLine(event), level: .info)
		case "assistant":
			appendAssistant(event["message"]["content"].array ?? [], id: id)
		case "user":
			appendUser(event["message"]["content"], id: id)
		default:
			// system, stream_event and any deck.* marker we don't render.
			break
		}
	}

	private mutating func addUser(id: String, _ event: JSONValue) {
		attachAnswers(event)
		let text = event["text"].string ?? ""
		let images = (event["images"].array ?? []).map { image in
			TranscriptImage(
				file: image["file"].string, mediaType: image["media_type"].string, data: image["data"].string)
		}
		guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return }
		items.append(.user(id: id, text: text, images: images))
	}

	private mutating func appendAssistant(_ blocks: [JSONValue], id: String) {
		for (j, block) in blocks.enumerated() {
			let blockId = "\(id):\(j)"
			switch block["type"].string {
			case "text":
				addText(.assistant, block["text"].string, id: blockId)
			case "thinking":
				addText(.thinking, block["thinking"].string, id: blockId)
			case "tool_use":
				guard let toolId = block["id"].string else { continue }
				toolIndexById[toolId] = items.count
				items.append(.tool(ToolCall(id: toolId, name: block["name"].string ?? "tool", input: block["input"])))
			default:
				break
			}
		}
	}

	/// A user event is either something you typed or the results of the tools the
	/// agent just ran; the latter belong on the tool card, not in a bubble.
	private mutating func appendUser(_ content: JSONValue, id: String) {
		if let text = content.string {
			addText(.user, text, id: id)
			return
		}
		for (j, block) in (content.array ?? []).enumerated() {
			switch block["type"].string {
			case "tool_result":
				attachResult(block)
			case "text":
				addText(.user, block["text"].string, id: "\(id):\(j)")
			default:
				break
			}
		}
	}

	private mutating func attachResult(_ block: JSONValue) {
		guard let toolId = block["tool_use_id"].string,
			let index = toolIndexById[toolId],
			index < items.count,
			case var .tool(call) = items[index]
		else { return }
		call.output = TranscriptBuilder.resultText(block["content"])
		call.isError = block["is_error"].bool ?? false
		items[index] = .tool(call)
	}

	/// A `deck.answer` marker (or a `deck.user` carrying `answersFor`) records
	/// the picks against the ask call they answer.
	private mutating func attachAnswers(_ event: JSONValue) {
		guard let toolId = event["answersFor"].string,
			let index = toolIndexById[toolId],
			index < items.count,
			case var .tool(call) = items[index]
		else { return }
		call.answers = (event["answers"].array ?? []).map { answer in
			StructuredAnswer(
				header: answer["header"].string ?? "",
				labels: (answer["labels"].array ?? []).compactMap(\.string))
		}
		items[index] = .tool(call)
	}

	static func resultText(_ content: JSONValue) -> String {
		if let text = content.string { return text }
		return (content.array ?? [])
			.filter { $0["type"].string == "text" }
			.compactMap { $0["text"].string }
			.joined(separator: "\n")
	}

	/// The turn footer the web view prints for a `result` event: duration,
	/// turns, cost, and a non-success ending.
	static func costLine(_ event: JSONValue) -> String {
		var parts: [String] = []
		if case let .number(ms) = event["duration_ms"] { parts.append(String(format: "%.1fs", ms / 1000)) }
		if let turns = event["num_turns"].int { parts.append("\(turns) turns") }
		if case let .number(cost) = event["total_cost_usd"] { parts.append(String(format: "$%.4f", cost)) }
		if let subtype = event["subtype"].string, subtype != "success" { parts.append(subtype) }
		return parts.joined(separator: " · ")
	}

	private enum TextKind { case user, assistant, thinking }

	private mutating func addText(_ kind: TextKind, _ text: String?, id: String) {
		guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
		switch kind {
		case .user: items.append(.user(id: id, text: text, images: []))
		case .assistant: items.append(.assistant(id: id, text: text))
		case .thinking: items.append(.thinking(id: id, text: text))
		}
	}

	private mutating func addNotice(id: String, _ text: String?, level: NoticeLevel) {
		guard let text, !text.isEmpty else { return }
		items.append(.notice(id: id, text: text, level: level))
	}
}

/// `~/code/project/src/file.ts` from an absolute path, matching how deck's web
/// view shortens paths in tool headers.
func shortPath(_ path: String) -> String {
	let home = NSHomeDirectory()
	var short = path
	if !home.isEmpty, short.hasPrefix(home) {
		short = "~" + short.dropFirst(home.count)
	}
	let parts = short.split(separator: "/")
	guard parts.count > 4 else { return short }
	return "…/" + parts.suffix(3).joined(separator: "/")
}

private func firstLine(_ text: String) -> String {
	text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? text
}
