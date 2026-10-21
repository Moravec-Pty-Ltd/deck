import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import DeckKit
import DeckUI

struct SessionDetailView: View {
	let sessionId: String
	/// An event to open at (a search hit): older history loads back to it and
	/// the transcript scrolls there once.
	var focusIndex: Int? = nil
	/// A model the caller owns, so it outlives this view when a fold or unfold
	/// lays the session out again; without one the view makes and ends its own.
	var shared: SessionDetailViewModel? = nil
	/// Called when a rename moves the session's id, which happens for an
	/// unregistered tmux terminal: renaming it renames the tmux session and
	/// deck's derived id goes with it. Without this the open session would go
	/// blank the moment it was renamed.
	var onIdChanged: ((String) -> Void)? = nil

	@Environment(DeckStore.self) private var store
	@Environment(HingeMonitor.self) private var hinge
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss

	@State private var viewModel: SessionDetailViewModel?
	@State private var terminal: TerminalPoller?
	@State private var composerText = ""
	/// The phone layout's height, which caps how tall a pending question grows.
	@State private var stackedHeight: CGFloat = 0
	@State private var isSending = false
	@AppStorage("condensedTranscript") private var condensedTranscript = true
	@State private var composerFieldId = 0
	@State private var attachedImages: [DeckImage] = []
	@State private var photoItems: [PhotosPickerItem] = []
	@FocusState private var composerFocused: Bool
	@State private var showDeleteSheet = false
	@State private var showMergeSheet = false
	@State private var showModelSheet = false
	/// The model picked in the sheet, acted on once the sheet has gone so an
	/// expensive-model confirm has somewhere to present.
	@State private var modelPick: ModelPick?
	@State private var pendingExpensiveModel: String?
	@State private var showEffortSheet = false
	@State private var showQuickManage = false
	@State private var showRenameSheet = false
	@State private var compacting = false
	@State private var showCommentSheet = false
	@State private var showChanges = false
	@State private var showServers = false
	@State private var showBrowser = false
	@State private var showSchedule = false
	@State private var voice: VoiceController?
	@State private var commentText = ""
	@State private var pendingReviewDecision = "comment"
	/// The transcript row at the top of the screen while older history loads,
	/// so the prepended rows land above it instead of pushing it out of view.
	@State private var anchorId: String?
	@State private var focused = false
	@State private var highlightedId: String?

	/// What this screen reads from deck beyond the baseline routes.
	private static let needs: [DeckCapability] = [.stream, .history, .images, .files]

	private var session: SessionDigest? {
		store.sessions.first { $0.id == sessionId }
	}

	private var isAgentSession: Bool {
		guard let kind = session?.kind else { return false }
		return kind != "shell"
	}

	/// Switch to the model picked in the sheet, asking first when the server
	/// marks it expensive. A pick can beat the list's first load, so it waits
	/// for that load (a no-op once the list is in) before deciding.
	private func applyModelPick() {
		guard let pick = modelPick else { return }
		modelPick = nil
		Task {
			await loadExpensiveModels()
			if let kind = session?.kind, store.needsExpensiveConfirm(model: pick.model, kind: kind, current: session?.model) {
				pendingExpensiveModel = pick.model
			} else {
				await viewModel?.changeModel(pick.model)
			}
		}
	}

	private func loadExpensiveModels() async {
		let project = session.flatMap { SessionProject.owning($0, in: store.projects) }
		await store.loadExpensiveModels(projectPath: project?.path)
	}

	private func openModelSheet() {
		Task { await loadExpensiveModels() }
		showModelSheet = true
	}

	private var isTerminal: Bool {
		session?.kind == "shell" && store.supports(.terminal)
	}

	private func compact() async {
		compacting = true
		defer { compacting = false }
		await viewModel?.compact()
	}

	private var title: String {
		if let title = session?.title, !title.isEmpty { return title }
		if let cwd = session?.cwd, let last = cwd.split(separator: "/").last { return String(last) }
		return sessionId
	}

	/// Send, stop and compact for ⌘Return, ⌘. and ⇧⌘K (see DeckCommands).
	private var keyboardActions: DeckSessionActions {
		let canSend = !isSending && !isTerminal
			&& (!composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachedImages.isEmpty)
		let canCompact = session?.kind == "claude" && session?.context != nil
			&& session?.status != .running && !compacting
		return DeckSessionActions(
			send: canSend ? { if let viewModel { sendComposer(viewModel) } } : nil,
			stop: session?.status == .running ? { Task { await viewModel?.stop() } } : nil,
			compact: canCompact ? { Task { await compact() } } : nil)
	}

	var body: some View {
		content
			.safeAreaInset(edge: .top, spacing: 0) { ServerTooOldBanner(needs: Self.needs) }
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar { toolbarContent }
			.focusedSceneValue(\.deckSession, keyboardActions)
			.sheet(isPresented: $showDeleteSheet) {
				DeleteSessionSheet(hasWorktree: session?.worktree != nil) { deleteWorktree, deleteBranch in
					Task {
						if await viewModel?.delete(deleteWorktree: deleteWorktree, deleteBranch: deleteBranch) == true {
							dismiss()
						}
					}
				}
			}
			.sheet(isPresented: $showChanges) {
				ChangesSheet(sessionId: sessionId, title: title)
			}
			.sheet(isPresented: $showServers) {
				ServersSheet(sessionId: sessionId, title: title)
			}
			.sheet(isPresented: $showBrowser) {
				NavigationStack { BrowserView(sessionId: sessionId, isModal: true) }
			}
			.sheet(isPresented: $showSchedule) {
				NavigationStack { SchedulesView(startFor: sessionId) }
			}
			.sheet(isPresented: $showModelSheet, onDismiss: applyModelPick) {
				if let kind = session?.kind {
					ModelPickerSheet(
						kind: kind,
						current: session?.model,
						available: store.knownModels(for: kind)
					) { model in
						modelPick = ModelPick(model: model)
					}
				}
			}
			.alert(
				"Expensive model",
				isPresented: Binding(
					get: { pendingExpensiveModel != nil },
					set: { if !$0 { pendingExpensiveModel = nil } })
			) {
				Button("Cancel", role: .cancel) {}
				Button("Switch anyway") {
					let model = pendingExpensiveModel
					Task { await viewModel?.changeModel(model) }
				}
			} message: {
				Text("\(pendingExpensiveModel ?? "") is an expensive model. Switch this session to it anyway?")
			}
			.onAppear {
				if viewModel == nil {
					viewModel = shared ?? SessionDetailViewModel(sessionId: sessionId, store: store)
				}
				if viewModel?.isPolling != true, session?.kind != "shell" { viewModel?.startPolling() }
				if terminal == nil, let client = store.client {
					terminal = .shell(client: client, sessionId: sessionId)
				}
				Task { await store.refreshKinds() }
				if voice == nil, isAgentSession, store.supports(.speech), let controller = viewModel?.voiceController() {
					voice = controller
					if controller.capabilities == nil { Task { await controller.loadCapabilities() } }
				}
				if let session, session.status == .running { ActivityManager.shared.start(session) }
			}
			.onChange(of: session?.status) { _, status in
				if status == .running, let session { ActivityManager.shared.start(session) }
			}
			// The mic serves one thing at a time: a session's voice mode pauses
			// the operator, which comes back when this ends.
			.onChange(of: voice?.enabled ?? false) { _, on in
				if on { OperatorController.shared.pause() } else { OperatorController.shared.resume() }
			}
			.onDisappear {
				if shared == nil { viewModel?.leave() }
				if voice?.enabled != true { OperatorController.shared.resume() }
			}
	}

	@ToolbarContentBuilder
	private var toolbarContent: some ToolbarContent {
		ToolbarItem(placement: .topBarTrailing) {
			if session?.status == .running {
				Button("Stop", role: .destructive) {
					Task { await viewModel?.stop() }
				}
			}
		}
		ToolbarItem(placement: .topBarTrailing) {
			if let voice, voice.canRead {
				Button {
					if voice.enabled { voice.disable() } else { voice.enable() }
				} label: {
					Image(systemName: voice.enabled ? "waveform.circle.fill" : "waveform.circle")
				}
				.accessibilityLabel(voice.enabled ? "Turn voice mode off" : "Turn voice mode on")
			}
		}
		ToolbarItem(placement: .topBarTrailing) {
			Button {
				showBrowser = true
			} label: {
				Image(systemName: "globe")
			}
			.accessibilityLabel("Browser")
			.accessibilityIdentifier("openBrowser")
		}
		ToolbarItem(placement: .topBarTrailing) {
			Menu {
				if isAgentSession {
					Menu {
						ForEach(store.kinds.filter { $0.available && $0.kind != "shell" }) { agent in
							Button(agent.kind) {
								Task { await viewModel?.changeAgent(agent.kind) }
							}
							.disabled(agent.kind == session?.kind)
						}
					} label: {
						Label("Agent: \(session?.kind ?? "default")", systemImage: "arrow.triangle.swap")
					}
					.disabled(session?.status == .running)
					Button {
						openModelSheet()
					} label: {
						Label(session?.model.map { "Model: \($0)" } ?? "Change model", systemImage: "cpu")
					}
				}
				if session?.kind == "claude" {
					Button {
						showEffortSheet = true
					} label: {
						Label(session?.effort.map { "Thinking: \($0)" } ?? "Thinking level", systemImage: "brain")
					}
				}
				if session?.kind == "claude", let context = session?.context {
					Button {
						Task { await compact() }
					} label: {
						Label(
							"Compact context (\(context.percent)%)",
							systemImage: "arrow.down.right.and.arrow.up.left")
					}
					.disabled(session?.status == .running || compacting)
					.accessibilityIdentifier("compactSession")
				}
				if session?.kind == "claude" {
					// deck restarts only an idle session (a running turn is a 409).
					Button {
						Task { await viewModel?.restart() }
					} label: {
						Label("Restart claude", systemImage: "arrow.clockwise")
					}
					.disabled(session?.status == .running)
					.accessibilityIdentifier("restartSession")
				}
				Button {
					showRenameSheet = true
				} label: {
					Label("Rename", systemImage: "pencil")
				}
				.accessibilityIdentifier("renameSession")
				if store.supports(.diff) {
					Button {
						showChanges = true
					} label: {
						Label("Changes", systemImage: "plus.forwardslash.minus")
					}
				}
				if store.supports(.servers) {
					Button {
						showServers = true
					} label: {
						Label("Dev servers", systemImage: "server.rack")
					}
				}
				// Extend this session into a schedule (deck#235): the form opens
				// already pointed at it, so the prompt comes back here every run
				// with whatever it has already worked out still loaded.
				Button {
					showSchedule = true
				} label: {
					Label("Repeat on a schedule", systemImage: "clock.arrow.2.circlepath")
				}
				.accessibilityIdentifier("scheduleSession")
				ForEach(session?.issues ?? [], id: \.id) { issue in
					if let urlString = issue.url, let link = URL(string: urlString) {
						Button {
							openURL(link)
						} label: {
							Label(
							issue.repo.map { "Issue \(issue.shortId) · \($0)" } ?? "Issue \(issue.shortId)",
							systemImage: "smallcircle.filled.circle")
						}
					}
				}
				if let pr = session?.pr, let urlString = pr.url, let link = URL(string: urlString) {
					Button {
						openURL(link)
					} label: {
						Label("PR #\(pr.number ?? 0)", systemImage: "arrow.triangle.pull")
					}
				}
				if session?.pr != nil, store.supports(.prDismiss) {
					Button {
						Task { await viewModel?.dismissPR() }
					} label: {
						Label("Dismiss PR", systemImage: "xmark.circle")
					}
					.accessibilityIdentifier("dismissPR")
				}
				Button(role: .destructive) {
					showDeleteSheet = true
				} label: {
					Label("Delete session", systemImage: "trash")
				}
			} label: {
				Image(systemName: "ellipsis.circle")
			}
			.accessibilityLabel("Session actions")
			.accessibilityIdentifier("sessionMenu")
		}
	}

	@ViewBuilder
	private var content: some View {
		if let viewModel {
			Group {
				if isTerminal, let terminal {
					TerminalView(poller: terminal)
				} else if hinge.isTabletop {
					tabletop(viewModel)
				} else {
					stacked(viewModel)
				}
			}
			.sheet(isPresented: $showMergeSheet) {
				MergeSheet(pr: session?.pr) { method, deleteBranch in
					Task { await viewModel.merge(method: method, deleteBranch: deleteBranch) }
				}
			}
			.sheet(isPresented: $showQuickManage) {
				QuickMessagesSheet()
			}
			.sheet(isPresented: $showRenameSheet) {
				RenameSessionSheet(current: title) { newTitle in
					do {
						let id = try await store.rename(sessionId: sessionId, title: newTitle)
						if id != sessionId { onIdChanged?(id) }
						return nil
					} catch {
						return error.localizedDescription
					}
				}
			}
			.sheet(isPresented: $showEffortSheet) {
				EffortPickerSheet(current: session?.effort) { effort in
					Task { await viewModel.changeEffort(effort) }
				}
			}
			.sheet(isPresented: $showCommentSheet) {
				CommentSheet(
					title: pendingReviewDecision == "request-changes" ? "Request changes" : "Comment",
					text: $commentText
				) {
					Task {
						await viewModel.review(decision: pendingReviewDecision, body: commentText)
						commentText = ""
					}
				}
			}
			.alert(
				"Something went wrong",
				isPresented: Binding(
					get: { viewModel.errorMessage != nil },
					set: { if !$0 { viewModel.errorMessage = nil } })
			) {
				Button("OK", role: .cancel) {}
			} message: {
				Text(viewModel.errorMessage ?? "")
			}
		} else {
			ProgressView()
				.frame(maxWidth: .infinity, maxHeight: .infinity)
		}
	}

	/// The phone layout: one column, the composer at the bottom.
	private func stacked(_ viewModel: SessionDetailViewModel) -> some View {
		VStack(spacing: 0) {
			prHeader(viewModel)
			transcriptPicker
			transcript(viewModel)
			if session?.status == .running {
				workingIndicator
			}
			askCard(viewModel, available: stackedHeight)
			if let voice, voice.enabled {
				Divider()
				VoiceBar(voice: voice)
			}
			Divider()
			composer(viewModel)
		}
		.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { stackedHeight = $0 }
	}

	/// Half open on a table: the transcript stands on the upper half, voice
	/// mode lies on the lower half where the hands are, with the question card
	/// and the composer under it.
	private func tabletop(_ viewModel: SessionDetailViewModel) -> some View {
		GeometryReader { geometry in
			VStack(spacing: 0) {
				VStack(spacing: 0) {
					prHeader(viewModel)
					transcriptPicker
					transcript(viewModel)
					if session?.status == .running {
						workingIndicator
					}
				}
				.frame(height: upperHeight(in: geometry))
				Divider()
				VStack(spacing: 0) {
					// The keyboard takes the flat half while typing, so the voice
					// controls step aside for it.
					if !composerFocused, let voice {
						Group {
							if voice.enabled {
								VoiceDeck(voice: voice)
							} else {
								voiceInvitation
							}
						}
						.frame(maxHeight: viewModel.pendingAsk == nil ? .infinity : nil)
					}
					if viewModel.pendingAsk != nil {
						askCard(viewModel, available: geometry.size.height - upperHeight(in: geometry))
						Spacer(minLength: 0)
					} else if composerFocused || voice == nil {
						Spacer(minLength: 0)
					}
					Divider()
					composer(viewModel)
				}
				.frame(maxHeight: .infinity)
			}
		}
	}

	/// How much of this view stands above the fold: from its top down to the
	/// window's midline, leaving the composer room below when the keyboard
	/// takes the rest.
	private func upperHeight(in geometry: GeometryProxy) -> CGFloat {
		let fold = hinge.foldY ?? geometry.size.height / 2
		let top = fold - geometry.frame(in: .global).minY
		return min(max(top, 120), max(geometry.size.height - 80, 120))
	}

	private var voiceInvitation: some View {
		VStack(spacing: 12) {
			Image(systemName: "waveform.circle")
				.font(.largeTitle)
				.imageScale(.large)
				.foregroundStyle(.secondary)
			if let voice, voice.canRead {
				Button("Start voice mode") { voice.enable() }
					.buttonStyle(.borderedProminent)
				Text("Replies are read aloud. Hold the button to talk back.")
					.font(.footnote)
					.foregroundStyle(.secondary)
			} else {
				Text("Voice mode needs a speech server in deck's settings.")
					.font(.footnote)
					.foregroundStyle(.secondary)
			}
		}
		.multilineTextAlignment(.center)
		.padding()
		.frame(maxWidth: .infinity)
	}

	@ViewBuilder
	private func prHeader(_ viewModel: SessionDetailViewModel) -> some View {
		if let pr = session?.pr {
			if pr.state?.lowercased() == "open" {
				PRSection(
					pr: pr,
					canMerge: store.canMerge(pr),
					onApprove: { Task { await viewModel.review(decision: "approve", body: nil) } },
					onRequestChanges: { commentPrompt(decision: "request-changes") },
					onComment: { commentPrompt(decision: "comment") },
					onMerge: { showMergeSheet = true }
				)
				.padding()
				.background(.thinMaterial)
			} else {
				HStack {
					Image(systemName: "arrow.triangle.pull")
					PRStatusBadge(pr: pr)
					Spacer()
				}
				.padding()
				.background(.thinMaterial)
			}
		}
	}

	private var transcriptPicker: some View {
		Picker("Transcript", selection: $condensedTranscript) {
			Text("Chat").tag(true)
			Text("Thread").tag(false)
		}
		.pickerStyle(.segmented)
		.padding(.horizontal)
		.padding(.vertical, 8)
	}

	@ViewBuilder
	private func askCard(_ viewModel: SessionDetailViewModel, available: CGFloat) -> some View {
		if let ask = viewModel.pendingAsk {
			AskCard(ask: ask, maxQuestionsHeight: available > 0 ? available / 2 : nil) { draft in
				Task { await viewModel.answer(ask: ask, draft: draft) }
			}
			.id(ask.id)
			.padding()
			.deckGlass()
			.padding(.horizontal, 8)
			.padding(.vertical, 4)
		}
	}

	private var workingIndicator: some View {
		HStack {
			WorkingLabel()
			Spacer()
		}
		.padding(.horizontal)
		.padding(.vertical, 6)
		.background(.thinMaterial)
	}

	private func transcript(_ viewModel: SessionDetailViewModel) -> some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 12) {
					if viewModel.hasOlderHistory {
						olderHistoryRow(viewModel)
					}
					ForEach(TranscriptGroup.make(viewModel.items, condensed: condensedTranscript)) { group in
						if group.isCollapsedRun {
							DisclosureGroup("\(group.toolCount) tool calls") {
								ForEach(group.items) { TranscriptRow(item: $0, viewModel: viewModel, voice: voice) }
							}
							.id(group.id)
						} else if let item = group.items.first {
							TranscriptRow(item: item, viewModel: viewModel, voice: voice)
								.id(group.id)
								.overlay {
									if highlightedId == group.id {
										RoundedRectangle(cornerRadius: DeckStyle.Radius.card)
											.stroke(Color.accentColor, lineWidth: 2)
											.padding(-4)
									}
								}
						}
					}
					if !viewModel.streamingText.isEmpty {
						HStack {
							MarkdownText(viewModel.streamingText)
								.padding(10)
								.background(Color(.secondarySystemBackground))
								.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
							Spacer(minLength: 40)
						}
						.id("streaming")
					}
					// A fixed-size end marker to scroll to: aiming at the last row
					// itself lands short while the lazy stack is still estimating
					// heights it has not laid out.
					Color.clear.frame(height: 1).id("bottom")
				}
				.padding()
			}
			.scrollDismissesKeyboard(.interactively)
			.onScrollGeometryChange(for: ScrollEdges.self) { geometry in
				ScrollEdges(offset: geometry.contentOffset.y, top: geometry.contentOffset.y + geometry.contentInsets.top)
			} action: { old, edges in
				guard edges.offset != old.offset else { return }
				if edges.top < 200, viewModel.hasOlderHistory, !viewModel.isLoadingOlder {
					loadOlderKeepingPlace(viewModel)
				}
			}
			// Older rows arriving above the reader hold their place rather than
			// pulling the view to the end.
			.followsTranscriptEnd(isNearBottom: Bindable(viewModel).isNearBottom, proxy: proxy, paused: anchorId != nil)
			.onChange(of: viewModel.didLoadOnce) { _, loaded in
				guard loaded, let focusIndex, !focused else { return }
				focused = true
				Task {
					if let id = await viewModel.itemId(forEventIndex: focusIndex) {
						anchorId = nil
						viewModel.isNearBottom = false
						withAnimation { proxy.scrollTo(id, anchor: .top) }
						highlightedId = id
						try? await Task.sleep(for: .seconds(2.5))
						highlightedId = nil
					}
				}
			}
			.onChange(of: viewModel.items.count) { _, _ in
				// Older rows arriving above the reader hold their place.
				if let anchorId {
					proxy.scrollTo(anchorId, anchor: .top)
					self.anchorId = nil
				}
			}
			.overlay {
				if viewModel.items.isEmpty && viewModel.streamingText.isEmpty {
					if viewModel.didLoadOnce {
						Text("No messages yet.")
							.font(.footnote)
							.foregroundStyle(.secondary)
					} else {
						VStack(spacing: 8) {
							ProgressView()
							Text("Connecting…")
								.font(.footnote)
								.foregroundStyle(.secondary)
						}
					}
				}
			}
		}
	}

	private func olderHistoryRow(_ viewModel: SessionDetailViewModel) -> some View {
		HStack {
			Spacer()
			if viewModel.isLoadingOlder {
				ProgressView().controlSize(.small)
			} else {
				Button("Load earlier") {
					loadOlderKeepingPlace(viewModel)
				}
				.font(.footnote)
			}
			Spacer()
		}
		.id("older")
	}

	private func loadOlderKeepingPlace(_ viewModel: SessionDetailViewModel) {
		guard anchorId == nil else { return }
		anchorId = TranscriptGroup.make(viewModel.items, condensed: condensedTranscript).first?.id
		let before = viewModel.items.count
		Task {
			let added = await viewModel.loadOlder()
			// Nothing new on screen means no items-count change to consume the
			// anchor, so release it here or no later load could start.
			if !added || viewModel.items.count == before { anchorId = nil }
		}
	}

	private func composer(_ viewModel: SessionDetailViewModel) -> some View {
		VStack(spacing: 6) {
			if !attachedImages.isEmpty {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 8) {
						ForEach(attachedImages) { image in
							attachmentThumbnail(image)
						}
					}
				}
				.frame(height: 56)
			}
			HStack(alignment: .bottom, spacing: 8) {
				if store.supports(.quickMessages) {
					Menu {
						let offered = store.quickMessages(for: session)
						if offered.isEmpty {
							Text("No quick messages")
						}
						ForEach(offered) { message in
							Button(message.displayLabel) {
								Task { await viewModel.sendQuickMessage(text: message.text) }
							}
						}
						Divider()
						Button {
							showQuickManage = true
						} label: {
							Label("Manage…", systemImage: "slider.horizontal.3")
						}
					} label: {
						Image(systemName: "text.append")
							.font(.title2)
					}
				}
				PhotosPicker(selection: $photoItems, maxSelectionCount: 8, matching: .images) {
					Image(systemName: "photo.on.rectangle")
						.font(.title2)
				}
				// A system paste control rather than our own button. Asking
				// UIPasteboard whether it has an image is a read, and with a
				// Universal Clipboard item from another device answering it means
				// fetching the item, which raises "Allow Paste?". This is drawn by
				// the system and the tap itself is the permission, so nothing asks.
				PasteButton(supportedContentTypes: [.image]) { providers in
					Task { await attach(providers) }
				}
				.labelStyle(.iconOnly)
				.buttonBorderShape(.circle)
				TextField("Message", text: $composerText, axis: .vertical)
					.textFieldStyle(.roundedBorder)
					.lineLimit(1...5)
					.id(composerFieldId)
					.focused($composerFocused)
					.accessibilityIdentifier("sessionComposer")
				// Our own control rather than a keyboard toolbar item: the system
				// draws those as a floating pill over the composer.
				if composerFocused {
					Button {
						composerFocused = false
					} label: {
						Image(systemName: "keyboard.chevron.compact.down")
							.font(.title3)
					}
					.accessibilityLabel("Hide the keyboard")
				}
				Button {
					sendComposer(viewModel)
				} label: {
					Image(systemName: "arrow.up.circle.fill")
						.font(.title2)
				}
				.disabled(composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachedImages.isEmpty)
			}
		}
		.padding()
		.deckGlass(in: Rectangle())
		.disabled(isSending)
		.onChange(of: photoItems) { _, items in
			Task { await loadPhotos(items) }
		}
	}

	private func attachmentThumbnail(_ image: DeckImage) -> some View {
		ZStack(alignment: .topTrailing) {
			if let data = Data(base64Encoded: image.data), let uiImage = UIImage(data: data) {
				Image(uiImage: uiImage)
					.resizable()
					.scaledToFill()
					.frame(width: 48, height: 48)
					.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
			}
			Button {
				attachedImages.removeAll { $0.id == image.id }
			} label: {
				Image(systemName: "xmark.circle.fill")
					.foregroundStyle(.white, .black.opacity(0.6))
			}
			.offset(x: 4, y: -4)
		}
	}

	private func sendComposer(_ viewModel: SessionDetailViewModel) {
		let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
		let images = attachedImages
		guard !text.isEmpty || !images.isEmpty else { return }
		guard !isSending else { return }
		isSending = true
		Task {
			if await viewModel.sendComposer(text: text, images: images) {
				composerText = ""
				attachedImages = []
				composerFieldId += 1
				composerFocused = true
			}
			isSending = false
		}
	}

	private func loadPhotos(_ items: [PhotosPickerItem]) async {
		for item in items {
			guard attachedImages.count < 8 else { break }
			if let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty {
				let isPNG = data.starts(with: [0x89, 0x50, 0x4E, 0x47])
				attachedImages.append(DeckImage(
					mediaType: isPNG ? "image/png" : "image/jpeg",
					data: data.base64EncodedString()))
			}
		}
		photoItems = []
	}

	/// Attach what the paste control handed over, up to the composer's limit.
	private func attach(_ providers: [NSItemProvider]) async {
		for provider in providers where attachedImages.count < 8 {
			guard let image = await Self.image(from: provider), let data = image.pngData() else { continue }
			attachedImages.append(DeckImage(mediaType: "image/png", data: data.base64EncodedString()))
		}
	}

	private static func image(from provider: NSItemProvider) async -> UIImage? {
		guard provider.canLoadObject(ofClass: UIImage.self) else { return nil }
		return await withCheckedContinuation { continuation in
			provider.loadObject(ofClass: UIImage.self) { object, _ in
				continuation.resume(returning: object as? UIImage)
			}
		}
	}

	private func commentPrompt(decision: String) {
		pendingReviewDecision = decision
		commentText = ""
		showCommentSheet = true
	}
}

/// Where the reader is in the transcript: the raw offset (to tell a scroll
/// from content growth) and the distance from the top of the content, in
/// points.
private struct ScrollEdges: Equatable {
	var offset: CGFloat
	var top: CGFloat
}

/// One row of the transcript: a message bubble, a tool card, a question card,
/// collapsed thinking, or a one-line aside.
struct TranscriptRow: View {
	let item: TranscriptItem
	var viewModel: SessionDetailViewModel?
	var voice: VoiceController?

	var body: some View {
		switch item {
		case .user(_, let text, let images):
			TranscriptBubble(text: text, isUser: true, images: images, viewModel: viewModel)
		case .assistant(_, let text):
			TranscriptBubble(text: text, isUser: false, viewModel: viewModel)
				.contextMenu {
					if let voice, voice.canRead {
						Button {
							voice.readAloud(text)
						} label: {
							Label("Read aloud", systemImage: "speaker.wave.2")
						}
					}
					Button {
						UIPasteboard.general.string = text
					} label: {
						Label("Copy", systemImage: "doc.on.doc")
					}
				}
		case .thinking(_, let text):
			DisclosureGroup("thinking") {
				MarkdownText(text)
					.font(.footnote)
					.padding(.top, 4)
			}
			.font(.caption)
			.foregroundStyle(.secondary)
		case .tool(let call):
			if call.isAsk {
				QuestionCard(call: call)
			} else {
				ToolCallCard(call: call)
			}
		case .notice(_, let text, let level):
			switch level {
			case .info:
				Text(text)
					.font(.caption)
					.foregroundStyle(.secondary)
					.frame(maxWidth: .infinity, alignment: .center)
			case .warning:
				Label(text, systemImage: "exclamationmark.triangle")
					.font(.caption)
					.foregroundStyle(.orange)
					.frame(maxWidth: .infinity, alignment: .leading)
			case .error:
				Text(text)
					.font(.caption)
					.foregroundStyle(.red)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
	}
}

struct TranscriptBubble: View {
	let text: String
	let isUser: Bool
	var images: [TranscriptImage] = []
	var viewModel: SessionDetailViewModel?

	var body: some View {
		HStack {
			if isUser { Spacer(minLength: 40) }
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
					if isUser {
						Text(text)
					} else {
						MarkdownText(text)
					}
				}
				if let viewModel, !text.isEmpty {
					FileAttachments(text: text, viewModel: viewModel)
				}
			}
			.padding(10)
			.background(isUser ? Color.accentColor.opacity(0.15) : Color(.secondarySystemBackground))
			.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
			if !isUser { Spacer(minLength: 40) }
		}
	}
}

/// A question the agent asked, as the transcript shows it: the questions
/// posed and, once answered, the picks, so the record reads the same as on the
/// web. Answering happens in the AskCard below the transcript.
struct QuestionCard: View {
	let call: ToolCall

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 6) {
				Image(systemName: "questionmark.circle")
					.foregroundStyle(.tint)
				Text("Claude is asking")
					.font(.subheadline.weight(.medium))
				Spacer()
				if call.answers != nil {
					Chip(text: "answered", color: .green)
				}
			}
			ForEach(Array(call.questions.enumerated()), id: \.offset) { index, question in
				VStack(alignment: .leading, spacing: 4) {
					if let header = question.header, !header.isEmpty {
						Text(header).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
					}
					Text(question.question).font(.subheadline)
					if let answers = call.answers, index < answers.count {
						HStack(spacing: 4) {
							ForEach(answers[index].labels, id: \.self) { label in
								Chip(text: label, color: .green)
							}
						}
					} else {
						ForEach(question.options ?? [], id: \.label) { option in
							Text("· \(option.label)").font(.caption).foregroundStyle(.secondary)
						}
					}
				}
			}
		}
		.padding(10)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
		.overlay(RoundedRectangle(cornerRadius: DeckStyle.Radius.card).stroke(Color.accentColor.opacity(0.3), lineWidth: 0.5))
	}
}

/// A pick from the model sheet; `model` nil is "back to the default".
private struct ModelPick {
	let model: String?
}
