import SwiftUI
import AVFoundation
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
	/// Set while two sessions show side by side: closes this pane.
	var onClose: (() -> Void)? = nil
	/// Whether this pane has the keyboard, with two sessions showing; nil alone.
	var isActivePane: Bool? = nil
	var onActivate: (() -> Void)? = nil
	/// Off while the foldable's list pane shows this session's activity list.
	var embedsActivity = true

	@Environment(DeckStore.self) private var store
	@Environment(HingeMonitor.self) private var hinge
	@Environment(\.openURL) private var openURL
	@Environment(\.dismiss) private var dismiss
	@Environment(\.scenePhase) private var scenePhase
	/// Pushed over the list, so a header line without the tab rail needs its own back button.
	@Environment(\.isPresented) private var isPushed

	/// The view's own model when there is no shared one.
	@State private var ownModel: SessionDetailViewModel?
	/// The shared model from the first pass, so a fold or unfold lays the
	/// transcript out with its conversation rather than a spinner first.
	private var viewModel: SessionDetailViewModel? { shared ?? ownModel }
	@State private var terminal: TerminalPoller?
	/// The phone layout's height, which caps how tall a pending question grows.
	@State private var stackedHeight: CGFloat = 0
	@State private var isSending = false
	@AppStorage("condensedTranscript") private var condensedTranscript = true
	@State private var photoItems: [PhotosPickerItem] = []
	@State private var showPhotoPicker = false
	@State private var showCamera = false
	@State private var cameraDenied = false
	@State private var composerFocused = false
	@State private var pasteFailures = 0
	@State private var leaving = false
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
	@State private var showReviewSheet = false
	@State private var showChanges = false
	@State private var showServers = false
	@State private var showFiles = false
	@State private var showBrowser = false
	@State private var showSchedule = false
	@State private var voice: VoiceController?
	/// The transcript row at the top of the screen while older history loads,
	/// so the prepended rows land above it instead of pushing it out of view.
	@State private var anchorId: String?
	@State private var focused = false
	@State private var highlightedId: String?
	/// How far the PR header has been dragged sideways, towards dismissing it.
	@State private var prDrag: CGFloat = 0
	@State private var visibleRows = Set<String>()
	/// The row to put back and hold at the top once a fold or unfold has laid
	/// the transcript out at its new size.
	@State private var restoreTop: String?
	@State private var placeId = UUID()
	/// Whether this transcript has scrolled other than by its layout settling.
	/// Until then only a scroll leaves the end it opened at: the offset moves
	/// up as rows at the new size take their heights, which is not the reader.
	@State private var scrolled = false
	@State private var confirmCrossSend = false

	/// What this screen reads from deck beyond the baseline routes.
	private static let needs: [DeckCapability] = [.stream, .history, .images, .files]

	private var session: SessionDigest? {
		store.sessions.first { $0.id == sessionId }
	}

	private func markViewed() {
		AskNotification.clearDelivered(session: sessionId)
		Task { try? await store.markRead([sessionId]) }
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

	private var title: String { SessionDetailViewModel.title(of: session, id: sessionId) }

	/// A short window outside the tabletop: one header line instead of the
	/// navigation bar, and a one-row composer.
	private var isShort: Bool { hinge.isShort && !hinge.isTabletop }

	/// About the Send glyph's height at .title. More shares it, so the two
	/// centre on each other in the bottom-aligned short row.
	@ScaledMetric(relativeTo: .title) private var controlHeight: CGFloat = 34


	/// Send, stop and compact for ⌘Return, ⌘. and ⇧⌘K (see DeckCommands).
	private var keyboardActions: DeckSessionActions {
		let canSend = !isSending && !isTerminal && viewModel?.hasDraft == true
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
			.safeAreaInset(edge: .top, spacing: 0) { if isShort { headerLine } }
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar(isShort ? .hidden : .automatic, for: .navigationBar)
			.background { EdgeSwipeBack(active: isShort) }
			// The header line can sit at the window's very top (the outer display
			// has no top inset), where the system's pull-down takes the first tap.
			.defersSystemGestures(on: isShort ? .top : [])
			.toolbar { if !isShort { toolbarContent } }
			.focusedSceneValue(\.deckSession, isActivePane == false ? nil : keyboardActions)
			// Simultaneous, so the tap still reaches whatever it landed on.
			.simultaneousGesture(TapGesture().onEnded { onActivate?() })
			.onChange(of: isActivePane) { _, active in if active == false { composerFocused = false } }
			.alert("Send to a different session?", isPresented: $confirmCrossSend) {
				Button("Cancel", role: .cancel) {}
				Button("Send") { if let viewModel { send(viewModel) } }
			} message: {
				Text("This draft was started in \(viewModel?.draftOriginTitle ?? ""). Send it to \(title)?")
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
				markViewed()
				if viewModel == nil {
					ownModel = SessionDetailViewModel(sessionId: sessionId, store: store)
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
				leaving = false
			}
			// Tearing the view down drops focus; that is not the reader's choice.
			.onChange(of: composerFocused) { _, focused in
				if !leaving { viewModel?.composerFocused = focused }
				if focused { onActivate?() }
			}
			// A turn finishing while you watch it is read already.
			.onChange(of: session?.unread == true) { _, unread in
				if unread, UIApplication.shared.applicationState == .active { markViewed() }
			}
			// One that notified while you were away is read when you come back to it.
			.onChange(of: scenePhase) { _, phase in
				if phase == .active, session?.unread == true { markViewed() }
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
				leaving = true
				if shared == nil { viewModel?.leave() }
				if voice?.enabled != true { OperatorController.shared.resume() }
			}
	}

	@ToolbarContentBuilder
	private var toolbarContent: some ToolbarContent {
		if let onClose {
			ToolbarItem(placement: .topBarLeading) { closeButton(onClose) }
		}
		ToolbarItem(placement: .principal) {
			HStack(spacing: 6) {
				titleButton
				issueChips
			}
		}
		// With two sessions showing, the browser sits in each pane's menu.
		if onClose == nil {
			ToolbarItem(placement: .topBarTrailing) { browserButton }
		}
		ToolbarItem(placement: .topBarTrailing) {
			sessionMenu
		}
	}

	/// The navigation bar's contents on one line for a short window: back or
	/// close, the title, a finished PR's badge, then the browser and the menu.
	/// A foldable shows the tab rail on both displays, and its Sessions tab goes
	/// back, so back is only for a short phone with a bottom tab bar (an SE).
	private var headerLine: some View {
		HStack(spacing: 8) {
			if let onClose {
				closeButton(onClose)
			} else if isPushed, hinge.posture == .unknown {
				Button {
					dismiss()
				} label: {
					Image(systemName: "chevron.backward")
				}
				.accessibilityLabel("Back")
				.accessibilityIdentifier("sessionBack")
			}
			titleButton
			issueChips
			if let pr = finishedPR, let state = PRDisplay.readiness(for: pr) {
				// The title gives way first.
				Text(verbatim: pr.number.map { "#\($0)" } ?? "PR")
					.font(.subheadline)
					.foregroundStyle(.secondary)
					.fixedSize()
				Chip(text: state.label, color: state.color)
					.fixedSize()
					.accessibilityIdentifier("prBadge")
			}
			Spacer(minLength: 0)
			if onClose == nil { browserButton }
			sessionMenu
		}
		// The bar's buttons, without a bar to size their tap areas.
		.buttonStyle(HeaderButtonStyle())
		.padding(.horizontal)
		.padding(.top, 6)
		.background(.bar)
	}

	private func closeButton(_ onClose: @escaping () -> Void) -> some View {
		Button(action: onClose) {
			Image(systemName: "xmark")
		}
		.accessibilityLabel("Close session")
		.accessibilityIdentifier("closePane")
	}

	/// The issue chip beside the title, opening the first issue. The title
	/// gives way first.
	@ViewBuilder private var issueChips: some View {
		if let label = DeckIssue.chipLabel(session?.issues) {
			if let url = session?.issues?.first?.url.flatMap(URL.init(string:)) {
				Link(destination: url) { Chip(text: label) }
					.fixedSize()
			} else {
				Chip(text: label).fixedSize()
			}
		}
	}

	private var titleButton: some View {
		Button {
			onActivate?()
			showRenameSheet = true
		} label: {
			Text(title)
				.font(.headline)
				.lineLimit(1)
				.truncationMode(.tail)
				.foregroundStyle(isActivePane == false ? .secondary : .primary)
				.frame(minHeight: 44)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityHint("Rename")
		.accessibilityIdentifier("renameSession")
		.offTheFold(isPresented: $showRenameSheet) {
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
	}

	private var browserButton: some View {
		Button {
			showBrowser = true
		} label: {
			Image(systemName: "globe")
		}
		.accessibilityLabel("Browser")
		.accessibilityIdentifier("openBrowser")
	}

	private var sessionMenu: some View {
		Menu {
			if onClose != nil {
				Button {
					onActivate?()
					showBrowser = true
				} label: {
					Label("Browser", systemImage: "globe")
				}
				.accessibilityIdentifier("openBrowser")
			}
			Section {
				Picker("Transcript", selection: $condensedTranscript) {
					Label("Chat", systemImage: "bubble.left.and.bubble.right").tag(true)
					Label("Thread", systemImage: "list.bullet.indent").tag(false)
				}
				.pickerStyle(.inline)
			}
			Section {
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
			}
			Section {
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
				if store.supports(.filesBrowser) {
					Button {
						showFiles = true
					} label: {
						Label("Files", systemImage: "folder")
					}
					.accessibilityIdentifier("sessionFiles")
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
			}
			Section {
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
						Label(String("PR #\(pr.number ?? 0)"), systemImage: "arrow.triangle.pull")
					}
				}
				// Swiping the PR header dismisses it too, but a swipe is easy to miss.
				if session?.pr != nil, store.supports(.prDismiss) {
					Button {
						Task { await viewModel?.dismissPR() }
					} label: {
						Label("Dismiss PR", systemImage: "xmark.circle")
					}
					.accessibilityIdentifier("dismissPR")
				}
			}
			Section {
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
				Button(role: .destructive) {
					showDeleteSheet = true
				} label: {
					Label("Delete session", systemImage: "trash")
				}
			}
		} label: {
			Image(systemName: "ellipsis.circle")
		}
		.accessibilityLabel("Session actions")
		.accessibilityIdentifier("sessionMenu")
		.offTheFold(isPresented: $showBrowser) {
			NavigationStack { BrowserView(sessionId: sessionId, isModal: true) }
		}
		.offTheFold(isPresented: $showModelSheet, onDismiss: applyModelPick) {
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
		.offTheFold(isPresented: $showEffortSheet) {
			EffortPickerSheet(current: session?.effort) { effort in
				Task { await viewModel?.changeEffort(effort) }
			}
		}
		.offTheFold(isPresented: $showChanges) {
			ChangesSheet(sessionId: sessionId, title: title)
		}
		.offTheFold(isPresented: $showServers) {
			ServersSheet(sessionId: sessionId, title: title)
		}
		.offTheFold(isPresented: $showFiles) {
			if let viewModel { FilesSheet(sessionId: sessionId, viewModel: viewModel) }
		}
		.offTheFold(isPresented: $showSchedule) {
			NavigationStack { SchedulesView(startFor: sessionId) }
		}
		.offTheFold(isPresented: $showDeleteSheet) {
			DeleteSessionSheet(hasWorktree: session?.worktree != nil) { deleteWorktree, deleteBranch in
				Task {
					if await viewModel?.delete(deleteWorktree: deleteWorktree, deleteBranch: deleteBranch) == true {
						dismiss()
					}
				}
			}
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
			if showsPRRow { prHeader(viewModel) }
			transcript(viewModel)
			if session?.status == .running {
				workingIndicator
			}
			askCard(viewModel, available: stackedHeight)
			if let voice, voice.enabled {
				Divider()
				VoiceBar(voice: voice)
			}
			composer(viewModel)
		}
		.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { stackedHeight = $0 }
	}

	/// Half open on a table: the transcript stands on the upper half, voice
	/// mode lies on the lower half where the hands are, with the PR actions,
	/// the question card, Stop and the composer under it: a tap on the
	/// standing half wobbles it.
	private func tabletop(_ viewModel: SessionDetailViewModel) -> some View {
		GeometryReader { geometry in
			VStack(spacing: 0) {
				VStack(spacing: 0) {
					prHeader(viewModel, statusOnly: true)
					transcript(viewModel)
				}
				.frame(height: upperHeight(in: geometry))
				Divider()
				VStack(spacing: 0) {
					// The keyboard takes the flat half while typing, so the voice
					// controls step aside for it.
					// The invitation steps aside for a question or PR actions; the
					// composer's voice button still turns voice mode on.
					if !composerFocused, let voice, voice.enabled || (viewModel.pendingAsk == nil && !hasOpenPR) {
						Group {
							if voice.enabled {
								VoiceDeck(voice: voice)
							} else {
								voiceInvitation
							}
						}
						.frame(maxHeight: viewModel.pendingAsk == nil ? .infinity : nil)
					}
					if hasOpenPR, let pr = session?.pr {
						HStack(spacing: 8) {
							prActions(viewModel, pr: pr)
						}
						.buttonStyle(.bordered)
						.font(.caption)
						.padding(.horizontal)
						.padding(.vertical, 8)
					}
					if viewModel.pendingAsk != nil {
						askCard(viewModel, available: geometry.size.height - upperHeight(in: geometry))
						Spacer(minLength: 0)
					} else if composerFocused || voice == nil {
						Spacer(minLength: 0)
					}
					if session?.status == .running {
						workingIndicator
					}
					composer(viewModel)
				}
				.frame(maxHeight: .infinity)
			}
		}
	}

	private var hasOpenPR: Bool { session?.pr?.state?.lowercased() == "open" }

	/// A merged or closed PR, which a short window shows in the header line.
	private var finishedPR: SessionPR? {
		session?.pr.flatMap { ["merged", "closed"].contains($0.state?.lowercased()) ? $0 : nil }
	}

	/// On a short window the open PR's row steps aside while typing, and a
	/// finished one is only a badge in the header line.
	private var showsPRRow: Bool { !isShort || (finishedPR == nil && !composerFocused) }

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
				Text(voice.settings.handsFree && voice.supportsHandsFree
					? "Replies are read aloud, and you can talk back hands-free."
					: "Replies are read aloud. Hold the button to talk back.")
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

	/// The PR above the transcript on one line; a tap opens its actions.
	/// Swiping it sideways dismisses it. On a table the actions lie on the
	/// flat half instead, so the standing half only shows the summary.
	@ViewBuilder
	private func prHeader(_ viewModel: SessionDetailViewModel, statusOnly: Bool = false) -> some View {
		if let pr = session?.pr {
			let canDismiss = store.supports(.prDismiss)
			Group {
				if statusOnly {
					PRSummary(pr: pr)
				} else {
					PRHeaderRow(
						pr: pr,
						canMerge: store.canMerge(pr),
						onReview: { showReviewSheet = true },
						onMerge: { showMergeSheet = true },
						onDismiss: dismissPR(viewModel))
				}
			}
			.padding(.horizontal)
			.padding(.vertical, 8)
			.background(.thinMaterial)
			.offset(x: prDrag)
			// High priority with a minimum distance: a tap still reaches the
			// row, a drag cancels it so a swipe never merges.
			.highPriorityGesture(
				DragGesture(minimumDistance: 20)
					.onChanged { value in
						// A drag that turns vertical lets go rather than dismissing.
						prDrag = abs(value.translation.width) > abs(value.translation.height) ? value.translation.width : 0
					}
					.onEnded { value in
						// A flick counts as well as a long drag.
						guard abs(prDrag) > 100 || (prDrag != 0 && abs(value.predictedEndTranslation.width) > 200) else {
							withAnimation { prDrag = 0 }
							return
						}
						withAnimation { prDrag = prDrag > 0 ? 1000 : -1000 }
						Task {
							await viewModel.dismissPR()
							withAnimation { prDrag = 0 }
						}
					},
				// Without dismiss support the drag stays off so it cannot cancel taps.
				including: canDismiss ? .all : .subviews)
			.accessibilityElement(children: .contain)
			.accessibilityActions {
				if canDismiss {
					Button("Dismiss PR") { Task { await viewModel.dismissPR() } }
				}
			}
			.offTheFold(isPresented: $showMergeSheet) {
				MergeSheet(pr: session?.pr) { method, deleteBranch in
					Task { await viewModel.merge(method: method, deleteBranch: deleteBranch) }
				}
			}
			.offTheFold(isPresented: $showReviewSheet) {
				ReviewSheet(allowsVerdict: session?.isReviewSession == true) { decision, body in
					Task { await viewModel.review(decision: decision, body: body) }
				}
			}
		}
	}

	private func prActions(_ viewModel: SessionDetailViewModel, pr: SessionPR) -> some View {
		PRActions(
			pr: pr,
			canMerge: store.canMerge(pr),
			onReview: { showReviewSheet = true },
			onMerge: { showMergeSheet = true },
			onDismiss: dismissPR(viewModel))
	}

	private func dismissPR(_ viewModel: SessionDetailViewModel) -> (() -> Void)? {
		guard store.supports(.prDismiss) else { return nil }
		return { Task { await viewModel.dismissPR() } }
	}

	@ViewBuilder
	private func askCard(_ viewModel: SessionDetailViewModel, available: CGFloat) -> some View {
		if let ask = viewModel.pendingAsk {
			AskCard(
				ask: ask,
				draft: Binding(
					get: { viewModel.askDrafts[askKey(ask)] ?? AskAnswerDraft(questions: ask.questions) },
					set: { viewModel.askDrafts[askKey(ask)] = $0 }),
				maxQuestionsHeight: available > 0 ? available / 2 : nil
			) { draft in
				Task { await viewModel.answer(ask: ask, draft: draft) }
			}
			.id(ask.id)
			.padding()
			.deckGlass()
			.padding(.horizontal, 8)
			.padding(.vertical, 4)
		}
	}

	/// An ask id can come back as a new question, which gets fresh picks.
	private func askKey(_ ask: DeckAsk) -> String { "\(ask.id)-\(ask.askedAt ?? 0)" }

	private var workingIndicator: some View {
		HStack {
			if viewModel?.stopping == true {
				Text("Stopping…").foregroundStyle(.secondary)
			} else {
				WorkingLabel()
			}
			Spacer()
			if viewModel?.canForceStop == true {
				Button("Force stop", role: .destructive) {
					Task { await viewModel?.stop(force: true) }
				}
				.controlSize(.small)
			}
			// ⌘. is the same stop (DeckCommands).
			Button("Stop", systemImage: "stop.circle", role: .destructive) {
				Task { await viewModel?.stop() }
			}
			.controlSize(.small)
			.disabled(viewModel?.stopping == true)
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
					let groups = TranscriptGroup.make(viewModel.items, condensed: condensedTranscript)
					ForEach(groups) { group in
						Group {
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
						.onScrollVisibilityChange(threshold: 0.1) { visible in
							noteVisibility(group.id, visible, in: groups, viewModel)
						}
						// A row the lazy stack drops never reports going out of view.
						.onDisappear { visibleRows.remove(group.id) }
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
					if embedsActivity, !(isShort && composerFocused) {
						ActivityList(
							entries: viewModel.activity, turnRunning: viewModel.turnRunning, onCancel: viewModel.cancelWatch,
							onRunNow: viewModel.runWatchNow, onOpen: viewModel.open
						)
					}
					// A fixed-size end marker to scroll to: aiming at the last row
					// itself lands short while the lazy stack is still estimating
					// heights it has not laid out.
					Color.clear.frame(height: 1).id("bottom")
				}
				.padding()
			}
			.accessibilityIdentifier("transcript")
			// Opens at the end; a reader elsewhere before a fold or unfold is put
			// back below.
			.defaultScrollAnchor(.bottom, for: .initialOffset)
			.scrollDismissesKeyboard(.interactively)
			// Simultaneous, so rows, links and disclosures still take the tap.
			.simultaneousGesture(TapGesture().onEnded { composerFocused = false })
			.onAppear {
				viewModel.placeKeeper = placeId
				guard !viewModel.isNearBottom, let top = viewModel.topRowId else { return }
				restoreTop = top
				proxy.scrollTo(top, anchor: .top)
			}
			.task(id: restoreTop) {
				guard restoreTop != nil else { return }
				try? await Task.sleep(for: .seconds(1))
				if !Task.isCancelled { restoreTop = nil }
			}
			// Back where the reader was, once the new layout has a size, then held
			// there while the rows above take their real heights at the new
			// width, which would otherwise push it up off the screen. A second,
			// a touch or a scroll of the app's own ends the hold.
			.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
				guard height > 0, let top = restoreTop else { return }
				proxy.scrollTo(top, anchor: .top)
			}
			.onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
				if let top = restoreTop { proxy.scrollTo(top, anchor: .top) }
			}
			.onScrollPhaseChange { _, phase in
				if phase == .interacting { restoreTop = nil }
				if phase != .idle { scrolled = true }
			}
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
			.followsTranscriptEnd(isNearBottom: Binding(
				get: { viewModel.isNearBottom },
				set: { if viewModel.placeKeeper == placeId, scrolled || $0 { viewModel.isNearBottom = $0 } }
			), proxy: proxy, paused: anchorId != nil || restoreTop != nil)
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
			.onChange(of: viewModel.jumpTo) { _, id in
				guard let id else { return }
				viewModel.jumpTo = nil
				restoreTop = nil
				let groups = TranscriptGroup.make(viewModel.items, condensed: condensedTranscript)
				guard let group = groups.first(where: { $0.items.contains { $0.id == id } }) else { return }
				viewModel.isNearBottom = false
				withAnimation { proxy.scrollTo(group.id, anchor: .top) }
				highlightedId = group.id
				Task {
					try? await Task.sleep(for: .seconds(2.5))
					if highlightedId == group.id { highlightedId = nil }
				}
			}
			.onChange(of: viewModel.items.count) { _, _ in
				// Older rows arriving above the reader hold their place.
				if let anchorId {
					proxy.scrollTo(anchorId, anchor: .top)
					self.anchorId = nil
				}
			}
			.overlay(alignment: .bottom) {
				if !viewModel.isNearBottom {
					Button {
						restoreTop = nil
						viewModel.isNearBottom = true
						withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
					} label: {
						Image(systemName: "arrow.down")
							.font(.body.weight(.semibold))
							.frame(width: 36, height: 36)
					}
					.buttonStyle(.plain)
					.deckGlass(in: Circle())
					.padding(.bottom, 8)
					.accessibilityLabel("Jump to latest")
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

	/// Keeps the top row on screen in the model, for putting the reader back
	/// after a fold or unfold. Per row rather than scrollTargetLayout, which
	/// anchors the scroll view to a row and so stops it opening at the end.
	private func noteVisibility(_ id: String, _ visible: Bool, in groups: [TranscriptGroup], _ viewModel: SessionDetailViewModel) {
		if visible { visibleRows.insert(id) } else { visibleRows.remove(id) }
		// The rows of a layout coming or going are not the reader's place.
		guard restoreTop == nil, !leaving, viewModel.placeKeeper == placeId else { return }
		if let top = groups.first(where: { visibleRows.contains($0.id) }) { viewModel.topRowId = top.id }
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
		restoreTop = nil
		anchorId = TranscriptGroup.make(viewModel.items, condensed: condensedTranscript).first?.id
		let before = viewModel.items.count
		Task {
			let added = await viewModel.loadOlder()
			// Nothing new on screen means no items-count change to consume the
			// anchor, so release it here or no later load could start.
			if !added || viewModel.items.count == before { anchorId = nil }
		}
	}

	/// One rounded piece: the attachments and the message on top, the controls
	/// in a row underneath, send at the end. Return adds a line, so sending
	/// is the button (or ⌘Return). A short window puts the controls in a
	/// column at the right edge instead, cut to Send and More while typing,
	/// so a one-line message is one line tall.
	private func composer(_ viewModel: SessionDetailViewModel) -> some View {
		Group {
			if isShort {
				HStack(alignment: .bottom, spacing: 12) {
					composerMessage(viewModel)
					if composerFocused {
						composerMore(viewModel)
							.font(.title3)
						sendButton(viewModel)
					} else {
						VStack(spacing: 12) {
							composerTools(viewModel)
							sendButton(viewModel)
						}
						.font(.title3)
					}
				}
			} else {
				VStack(alignment: .leading, spacing: 10) {
					composerMessage(viewModel)
					HStack(spacing: 18) {
						composerTools(viewModel)
						Spacer(minLength: 0)
						sendButton(viewModel)
					}
					.font(.title3)
				}
			}
		}
		.padding(12)
		// The field is only as tall as its text; the rest of the box takes you to it. Buttons keep their own taps.
		.contentShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
		.onTapGesture { composerFocused = true }
		.deckGlass(in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
		.padding(.horizontal, 8)
		.padding(.vertical, 6)
		.disabled(isSending)
		.onDrop(of: [.image, .plainText, .url, .fileURL], isTargeted: nil) { providers in
			Task { await drop(providers, into: viewModel) }
			return true
		}
		.onChange(of: photoItems) { _, items in
			Task { await loadPhotos(items, to: viewModel) }
		}
		.photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 8, matching: .images)
		// Full screen everywhere, the foldable too: the camera wants the whole display.
		.fullScreenCover(isPresented: $showCamera) {
			CameraPicker { photo in
				showCamera = false
				if let photo { Task { await attachPhoto(photo, to: viewModel) } }
			}
			.ignoresSafeArea()
		}
		.alert("Camera access is off", isPresented: $cameraDenied) {
			Button("Open Settings") {
				if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
			}
			Button("Cancel", role: .cancel) {}
		} message: {
			Text("Allow deck to use the camera in Settings to take photos for a message.")
		}
		.offTheFold(isPresented: $showQuickManage) {
			QuickMessagesSheet()
		}
	}

	/// The cross-session label and the attachments above the message field.
	private func composerMessage(_ viewModel: SessionDetailViewModel) -> some View {
		VStack(alignment: .leading, spacing: 10) {
			if ComposerDraft.isCrossSession(viewModel.draftOrigin, current: sessionId) {
				Label("from: \(viewModel.draftOriginTitle)", systemImage: "arrow.left.arrow.right")
					.font(.caption)
					.foregroundStyle(.secondary)
					.lineLimit(1)
			}
			if !viewModel.draftImages.isEmpty {
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 8) {
						ForEach(viewModel.draftImages) { image in
							attachmentThumbnail(image, viewModel: viewModel)
						}
					}
					.padding(.top, 4)
				}
				.frame(height: 56)
			}
			if pasteFailures > 0 {
				Text("Couldn't paste that image")
					.font(.caption)
					.foregroundStyle(.secondary)
					.task(id: pasteFailures) {
						guard (try? await Task.sleep(for: .seconds(4))) != nil else { return }
						pasteFailures = 0
					}
			}
			ComposerTextField(text: Bindable(viewModel).draft, isFocused: $composerFocused) { providers in
				Task { await attach(providers, to: viewModel) }
			}
			.overlay(alignment: .topLeading) {
				if viewModel.draft.isEmpty {
					Text("Message")
						.foregroundStyle(.tertiary)
						.allowsHitTesting(false)
						.accessibilityHidden(true)
				}
			}
			// Beside the controls, one line as tall as Send centres on it, and the last line stays on it as the text grows.
			.padding(.vertical, isShort ? max(0, (controlHeight - UIFont.preferredFont(forTextStyle: .body).lineHeight) / 2) : 0)
			// Here, not in the view's onAppear: the field only exists once the
			// body has left its loading state, and focus set earlier is lost.
			.onAppear { if viewModel.composerFocused { composerFocused = true } }
		}
	}

	/// Photos, quick messages and voice mode.
	@ViewBuilder
	private func composerTools(_ viewModel: SessionDetailViewModel) -> some View {
		if CameraPicker.isAvailable {
			Menu {
				Button("Photo Library", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
				Button("Take Photo", systemImage: "camera") { takePhoto() }
			} label: {
				Image(systemName: "photo.on.rectangle")
			}
			.accessibilityLabel("Attach photos")
		} else {
			PhotosPicker(selection: $photoItems, maxSelectionCount: 8, matching: .images) {
				Image(systemName: "photo.on.rectangle")
			}
			.accessibilityLabel("Attach photos")
		}
		if store.supports(.quickMessages) {
			Menu {
				quickMessages(viewModel)
			} label: {
				Image(systemName: "text.append")
			}
			.accessibilityLabel("Quick messages")
		}
		if let voice, voice.canRead {
			Button {
				if voice.enabled { voice.disable() } else { voice.enable() }
			} label: {
				Image(systemName: voice.enabled ? "waveform.circle.fill" : "waveform.circle")
			}
			.accessibilityLabel(voice.enabled ? "Turn voice mode off" : "Turn voice mode on")
		}
	}

	/// The same tools in a menu, for a short window while typing.
	private func composerMore(_ viewModel: SessionDetailViewModel) -> some View {
		Menu {
			Button("Attach photos", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
			if CameraPicker.isAvailable {
				Button("Take Photo", systemImage: "camera") { takePhoto() }
			}
			if store.supports(.quickMessages) {
				Menu("Quick messages", systemImage: "text.append") { quickMessages(viewModel) }
			}
			if let voice, voice.canRead {
				Button(
					voice.enabled ? "Turn voice mode off" : "Turn voice mode on",
					systemImage: voice.enabled ? "waveform.circle.fill" : "waveform.circle"
				) {
					if voice.enabled { voice.disable() } else { voice.enable() }
				}
			}
		} label: {
			Image(systemName: "plus.circle")
				.frame(height: controlHeight)
		}
		.accessibilityLabel("More")
		.accessibilityIdentifier("composerMore")
	}

	@ViewBuilder
	private func quickMessages(_ viewModel: SessionDetailViewModel) -> some View {
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
	}

	private func sendButton(_ viewModel: SessionDetailViewModel) -> some View {
		Button {
			sendComposer(viewModel)
		} label: {
			Image(systemName: "arrow.up.circle.fill")
				.font(.title)
				.frame(height: controlHeight)
		}
		.disabled(!viewModel.hasDraft)
		.accessibilityLabel("Send")
	}

	private func attachmentThumbnail(_ image: DeckImage, viewModel: SessionDetailViewModel) -> some View {
		ZStack(alignment: .topTrailing) {
			if let data = Data(base64Encoded: image.data), let uiImage = UIImage(data: data) {
				Image(uiImage: uiImage)
					.resizable()
					.scaledToFill()
					.frame(width: 48, height: 48)
					.clipShape(RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
			}
			Button {
				viewModel.draftImages.removeAll { $0.id == image.id }
			} label: {
				Image(systemName: "xmark.circle.fill")
					.foregroundStyle(.white, .black.opacity(0.6))
			}
			.accessibilityLabel("Remove image")
			.offset(x: 4, y: -4)
		}
	}

	/// A draft that followed the reader from another session asks first.
	private func sendComposer(_ viewModel: SessionDetailViewModel) {
		if ComposerDraft.isCrossSession(viewModel.draftOrigin, current: sessionId) {
			confirmCrossSend = true
		} else {
			send(viewModel)
		}
	}

	private func send(_ viewModel: SessionDetailViewModel) {
		let text = viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines)
		let images = viewModel.draftImages
		guard !text.isEmpty || !images.isEmpty else { return }
		guard !isSending else { return }
		isSending = true
		Task {
			if await viewModel.sendComposer(text: text, images: images) {
				viewModel.draft = ""
				viewModel.draftImages = []
				composerFocused = true
			}
			isSending = false
		}
	}

	private func loadPhotos(_ items: [PhotosPickerItem], to viewModel: SessionDetailViewModel) async {
		for item in items {
			guard viewModel.draftImages.count < 8 else { break }
			if let data = try? await item.loadTransferable(type: Data.self), let image = ImagePaste.image(from: data) {
				viewModel.draftImages.append(image)
			}
		}
		photoItems = []
	}

	private func takePhoto() {
		switch AVCaptureDevice.authorizationStatus(for: .video) {
		case .authorized:
			showCamera = true
		case .notDetermined:
			Task {
				if await AVCaptureDevice.requestAccess(for: .video) { showCamera = true } else { cameraDenied = true }
			}
		default:
			cameraDenied = true
		}
	}

	/// Through JPEG so ImagePaste scales it down like any other photo; the
	/// JPEG keeps the photo's orientation, which ImagePaste then applies. Full
	/// quality, so the 0.8 encode in ImagePaste is the only lossy step.
	private func attachPhoto(_ photo: UIImage, to viewModel: SessionDetailViewModel) async {
		let image = await Task.detached { photo.jpegData(compressionQuality: 1).flatMap(ImagePaste.image(from:)) }.value
		if let image, viewModel.draftImages.count < 8 { viewModel.draftImages.append(image) }
	}

	/// Attach images pasted into the field or dropped, up to the composer's limit.
	private func attach(_ providers: [NSItemProvider], to viewModel: SessionDetailViewModel) async {
		for provider in providers.filter(ImagePaste.hasImage) where viewModel.draftImages.count < 8 {
			if let image = await ImagePaste.image(from: provider) {
				// Checked again: another paste may have filled the draft while this one loaded.
				if viewModel.draftImages.count < 8 { viewModel.draftImages.append(image) }
			} else {
				pasteFailures += 1
			}
		}
	}

	/// A drop from the other pane or another app: images attach, text and
	/// links go into the message on a line of their own, a file by its name.
	private func drop(_ providers: [NSItemProvider], into viewModel: SessionDetailViewModel) async {
		for provider in providers {
			if ImagePaste.hasImage(provider) {
				await attach([provider], to: viewModel)
			} else if let text = await Self.text(from: provider), !text.isEmpty {
				viewModel.draft += (viewModel.draft.isEmpty ? "" : "\n") + text
			}
		}
	}

	private static func text(from provider: NSItemProvider) async -> String? {
		if provider.canLoadObject(ofClass: String.self) {
			return await withCheckedContinuation { continuation in
				_ = provider.loadObject(ofClass: String.self) { text, _ in continuation.resume(returning: text) }
			}
		}
		guard provider.canLoadObject(ofClass: URL.self) else { return nil }
		let url: URL? = await withCheckedContinuation { continuation in
			_ = provider.loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
		}
		return url.map { $0.isFileURL ? $0.lastPathComponent : $0.absoluteString }
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
				let steps = viewModel?.steps[call.id] ?? []
				let agent = viewModel?.agents.agent(forCall: call.id)
				if !steps.isEmpty || agent != nil {
					SubagentSteps(steps: steps, agent: agent) { TranscriptRow(item: $0, viewModel: viewModel, voice: voice) }
				}
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
					Group {
						if isUser {
							Text(text)
						} else {
							MarkdownText(text)
						}
					}
					// Into the other pane's composer, or another app.
					.draggable(text)
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

/// A header-line icon with the 44 pt tap area the guidelines ask for.
private struct HeaderButtonStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.frame(minWidth: 44, minHeight: 44)
			.contentShape(Rectangle())
			.opacity(configuration.isPressed ? 0.5 : 1)
			.foregroundStyle(.tint)
	}
}

/// A pick from the model sheet; `model` nil is "back to the default".
private struct ModelPick {
	let model: String?
}

/// A sheet, except with the window split on the fold, where a sheet would
/// straddle it: there it is a popover from the control that opened it, inside
/// the session's pane.
private struct OffTheFold<Sheet: View>: ViewModifier {
	@Environment(HingeMonitor.self) private var hinge
	@Environment(\.horizontalSizeClass) private var sizeClass
	@Environment(\.foldPane) private var foldPane
	/// The control's frame in the window.
	@State private var frame = CGRect.zero
	@Binding var isPresented: Bool
	var onDismiss: (() -> Void)?
	@ViewBuilder var sheet: () -> Sheet

	func body(content: Content) -> some View {
		let pane = hinge.splitWidth(sizeClass).map { half in foldPane.map { $0.upperBound - $0.lowerBound } ?? half }
		let width = min((pane ?? 0) - 32, 480)
		content
			.onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
			.sheet(isPresented: shown(pane == nil), onDismiss: onDismiss, content: sheet)
			.popover(isPresented: shown(pane != nil), attachmentAnchor: anchor(width: width)) {
				sheet()
					.frame(width: width, height: hinge.windowSize.height * 0.7)
			}
			.onChange(of: isPresented) { _, presented in
				if !presented, pane != nil { onDismiss?() }
			}
	}

	/// A popover centres on its anchor, so one from a control near the pane's
	/// edge would cross the divider: the anchor moves along the control just
	/// far enough that the popover's middle keeps it inside the pane.
	private func anchor(width: CGFloat) -> PopoverAttachmentAnchor {
		guard let pane = foldPane, frame.width > 0 else { return .rect(.bounds) }
		let middle = min(max(frame.midX, pane.lowerBound + width / 2 + 16), pane.upperBound - width / 2 - 16)
		return .point(UnitPoint(x: (middle - frame.minX) / frame.width, y: 1))
	}

	private func shown(_ here: Bool) -> Binding<Bool> {
		Binding(get: { here && isPresented }, set: { isPresented = $0 })
	}
}

extension EnvironmentValues {
	/// Where across the window the fold's pane a session shows in runs, set by
	/// SessionsView; elsewhere a split window's popovers take half of it.
	@Entry var foldPane: ClosedRange<CGFloat>?
}

private extension View {
	func offTheFold<Sheet: View>(
		isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil, @ViewBuilder sheet: @escaping () -> Sheet
	) -> some View {
		modifier(OffTheFold(isPresented: isPresented, onDismiss: onDismiss, sheet: sheet))
	}
}

/// Hiding the navigation bar for the short header line also turns off the
/// edge swipe back. This lends the stack's pop gesture a delegate while the
/// session shows and hands the old one back when it goes. Mounted whatever
/// the window, so a fold never adds or removes it mid-screen; tall, it leaves
/// every answer to the old delegate.
private struct EdgeSwipeBack: UIViewControllerRepresentable {
	var active: Bool

	func makeUIViewController(context: Context) -> Controller { Controller() }
	func updateUIViewController(_ controller: Controller, context: Context) { controller.active = active }
	static func dismantleUIViewController(_ controller: Controller, coordinator: ()) { controller.giveBack() }

	final class Controller: UIViewController, UIGestureRecognizerDelegate {
		var active = false
		private weak var stack: UINavigationController?
		private weak var original: UIGestureRecognizerDelegate?

		override func viewDidAppear(_ animated: Bool) {
			super.viewDidAppear(animated)
			guard let stack = navigationController, let pop = stack.interactivePopGestureRecognizer,
				pop.delegate !== self else { return }
			self.stack = stack
			original = pop.delegate
			pop.delegate = self
		}

		override func viewWillDisappear(_ animated: Bool) {
			super.viewWillDisappear(animated)
			giveBack()
		}

		func giveBack() {
			if let pop = stack?.interactivePopGestureRecognizer, pop.delegate === self { pop.delegate = original }
		}

		// Not mid-push: a pop starting then wedges the stack.
		func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
			guard let stack else { return false }
			guard active else { return original?.gestureRecognizerShouldBegin?(gestureRecognizer) ?? (stack.viewControllers.count > 1) }
			return stack.viewControllers.count > 1 && stack.transitionCoordinator == nil
		}

		// Not asked while active: with the bar hidden its answers turn the swipe off.
		func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
			active || original?.gestureRecognizer?(gestureRecognizer, shouldReceive: touch) ?? true
		}
	}
}
