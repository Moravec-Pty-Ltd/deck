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
public struct SubagentSteps<Row: View>: View {
	let steps: [TranscriptItem]
	let row: (TranscriptItem) -> Row
	@State private var open = false

	public init(steps: [TranscriptItem], @ViewBuilder row: @escaping (TranscriptItem) -> Row) {
		self.steps = steps
		self.row = row
	}

	public var body: some View {
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
