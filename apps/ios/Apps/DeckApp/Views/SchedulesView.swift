import DeckKit
import SwiftUI

/// Schedules (deck#235): prompts that run on a clock. deck owns the clock, so
/// this lists what it has, edits them, and asks it to run one now; it never
/// works out when something is due.
struct SchedulesView: View {
	/// Opened from a session to extend it into a schedule, which pre-points the
	/// new one at that session. Nil opens the plain list.
	var startFor: String?

	@Environment(DeckStore.self) private var store
	@State private var schedules: [DeckSchedule] = []
	@State private var loaded = false
	@State private var loadError: String?
	@State private var editing: ScheduleEdit?
	@State private var busyId: String?
	@State private var started = false

	var body: some View {
		List {
			if let loadError {
				Section {
					Text(loadError).font(.footnote).foregroundStyle(.red)
				}
			}
			ForEach(schedules) { schedule in
				Section {
					row(schedule)
				}
			}
			if loaded && schedules.isEmpty {
				Section {
					Text("Nothing scheduled. Add one to run a prompt on a clock, in a fresh session each time or in one that keeps what it has learned.")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
			}
		}
		.navigationTitle("Schedules")
		.navigationBarTitleDisplayMode(.inline)
		.overlay {
			if !loaded && loadError == nil { ProgressView() }
		}
		.toolbar {
			ToolbarItem(placement: .primaryAction) {
				Button {
					editing = ScheduleEdit(draft: newDraft())
				} label: {
					Label("New schedule", systemImage: "plus")
				}
			}
		}
		.refreshable { await load() }
		.task {
			await load()
			// Once: a later refresh must not reopen the form after it has been
			// used or dismissed.
			if let startFor, !started {
				started = true
				editing = ScheduleEdit(draft: ScheduleDraft(sessionId: startFor))
			}
		}
		.sheet(item: $editing) { edit in
			ScheduleFormView(scheduleId: edit.scheduleId, draft: edit.draft) {
				Task { await load() }
			}
		}
	}

	@ViewBuilder
	private func row(_ schedule: DeckSchedule) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 8) {
				Text(schedule.title)
					.font(.subheadline.weight(.medium))
					.lineLimit(2)
				Spacer(minLength: 4)
				if let outcome = schedule.lastOutcome, outcome != .unknown {
					Text(outcome.label)
						.font(.caption2)
						.padding(.horizontal, 6)
						.padding(.vertical, 2)
						.background(tone(outcome).opacity(0.18), in: Capsule())
						.foregroundStyle(tone(outcome))
				}
				Toggle("", isOn: Binding(get: { schedule.enabled }, set: { on in toggle(schedule, on) }))
					.labelsHidden()
					.disabled(busyId == schedule.id)
					.accessibilityLabel(schedule.enabled ? "Pause \(schedule.title)" : "Resume \(schedule.title)")
			}

			HStack(spacing: 6) {
				Text(schedule.cron).font(.caption.monospaced())
				Text("·").foregroundStyle(.tertiary)
				Image(systemName: schedule.isOngoing ? "arrow.triangle.2.circlepath" : "plus.square.on.square")
					.font(.caption2)
				Text(schedule.targetLabel)
					.font(.caption)
					.lineLimit(1)
					.foregroundStyle(schedule.targetMissing ? .red : .secondary)
			}
			.foregroundStyle(.secondary)

			if schedule.enabled, let next = schedule.nextRun {
				Label(ScheduleFormat.due(next), systemImage: "clock")
					.font(.caption)
					.foregroundStyle(.secondary)
			}

			Text(schedule.prompt)
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(2)

			if let note = schedule.lastNote {
				Text(note)
					.font(.caption2)
					.foregroundStyle(schedule.lastOutcome == .failed ? .red : .secondary)
			} else if let last = schedule.lastRun {
				Text("Last ran \(ScheduleFormat.ago(last))")
					.font(.caption2)
					.foregroundStyle(.secondary)
			}

			HStack(spacing: 16) {
				Button {
					runNow(schedule)
				} label: {
					Label("Run now", systemImage: "play.fill").font(.caption)
				}
				.disabled(busyId == schedule.id)

				Button {
					editing = ScheduleEdit(scheduleId: schedule.id, draft: ScheduleDraft(editing: schedule))
				} label: {
					Label("Edit", systemImage: "pencil").font(.caption)
				}

				if let sessionId = schedule.lastSessionId {
					Button {
						NotificationCenter.default.post(name: .deckOpenSession, object: sessionId)
					} label: {
						Label("Last run", systemImage: "arrow.up.right.square").font(.caption)
					}
				}
			}
			.buttonStyle(.borderless)
			.padding(.top, 2)
		}
		.padding(.vertical, 2)
		.opacity(schedule.enabled ? 1 : 0.6)
		.swipeActions(edge: .trailing) {
			Button(role: .destructive) {
				remove(schedule)
			} label: {
				Label("Delete", systemImage: "trash")
			}
		}
	}

	private func tone(_ outcome: ScheduleOutcome) -> Color {
		switch outcome {
		case .ran: return .green
		case .failed: return .red
		case .skipped, .unknown: return .secondary
		}
	}

	/// A new schedule starts on whichever project the session list is mostly
	/// about, so the common case needs no picking.
	private func newDraft() -> ScheduleDraft {
		ScheduleDraft(cwd: store.projects.first?.path)
	}

	private func load() async {
		guard let client = store.client else { return }
		do {
			schedules = try await client.schedules()
			loadError = nil
		} catch {
			loadError = error.localizedDescription
		}
		loaded = true
	}

	private func act(_ schedule: DeckSchedule, _ work: @escaping (DeckClient) async throws -> Void) {
		guard let client = store.client else { return }
		busyId = schedule.id
		Task {
			do {
				try await work(client)
				loadError = nil
			} catch {
				loadError = error.localizedDescription
			}
			await load()
			busyId = nil
		}
	}

	private func toggle(_ schedule: DeckSchedule, _ on: Bool) {
		act(schedule) { try await $0.setScheduleEnabled(id: schedule.id, enabled: on) }
	}

	private func runNow(_ schedule: DeckSchedule) {
		act(schedule) { try await $0.runScheduleNow(id: schedule.id) }
	}

	private func remove(_ schedule: DeckSchedule) {
		act(schedule) { try await $0.deleteSchedule(id: schedule.id) }
	}
}

/// What the form is open on: a new schedule when `scheduleId` is nil, otherwise
/// the one being changed. A struct rather than two pieces of state, so the sheet
/// cannot end up open on a stale pairing of the two. Its identity is its own
/// token, not the schedule id, which a new schedule does not have yet.
private struct ScheduleEdit: Identifiable {
	let id = UUID()
	var scheduleId: String?
	var draft: ScheduleDraft
}

// MARK: - Form

/// Add or change one schedule. The target choice comes first because
/// everything under it depends on the answer.
struct ScheduleFormView: View {
	let scheduleId: String?
	@State var draft: ScheduleDraft
	var onSaved: () -> Void

	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var preview = SchedulePreview.empty
	@State private var isSaving = false
	@State private var errorMessage: String?
	/// Which shape the form is in. Held separately from the draft so switching
	/// back and forth keeps whichever session or project was picked.
	@State private var ongoing: Bool
	@State private var pickedSession: String
	@State private var pickedCwd: String

	init(scheduleId: String?, draft: ScheduleDraft, onSaved: @escaping () -> Void) {
		self.scheduleId = scheduleId
		self.onSaved = onSaved
		_draft = State(initialValue: draft)
		_ongoing = State(initialValue: draft.sessionId != nil)
		_pickedSession = State(initialValue: draft.sessionId ?? "")
		_pickedCwd = State(initialValue: draft.cwd ?? "")
	}

	/// Only sessions that can take a prompt: a terminal has nothing to send to.
	private var promptable: [SessionDigest] {
		store.sessions.filter { $0.kind != "shell" && $0.status != .dead }
	}

	var body: some View {
		NavigationStack {
			Form {
				Section {
					Picker("Each run", selection: $ongoing) {
						Text("Starts a new session").tag(false)
						Text("Sends to one session").tag(true)
					}
					.pickerStyle(.segmented)

					if ongoing {
						Picker("Session", selection: $pickedSession) {
							Text("Pick one").tag("")
							ForEach(promptable) { session in
								Text(session.title ?? session.id).tag(session.id)
							}
						}
					} else {
						Picker("Project", selection: $pickedCwd) {
							Text("Pick one").tag("")
							ForEach(store.projects) { project in
								Text(project.name).tag(project.path)
							}
						}
					}
				} footer: {
					Text(ongoing
						? "The same session every time, so what it worked out last run is still there."
						: "A fresh session each time, so every run looks at the project as it stands.")
				}

				// The prompt before the cadence: it is the substance of a
				// schedule, and "ask for this, every weekday at 9am" is the order
				// someone describes one in.
				Section("Prompt") {
					TextField("What should it ask for?", text: $draft.prompt, axis: .vertical)
						.lineLimit(4...10)
						.accessibilityIdentifier("schedulePrompt")
				}

				Section("Repeat") {
					Picker("Preset", selection: $draft.cron) {
						ForEach(CronPreset.all, id: \.cron) { preset in
							Text(preset.label).tag(preset.cron)
						}
						if !CronPreset.all.contains(where: { $0.cron == draft.cron }) {
							Text("Custom").tag(draft.cron)
						}
					}
					TextField("Cron expression", text: $draft.cron)
						.font(.body.monospaced())
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
						.accessibilityIdentifier("scheduleCron")
					previewLine
				}

				Section("Name") {
					TextField("Taken from the prompt", text: $draft.title)
				}

				// Only a fresh session picks its own agent; an existing one is
				// already running one.
				if !ongoing {
					AutomationAgentSection(title: "Agent", agent: $draft.agent)
				}

				if let errorMessage {
					Section {
						Text(errorMessage).font(.footnote).foregroundStyle(.red)
					}
				}
			}
			.navigationTitle(scheduleId == nil ? "New schedule" : "Edit schedule")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
						.disabled(isSaving || !canSave)
				}
			}
			.task {
				await store.refreshProjects()
				await store.refreshKinds()
				await refreshPreview()
			}
			.onChange(of: draft.cron) { _, _ in Task { await refreshPreview() } }
		}
	}

	// deck has the last word on whether a schedule is valid; this only decides
	// whether the button can be pressed.
	private var canSave: Bool {
		let target = ongoing ? pickedSession : pickedCwd
		if target.isEmpty { return false }
		if draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
		return preview.problem == nil
	}

	@ViewBuilder
	private var previewLine: some View {
		if let problem = preview.problem {
			Text(problem).font(.caption).foregroundStyle(.red)
		} else if preview.dates.isEmpty {
			Text("That expression has no next run.").font(.caption).foregroundStyle(.orange)
		} else {
			Text("Next: \(preview.dates.map(ScheduleFormat.due).joined(separator: ", "))")
				.font(.caption)
				.foregroundStyle(.secondary)
		}
	}

	private func refreshPreview() async {
		guard let client = store.client else { return }
		preview = (try? await client.schedulePreview(cron: draft.cron)) ?? SchedulePreview.empty
	}

	private func save() async {
		guard let client = store.client else { return }
		isSaving = true
		errorMessage = nil
		var body = draft
		body.sessionId = ongoing ? pickedSession : nil
		body.cwd = ongoing ? nil : pickedCwd
		do {
			if let scheduleId { try await client.updateSchedule(id: scheduleId, body) }
			else { try await client.createSchedule(body) }
			onSaved()
			dismiss()
		} catch {
			errorMessage = error.localizedDescription
		}
		isSaving = false
	}
}

// MARK: - Formatting

/// Dates as a schedule means them: a wall-clock reading, with enough of the day
/// to place it.
enum ScheduleFormat {
	static func due(_ date: Date) -> String {
		let calendar = Calendar.current
		let time = date.formatted(date: .omitted, time: .shortened)
		let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: .now), to: calendar.startOfDay(for: date)).day ?? 0
		if days <= 0 { return time }
		if days == 1 { return "\(time) tomorrow" }
		if days < 7 { return "\(time) \(date.formatted(.dateTime.weekday(.abbreviated)))" }
		return "\(time) \(date.formatted(date: .abbreviated, time: .omitted))"
	}

	static func ago(_ date: Date) -> String {
		date.formatted(.relative(presentation: .numeric))
	}
}
