import SwiftUI
import DeckKit
import DeckUI

/// One session: its transcript (or terminal, for a shell), the question it is
/// waiting on, and a composer.
struct MacSessionDetail: View {
	let sessionId: String
	/// A rename can give a terminal session a new id; the window follows it.
	var onIdChanged: ((String) -> Void)?
	var onDeleted: (() -> Void)?

	@Environment(DeckStore.self) private var store
	@Environment(\.openWindow) private var openWindow
	@State private var viewModel: SessionDetailViewModel?
	@State private var terminal: TerminalPoller?
	@State private var voice: VoiceController?
	@State private var draft = ""
	@State private var images: [DeckImage] = []
	@State private var sending = false
	@State private var compacting = false
	@State private var sheet: MacSessionSheet?
	@State private var commentText = ""
	/// The model picked in the sheet, acted on once the sheet has gone so an
	/// expensive-model confirm has somewhere to present.
	@State private var modelPick: String??
	@State private var pendingExpensiveModel: String??

	private var session: SessionDigest? { store.sessions.first { $0.id == sessionId } }
	private var isTerminal: Bool { session?.kind == "shell" && store.supports(.terminal) }

	private var title: String {
		if let title = session?.title, !title.isEmpty { return title }
		if let cwd = session?.cwd, let last = cwd.split(separator: "/").last { return String(last) }
		return sessionId
	}

	/// Send, stop and compact for ⌘Return, ⌘. and ⇧⌘K (see DeckCommands).
	private var keyboardActions: DeckSessionActions {
		let canSend = !sending && !isTerminal
			&& (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
		let canCompact = session?.kind == "claude" && session?.context != nil
			&& session?.status != .running && !compacting
		return DeckSessionActions(
			send: canSend ? { if let viewModel { send(viewModel) } } : nil,
			stop: session?.status == .running ? { Task { await viewModel?.stop() } } : nil,
			compact: canCompact ? { compact() } : nil)
	}

	var body: some View {
		VStack(spacing: 0) {
			if isTerminal, let terminal {
				TerminalView(poller: terminal)
			} else if let viewModel {
				prHeader(viewModel)
				transcript(viewModel)
				AgentsBar(agents: viewModel.agents.running)
				if let voice, voice.enabled {
					Divider()
					VoiceBar(voice: voice)
				}
				Divider()
				footer(viewModel)
			} else {
				ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
			}
		}
		.navigationTitle(title)
		.navigationSubtitle(session?.cwd ?? "")
		.focusedSceneValue(\.deckSession, keyboardActions)
		.sheet(item: $sheet, onDismiss: applyModelPick) { sheet in
			if let viewModel {
				MacSessionSheetContent(
					sheet: sheet, sessionId: sessionId, title: title, session: session, viewModel: viewModel,
					commentText: $commentText,
					onModelPicked: { modelPick = .some($0) },
					onIdChanged: onIdChanged,
					onDeleted: onDeleted)
			}
		}
		.alert(
			"Expensive model",
			isPresented: Binding(
				get: { pendingExpensiveModel != nil },
				set: { if !$0 { pendingExpensiveModel = nil } })
		) {
			Button("Cancel", role: .cancel) {}
			Button("Switch Anyway") {
				guard let model = pendingExpensiveModel else { return }
				Task { await viewModel?.changeModel(model) }
			}
		} message: {
			Text("\((pendingExpensiveModel ?? nil) ?? "") is an expensive model. Switch this session to it anyway?")
		}
		.toolbar {
			if !isTerminal, session?.status == .running, let viewModel {
				ToolbarItem {
					Button {
						Task { await viewModel.stop() }
					} label: {
						Label("Stop", systemImage: "stop.circle")
					}
				}
			}
			ToolbarItem {
				Button {
					openWindow(id: "browser")
				} label: {
					Label("Browser", systemImage: "globe")
				}
				.help("Open the dev browser")
			}
			if let viewModel {
				ToolbarItem {
					MacSessionMenu(
						session: session, viewModel: viewModel, compacting: compacting, sheet: $sheet,
						onCompact: compact, onModel: openModelSheet)
				}
			}
			if !isTerminal, let voice, voice.canRead {
				ToolbarItem {
					Button {
						if voice.enabled { voice.disable() } else { voice.enable() }
					} label: {
						Label(voice.enabled ? "Voice Off" : "Voice On", systemImage: voice.enabled ? "waveform.circle.fill" : "waveform.circle")
					}
					.help(voice.enabled ? "Turn voice mode off" : "Turn voice mode on")
				}
			}
		}
		.onAppear(perform: begin)
		// The mic serves one thing at a time: a session's voice mode pauses the
		// operator, which comes back when this ends.
		.onChange(of: voice?.enabled ?? false) { _, on in
			if on { OperatorController.shared.pause() } else { OperatorController.shared.resume() }
		}
		.onDisappear {
			viewModel?.leave()
			if voice?.enabled != true { OperatorController.shared.resume() }
		}
		.alert(
			"Something went wrong",
			isPresented: Binding(
				get: { viewModel?.errorMessage != nil },
				set: { if !$0 { viewModel?.errorMessage = nil } })
		) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(viewModel?.errorMessage ?? "")
		}
	}

	private func compact() {
		compacting = true
		Task {
			await viewModel?.compact()
			compacting = false
		}
	}

	private func openModelSheet() {
		let project = session.flatMap { SessionProject.owning($0, in: store.projects) }
		Task { await store.loadExpensiveModels(projectPath: project?.path) }
		sheet = .model
	}

	/// Switch to the model picked in the sheet, asking first when the server
	/// marks it expensive.
	private func applyModelPick() {
		guard let pick = modelPick else { return }
		modelPick = nil
		if let kind = session?.kind, store.needsExpensiveConfirm(model: pick, kind: kind, current: session?.model) {
			pendingExpensiveModel = .some(pick)
		} else {
			Task { await viewModel?.changeModel(pick) }
		}
	}

	@ViewBuilder
	private func prHeader(_ viewModel: SessionDetailViewModel) -> some View {
		if let pr = session?.pr {
			Group {
				if pr.state?.lowercased() == "open" {
					PRSection(
						pr: pr,
						canMerge: store.canMerge(pr),
						onApprove: { Task { await viewModel.review(decision: "approve", body: nil) } },
						onRequestChanges: { sheet = .comment(decision: "request-changes") },
						onComment: { sheet = .comment(decision: "comment") },
						onMerge: { sheet = .merge })
				} else {
					HStack {
						Image(systemName: "arrow.triangle.pull")
						PRStatusBadge(pr: pr)
						Spacer()
					}
				}
			}
			.padding()
			.background(.thinMaterial)
			Divider()
		}
	}

	private func begin() {
		Task { await store.refreshKinds() }
		if viewModel == nil { viewModel = SessionDetailViewModel(sessionId: sessionId, store: store) }
		if session?.kind == "shell" {
			if terminal == nil, let client = store.client { terminal = .shell(client: client, sessionId: sessionId) }
		} else if viewModel?.isPolling != true {
			viewModel?.startPolling()
		}
		if voice == nil, session?.kind != "shell", let controller = viewModel?.voiceController() {
			voice = controller
			if controller.capabilities == nil { Task { await controller.loadCapabilities() } }
		}
	}

	private func transcript(_ viewModel: SessionDetailViewModel) -> some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 12) {
					if viewModel.hasOlderHistory {
						Button("Load earlier messages") {
							Task { await viewModel.loadOlder() }
						}
						.disabled(viewModel.isLoadingOlder)
						.frame(maxWidth: .infinity)
					}
					if viewModel.isLoadingTranscript {
						ProgressView().frame(maxWidth: .infinity)
					}
					ForEach(TranscriptGroup.make(viewModel.items, condensed: true)) { group in
						if group.isCollapsedRun {
							DisclosureGroup("\(group.toolCount) tool calls") {
								ForEach(group.items) { MacTranscriptRow(item: $0, viewModel: viewModel) }
							}
						} else if let item = group.items.first {
							MacTranscriptRow(item: item, viewModel: viewModel)
						}
					}
					if !viewModel.streamingText.isEmpty {
						MacBubble(text: viewModel.streamingText, isUser: false, viewModel: nil)
					}
					if isWorking(viewModel) {
						MacWorkingRow()
					}
					Color.clear.frame(height: 1).id("bottom")
				}
				.padding()
				.frame(maxWidth: 860)
				.frame(maxWidth: .infinity)
			}
			.followsTranscriptEnd(isNearBottom: Bindable(viewModel).isNearBottom, proxy: proxy)
		}
	}

	/// A turn is under way and not stopped on a question, whose card already
	/// says what the session is waiting for.
	private func isWorking(_ viewModel: SessionDetailViewModel) -> Bool {
		!isTerminal && session?.status == .running && viewModel.pendingAsk == nil
	}

	@ViewBuilder
	private func footer(_ viewModel: SessionDetailViewModel) -> some View {
		if let ask = viewModel.pendingAsk {
			AskCard(ask: ask, maxQuestionsHeight: 320) { draft in
				Task { await viewModel.answer(ask: ask, draft: draft) }
			}
			.id(ask.id)
			.padding()
		} else {
			composer(viewModel)
		}
	}

	private func composer(_ viewModel: SessionDetailViewModel) -> some View {
		MacComposer(
			draft: $draft,
			images: $images,
			sending: sending,
			working: isWorking(viewModel),
			onStop: { Task { await viewModel.stop() } },
			onSend: { send(viewModel) },
			onQuickMessage: { text in Task { await viewModel.sendQuickMessage(text: text) } },
			onManageQuickMessages: { sheet = .quickMessages },
			session: session)
	}

	private func send(_ viewModel: SessionDetailViewModel) {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let attached = images
		guard !text.isEmpty || !attached.isEmpty, !sending else { return }
		sending = true
		Task {
			if await viewModel.sendComposer(text: text, images: attached) {
				draft = ""
				images = []
			}
			sending = false
		}
	}
}

private struct MacTranscriptRow: View {
	let item: TranscriptItem
	let viewModel: SessionDetailViewModel

	var body: some View {
		switch item {
		case .user(_, let text, let images):
			MacBubble(text: text, isUser: true, images: images, viewModel: viewModel)
		case .assistant(_, let text):
			MacBubble(text: text, isUser: false, viewModel: viewModel)
				.contextMenu {
					Button("Copy") { TextClipboard.copy(text) }
				}
		case .thinking(_, let text):
			DisclosureGroup("thinking") {
				MarkdownText(text).font(.footnote).padding(.top, 4)
			}
			.font(.caption)
			.foregroundStyle(.secondary)
		case .tool(let call):
			ToolCallCard(call: call)
			let steps = viewModel.steps[call.id] ?? []
			let agent = viewModel.agents.agent(forCall: call.id)
			if !steps.isEmpty || agent != nil {
				SubagentSteps(steps: steps, agent: agent) { MacTranscriptRow(item: $0, viewModel: viewModel) }
			}
		case .notice(_, let text, let level):
			Text(text)
				.font(.caption)
				.foregroundStyle(level == .error ? .red : level == .warning ? .orange : .secondary)
				.frame(maxWidth: .infinity, alignment: level == .info ? .center : .leading)
		}
	}
}

/// The last row while a turn runs, so a reply that has not started streaming
/// yet still shows the session is busy.
private struct MacWorkingRow: View {
	var body: some View {
		HStack {
			WorkingLabel()
				.padding(.horizontal, 10)
				.padding(.vertical, 8)
				.background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
			Spacer(minLength: 60)
		}
	}
}

/// A message: its images, its text, and the local files it mentions.
private struct MacBubble: View {
	let text: String
	let isUser: Bool
	var images: [TranscriptImage] = []
	let viewModel: SessionDetailViewModel?

	var body: some View {
		HStack {
			if isUser { Spacer(minLength: 60) }
			VStack(alignment: .leading, spacing: 6) {
				if !images.isEmpty {
					ScrollView(.horizontal, showsIndicators: false) {
						HStack(spacing: 6) {
							ForEach(Array(images.enumerated()), id: \.offset) { _, image in
								AttachmentImage(image: image, viewModel: viewModel)
							}
						}
					}
				}
				if !text.isEmpty {
					Group {
						if isUser { Text(text) } else { MarkdownText(text) }
					}
					.textSelection(.enabled)
				}
				if let viewModel, !text.isEmpty {
					FileAttachments(text: text, viewModel: viewModel)
				}
			}
			.padding(10)
			.background(
				isUser ? Color.accentColor.opacity(0.15) : Color(nsColor: .controlBackgroundColor),
				in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
			if !isUser { Spacer(minLength: 60) }
		}
	}
}

/// The shared inbox and run views push a session by this name; on the Mac it
/// is the Mac detail.
typealias SessionDetailView = MacSessionDetail
