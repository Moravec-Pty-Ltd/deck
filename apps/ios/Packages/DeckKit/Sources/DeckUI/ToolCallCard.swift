import SwiftUI
import DeckKit

/// One tool the agent ran, rendered the way deck's web session view renders it:
/// name, the one argument worth seeing, and the output behind a disclosure.
public struct ToolCallCard: View {
	let call: ToolCall
	@State private var showOutput = false

	public init(call: ToolCall) {
		self.call = call
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			header
			if let command = call.command, !command.isEmpty {
				CodeBlock(text: "$ " + command)
			}
			if !call.todos.isEmpty {
				todoList
			}
			if call.isError, !call.output.isEmpty {
				CodeBlock(text: clipped, tint: .red)
			} else if !call.output.isEmpty, !call.hidesOutput {
				Button {
					withAnimation(.easeInOut(duration: 0.15)) { showOutput.toggle() }
				} label: {
					Label(
						showOutput ? "hide output" : "show output",
						systemImage: showOutput ? "chevron.down" : "chevron.right")
						.font(.caption)
						.foregroundStyle(.secondary)
				}
				.buttonStyle(.plain)
				if showOutput {
					CodeBlock(text: clipped)
				}
			}
			if call.showsRawInput {
				DisclosureGroup("input") {
					CodeBlock(text: call.input.prettyPrinted)
				}
				.font(.caption)
				.foregroundStyle(.secondary)
			}
		}
		.padding(10)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Color.deckSecondaryGroupedBackground, in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
		.overlay(
			RoundedRectangle(cornerRadius: DeckStyle.Radius.card)
				.stroke(call.isError ? Color.red.opacity(0.4) : Color.deckSeparator, lineWidth: 0.5))
	}

	private var header: some View {
		HStack(spacing: 6) {
			Image(systemName: ToolCallCard.icon(for: call.name))
				.font(.caption)
				.foregroundStyle(.secondary)
			Text(call.name)
				.font(.subheadline.weight(.medium))
			Text(call.headerArg)
				.font(.caption.monospaced())
				.foregroundStyle(.secondary)
				.lineLimit(1)
				.truncationMode(.middle)
			Spacer(minLength: 4)
			if call.isError {
				Text("error")
					.font(.caption2.weight(.semibold))
					.padding(.horizontal, 6)
					.padding(.vertical, 2)
					.background(Color.red.opacity(0.15), in: Capsule())
					.foregroundStyle(.red)
			}
		}
	}

	private var todoList: some View {
		VStack(alignment: .leading, spacing: 3) {
			ForEach(call.todos) { todo in
				HStack(alignment: .firstTextBaseline, spacing: 6) {
					Image(systemName: todo.isDone
						? "checkmark.circle.fill"
						: (todo.isActive ? "circle.inset.filled" : "circle"))
						.font(.caption2)
						.foregroundStyle(todo.isDone ? .green : (todo.isActive ? .orange : .secondary))
					Text(todo.content)
						.font(.caption)
						.strikethrough(todo.isDone)
						.foregroundStyle(todo.isDone ? .secondary : .primary)
				}
			}
		}
	}

	/// Long outputs are for skimming on a phone, not reading in full.
	private var clipped: String {
		let limit = 4000
		return call.output.count > limit ? String(call.output.prefix(limit)) + "\n…" : call.output
	}

	public static func icon(for tool: String) -> String {
		switch tool {
		case "Bash": return "terminal"
		case "Read": return "doc.text"
		case "Edit", "MultiEdit", "NotebookEdit": return "square.and.pencil"
		case "Write": return "doc.badge.plus"
		case "Grep", "WebSearch": return "magnifyingglass"
		case "Glob": return "folder.badge.questionmark"
		case "TodoWrite": return "checklist"
		case "WebFetch": return "globe"
		case "Agent", "Task": return "sparkles"
		default: return "wrench.and.screwdriver"
		}
	}
}

/// What a subagent did, under the Agent call that launched it: a step count
/// that opens to its rows, laid out like the thread (runs of tool calls fold).
/// `row` renders one item, so the app's bubbles and cards are reused.
/// With `agent` (the server's live view of it) it also shows the agent's
/// status, what it is doing, and its final report.
public struct SubagentSteps<Row: View>: View {
	let steps: [TranscriptItem]
	let agent: SubagentState?
	let row: (TranscriptItem) -> Row
	@State private var open = false

	public init(steps: [TranscriptItem], agent: SubagentState? = nil, @ViewBuilder row: @escaping (TranscriptItem) -> Row) {
		self.steps = steps
		self.agent = agent
		self.row = row
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			if let agent { status(agent) }
			if !steps.isEmpty { stepList }
			if let summary = agent?.summary, !summary.isEmpty {
				DisclosureGroup {
					MarkdownText(summary).padding(.top, 4)
				} label: {
					Text("result").font(.caption).foregroundStyle(.secondary)
				}
			}
		}
	}

	private func status(_ agent: SubagentState) -> some View {
		HStack(spacing: 6) {
			switch agent.status {
			case .running: ProgressView().controlSize(.mini)
			case .completed: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
			case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
			case .stopped: Image(systemName: "xmark.circle.fill").foregroundStyle(.orange)
			}
			Text(agent.isRunning ? (agent.activity.isEmpty ? "starting…" : agent.activity) : agent.status.rawValue)
				.lineLimit(1)
			Spacer(minLength: 4)
			Text(agent.progress).monospacedDigit()
		}
		.font(.caption)
		.foregroundStyle(.secondary)
		.accessibilityElement(children: .combine)
	}

	private var stepList: some View {
		DisclosureGroup(isExpanded: $open) {
			VStack(alignment: .leading, spacing: 10) {
				ForEach(TranscriptGroup.make(steps, condensed: true)) { group in
					if group.isCollapsedRun {
						DisclosureGroup("\(group.toolCount) tool calls") {
							ForEach(group.items) { row($0) }
						}
					} else if let item = group.items.first {
						row(item)
					}
				}
			}
			.padding(.leading, 8)
			.overlay(alignment: .leading) { Rectangle().fill(Color.deckSeparator).frame(width: 1) }
			.padding(.top, 6)
		} label: {
			Text(steps.count == 1 ? "1 step" : "\(steps.count) steps")
				.font(.caption)
				.foregroundStyle(.secondary)
		}
	}
}

/// What a session is waiting on, after its last bubble: its active watches
/// and subagents, newest first. Three show; "N more" expands the rest and each
/// watch's check command. Shows nothing when there is nothing to wait on.
public struct ActivityList: View {
	let entries: [ActivityEntry]
	let turnRunning: Bool
	let onCancel: (Watch) async throws -> Void
	let onRunNow: (Watch) async throws -> Void
	let onOpen: (SubagentState) -> Void
	@State private var expanded = false
	/// Cancelled here, hidden before the sessions list catches up.
	@State private var cancelled = Set<String>()

	public init(
		entries: [ActivityEntry], turnRunning: Bool, onCancel: @escaping (Watch) async throws -> Void,
		onRunNow: @escaping (Watch) async throws -> Void, onOpen: @escaping (SubagentState) -> Void
	) {
		self.entries = entries
		self.turnRunning = turnRunning
		self.onCancel = onCancel
		self.onRunNow = onRunNow
		self.onOpen = onOpen
	}

	private var live: [ActivityEntry] {
		entries.filter { if case .watch(let watch) = $0 { return !cancelled.contains(watch.id) } else { return true } }
	}

	public var body: some View {
		let view = ActivityFeed.visible(live, expanded: expanded)
		if !view.shown.isEmpty {
			VStack(alignment: .leading, spacing: 6) {
				ForEach(view.shown) { entry in
					switch entry {
					case .watch(let watch): watchRow(watch)
					case .agent(let agent): agentRow(agent)
					}
				}
				if view.more > 0 {
					Button { expanded = true } label: { Label("\(view.more) more", systemImage: "chevron.down") }
						.buttonStyle(.plain)
						.foregroundStyle(.secondary)
				} else if expanded {
					Button { expanded = false } label: { Label("Show less", systemImage: "chevron.up") }
						.buttonStyle(.plain)
						.foregroundStyle(.secondary)
				}
			}
			.font(.caption)
			.padding(10)
			.frame(maxWidth: .infinity, alignment: .leading)
			.overlay(RoundedRectangle(cornerRadius: DeckStyle.Radius.card).stroke(Color.deckSeparator, lineWidth: 0.5))
			.accessibilityElement(children: .contain)
			.accessibilityLabel("Session activity")
		}
	}

	private func watchRow(_ watch: Watch) -> some View {
		HStack(spacing: 8) {
			Image(systemName: "timer").foregroundStyle(.secondary)
			VStack(alignment: .leading, spacing: 2) {
				Text(watch.title).fontWeight(.medium).lineLimit(1)
				if expanded, let command = watch.command {
					Text(command).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
				}
			}
			Spacer(minLength: 4)
			TimelineView(.periodic(from: .now, by: 1)) { context in
				let left = watch.dueAt - context.date.timeIntervalSince1970 * 1000
				HStack(spacing: 8) {
					Text(left <= 0 && turnRunning ? "runs after this turn" : ActivityFeed.countdown(left))
						.monospacedDigit()
						.foregroundStyle(.secondary)
					if left > 0 {
						// The sessions list brings the new due time; a watch already gone has nothing to undo.
						Button {
							Task { try? await onRunNow(watch) }
						} label: {
							Image(systemName: "play.fill")
						}
						.buttonStyle(.borderless)
						.accessibilityLabel("Run watch now")
					}
				}
			}
			Button {
				cancelled.insert(watch.id)
				Task {
					do { try await onCancel(watch) } catch { cancelled.remove(watch.id) }
				}
			} label: {
				Image(systemName: "xmark")
			}
			.buttonStyle(.borderless)
			.accessibilityLabel("Cancel watch")
		}
	}

	private func agentRow(_ agent: SubagentState) -> some View {
		Button { onOpen(agent) } label: {
			HStack(spacing: 8) {
				switch agent.status {
				case .running: ProgressView().controlSize(.mini)
				case .completed: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
				case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
				case .stopped: Image(systemName: "xmark.circle.fill").foregroundStyle(.orange)
				}
				Text(agent.description.isEmpty ? agent.subagentType : agent.description)
					.fontWeight(.medium)
					.lineLimit(1)
				if !agent.description.isEmpty, !agent.subagentType.isEmpty {
					Text("(\(agent.subagentType))").foregroundStyle(.secondary).lineLimit(1)
				}
				if agent.isRunning, !agent.activity.isEmpty {
					Text(agent.activity).foregroundStyle(.secondary).lineLimit(1)
				}
				Spacer(minLength: 4)
				Text(agent.progress).foregroundStyle(.secondary).monospacedDigit()
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
	}
}

/// Monospaced, scrollable block for commands and tool output.
public struct CodeBlock: View {
	let text: String
	var tint: Color = .primary

	public init(text: String, tint: Color = .primary) {
		self.text = text
		self.tint = tint
	}

	public var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			Text(text)
				.font(.caption.monospaced())
				.foregroundStyle(tint)
				.textSelection(.enabled)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.frame(maxHeight: 260)
		.padding(8)
		.background(Color.deckTertiaryGroupedBackground, in: RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
	}
}
