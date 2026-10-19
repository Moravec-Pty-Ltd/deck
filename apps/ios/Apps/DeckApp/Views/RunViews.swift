import SwiftUI
import DeckKit

/// Workflow runs: the board rows, one run's phases and controls, and one
/// phase's rounds and decisions. Everything here draws deck's digest and posts
/// actions; deck alone moves a run between phases.

struct RunRoute: Hashable {
	let id: String
}

struct PhaseRoute: Hashable {
	let runId: String
	let phaseId: String
}

enum RunDisplay {
	static func color(_ status: RunStatus) -> Color {
		switch status {
		case .blocked: return .orange
		case .running: return .green
		case .waiting: return .blue
		case .paused: return .yellow
		case .done, .cancelled, .unknown: return .secondary
		}
	}

	/// "Review · round 2 of 5", or just the phase when it hasn't looped.
	static func phaseLine(_ run: RunDigest) -> String {
		let label = run.currentPhase?.label ?? run.phase
		guard let phase = run.currentPhase, phase.visits > 1 || phase.cap != nil else { return label }
		return "\(label) · \(rounds(phase))"
	}

	static func rounds(_ phase: RunPhase) -> String {
		if let cap = phase.cap { return "round \(phase.visits) of \(cap)" }
		return phase.visits == 1 ? "ran once" : "ran \(phase.visits) times"
	}
}

/// One run on the board: what it is, where it is, and its phases as a strip.
struct RunRow: View {
	let run: RunDigest

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 6) {
				Text(run.title).font(.body.weight(.medium)).lineLimit(1)
				Chip(text: run.status.label, color: RunDisplay.color(run.status))
				if run.followUp == true {
					Chip(text: "follow-up", color: .accentColor)
				}
				Spacer(minLength: 8)
				Text(RelativeFormat.string(run.updatedAt))
					.font(.caption2)
					.foregroundStyle(.secondary)
			}
			Text("\(run.projectName) · \(run.workflow.name) · \(RunDisplay.phaseLine(run))")
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(1)
			PhaseStrip(run: run)
		}
		.padding(.vertical, 4)
		.accessibilityElement(children: .combine)
	}
}

/// One segment per phase, filled by how it went, the current one outlined.
struct PhaseStrip: View {
	let run: RunDigest

	var body: some View {
		HStack(spacing: 3) {
			ForEach(run.phases) { phase in
				Capsule()
					.fill(fill(phase))
					.overlay(Capsule().stroke(phase.id == run.phase ? Color.primary : .clear, lineWidth: 1))
					.frame(height: 5)
			}
		}
		.accessibilityHidden(true)
	}

	private func fill(_ phase: RunPhase) -> Color {
		switch phase.status {
		case .pass: return .green
		case .fail: return .red
		case .active: return RunDisplay.color(run.status)
		case .skipped: return .secondary.opacity(0.4)
		case .pending, .unknown: return .secondary.opacity(0.2)
		}
	}
}

struct PhaseStatusIcon: View {
	let phase: RunPhase
	let current: Bool

	var body: some View {
		Image(systemName: symbol)
			.foregroundStyle(color)
			.frame(width: 22)
			// The symbol's own label reads a passed phase as "Selected".
			.accessibilityLabel(phase.status.rawValue)
	}

	private var symbol: String {
		switch phase.status {
		case .pass: return "checkmark.circle.fill"
		case .fail: return "xmark.circle.fill"
		case .active: return "circle.inset.filled"
		case .skipped: return "arrow.uturn.forward.circle"
		case .pending, .unknown: return current ? "circle.inset.filled" : "circle"
		}
	}

	private var color: Color {
		switch phase.status {
		case .pass: return .green
		case .fail: return .red
		case .active: return .accentColor
		case .skipped, .pending, .unknown: return .secondary
		}
	}
}

/// One run: its question when it is blocked, its phases, and the controls.
struct RunView: View {
	@Environment(DeckStore.self) private var store
	let runId: String
	/// Open a session on the stack this view sits on (take over lands here).
	var onOpenSession: (String) -> Void

	@State private var busy = false
	@State private var errorMessage: String?
	@State private var confirmTakeover = false
	@State private var pickResumePhase = false

	private var run: RunDigest? { store.runs.first { $0.id == runId } }

	var body: some View {
		Group {
			if let run {
				content(run)
			} else {
				ContentUnavailableView("Run not found", systemImage: "questionmark.circle")
			}
		}
		.navigationTitle(run?.title ?? "Run")
		.navigationBarTitleDisplayMode(.inline)
		.refreshable { await store.refreshRun(id: runId) }
		.task { await store.refreshRun(id: runId) }
		.alert("Couldn't do that", isPresented: Binding(
			get: { errorMessage != nil },
			set: { if !$0 { errorMessage = nil } }
		)) {
			Button("OK", role: .cancel) { errorMessage = nil }
		} message: {
			Text(errorMessage ?? "")
		}
	}

	private func content(_ run: RunDigest) -> some View {
		List {
			Section {
				summary(run)
			}

			if let ask = run.ask {
				Section("Needs you") {
					AskCard(ask: ask) { draft in
						perform { try await store.answer(ask: ask, text: draft.text, answers: draft.answers) }
					}
					// A new question gets a fresh draft.
					.id(ask.id + String(ask.askedAt ?? 0))
				}
			}

			if let error = run.error, !error.isEmpty {
				Section("Error") {
					Text(error).font(.callout).foregroundStyle(.red)
				}
			}

			Section("Phases") {
				ForEach(run.phases) { phase in
					NavigationLink(value: PhaseRoute(runId: run.id, phaseId: phase.id)) {
						phaseRow(phase, current: phase.id == run.phase)
					}
				}
			}

			if !run.findings.isEmpty {
				Section("Findings") {
					ForEach(Array(run.findings.enumerated()), id: \.offset) { _, finding in
						FindingRow(finding: finding)
					}
				}
			}

			if let handoff = run.handoff {
				Section("Handoff note") {
					Text(handoff.text).font(.callout)
					if run.handoffStale == true {
						Text("The working tree has changed since this was written.")
							.font(.caption)
							.foregroundStyle(.orange)
					}
				}
			}

			if !run.status.isFinished {
				Section("Controls") {
					controls(run)
				}
			}

			if run.canFixFindings {
				Section {
					Button("Fix remaining findings") {
						perform { try await store.runAction(.fixFindings, run: run.id) }
					}
				} footer: {
					Text("deck runs a follow-up on this run's worktree and pushes the fixes to its PR.")
				}
			}
		}
		.disabled(busy)
		.confirmationDialog(
			"Take over this phase?", isPresented: $confirmTakeover, titleVisibility: .visible
		) {
			Button("Take over") { takeOver(run) }
		} message: {
			Text("deck pauses the run and stops the phase session's turn so you can drive it.")
		}
		.confirmationDialog("Resume at which phase?", isPresented: $pickResumePhase, titleVisibility: .visible) {
			ForEach(run.phases) { phase in
				Button(phase.id == run.phase ? "\(phase.label) (current)" : phase.label) {
					perform { try await store.runAction(.resume, run: run.id, phase: phase.id) }
				}
			}
		} message: {
			Text("deck starts that phase in a fresh session.")
		}
	}

	private func summary(_ run: RunDigest) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			HStack(spacing: 6) {
				Chip(text: run.status.label, color: RunDisplay.color(run.status))
				Text(RunDisplay.phaseLine(run)).font(.subheadline)
			}
			Text("\(run.workflow.name) · \(run.projectName) · \(run.branch)")
				.font(.caption)
				.foregroundStyle(.secondary)
			HStack(spacing: 6) {
				if let issue = run.issue {
					link(issue.shortId, issue.url)
				}
				if let pr = run.pr {
					link("PR #\(pr.number)", pr.url)
				}
				if run.blockers > 0 {
					Chip(text: run.blockers == 1 ? "1 blocker" : "\(run.blockers) blockers", color: .red)
				}
				if run.humanTouched {
					Chip(text: "hand edited")
				}
				if run.followUp == true {
					Chip(text: "follow-up", color: .accentColor)
				}
			}
			if let block = run.block, run.status == .blocked {
				Text(block.question).font(.callout)
			}
		}
		.padding(.vertical, 2)
	}

	@ViewBuilder
	private func link(_ text: String, _ url: String?) -> some View {
		if let url, let target = URL(string: url) {
			Link(destination: target) { Chip(text: text, color: .accentColor) }
		} else {
			Chip(text: text)
		}
	}

	private func phaseRow(_ phase: RunPhase, current: Bool) -> some View {
		HStack(spacing: 10) {
			PhaseStatusIcon(phase: phase, current: current)
			VStack(alignment: .leading, spacing: 2) {
				Text(phase.label).font(current ? .body.weight(.semibold) : .body)
				if phase.visits > 0 {
					Text(RunDisplay.rounds(phase))
						.font(.caption)
						.foregroundStyle(.secondary)
				}
			}
			Spacer()
			if current { Chip(text: "current", color: .accentColor) }
			if !phase.decisions.isEmpty {
				Chip(text: phase.decisions.count == 1 ? "1 decision" : "\(phase.decisions.count) decisions")
			}
		}
	}

	@ViewBuilder
	private func controls(_ run: RunDigest) -> some View {
		// deck refuses to pause a blocked run (take it over instead).
		if run.status != .paused && run.status != .blocked {
			Button("Pause") { perform { try await store.runAction(.pause, run: run.id) } }
		}
		Button("Resume at…") { pickResumePhase = true }
		if run.latestSessionId != nil {
			Button("Take over") { confirmTakeover = true }
		}
	}

	private func takeOver(_ run: RunDigest) {
		perform {
			try await store.runAction(.takeover, run: run.id)
			if let sessionId = store.runs.first(where: { $0.id == run.id })?.latestSessionId ?? run.latestSessionId {
				onOpenSession(sessionId)
			}
		}
	}

	private func perform(_ action: @escaping () async throws -> Void) {
		busy = true
		Task {
			do {
				try await action()
			} catch DeckError.http(_, let message) {
				// deck's own reason, e.g. a 409 for a PR that is already merged.
				errorMessage = message
			} catch {
				errorMessage = error.localizedDescription
			}
			busy = false
		}
	}
}

struct FindingRow: View {
	let finding: RunFinding

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				Chip(text: finding.severity, color: finding.severity == "blocker" ? .red : .secondary)
				Text(finding.line.map { "\(finding.file):\($0)" } ?? finding.file)
					.font(.caption.monospaced())
					.lineLimit(1)
					.truncationMode(.middle)
			}
			Text(finding.defect).font(.callout)
			if let fix = finding.fix, !fix.isEmpty {
				Text("Fix: \(fix)").font(.caption).foregroundStyle(.secondary)
			}
			if let keep = finding.keep, !keep.isEmpty {
				Text("Keep: \(keep)").font(.caption).foregroundStyle(.secondary)
			}
		}
		.padding(.vertical, 2)
	}
}

/// One phase: a session per round (a looping phase ran several), and the calls
/// the overseer, a person, or the engine made on it, with their reasons.
struct PhaseView: View {
	@Environment(DeckStore.self) private var store
	let route: PhaseRoute

	private var run: RunDigest? { store.runs.first { $0.id == route.runId } }
	private var phase: RunPhase? { run?.phases.first { $0.id == route.phaseId } }

	var body: some View {
		Group {
			if let phase {
				List {
					Section("Rounds") {
						if phase.sessions.isEmpty {
							Text("Not run yet").foregroundStyle(.secondary)
						}
						ForEach(phase.sessions, id: \.visit) { session in
							if let sessionId = session.sessionId {
								NavigationLink(value: sessionId) { roundRow(session) }
							} else {
								roundRow(session)
							}
						}
					}
					if !phase.decisions.isEmpty {
						Section("Decisions") {
							ForEach(Array(phase.decisions.enumerated()), id: \.offset) { _, decision in
								DecisionRow(decision: decision)
							}
						}
					}
				}
			} else {
				ContentUnavailableView("Phase not found", systemImage: "questionmark.circle")
			}
		}
		.navigationTitle(phase?.label ?? "Phase")
		.navigationBarTitleDisplayMode(.inline)
	}

	private func roundRow(_ session: PhaseSession) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				Text("Round \(session.visit)").font(.body.weight(.medium))
				Chip(text: session.result ?? "running", color: color(session.result))
				if session.humanTouched == true { Chip(text: "hand edited") }
				Spacer()
				Text(RelativeFormat.string(session.startedAt))
					.font(.caption2)
					.foregroundStyle(.secondary)
			}
			if let detail = session.detail, !detail.isEmpty {
				Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
			}
		}
	}

	private func color(_ result: String?) -> Color {
		switch result {
		case "pass": return .green
		case "fail", "error": return .red
		case nil: return .accentColor
		default: return .secondary
		}
	}
}

struct DecisionRow: View {
	let decision: RunDecision

	var body: some View {
		VStack(alignment: .leading, spacing: 4) {
			HStack(spacing: 6) {
				Chip(text: decision.by, color: decision.by == "overseer" ? .purple : .secondary)
				Text(decision.action).font(.subheadline.weight(.medium))
				Spacer()
				Text(RelativeFormat.string(decision.at))
					.font(.caption2)
					.foregroundStyle(.secondary)
			}
			if !decision.reason.isEmpty {
				Text(decision.reason).font(.callout)
			}
		}
		.padding(.vertical, 2)
	}
}
