import SwiftUI
import DeckKit
import DeckUI

/// One session: its transcript (or terminal, for a shell), the question it is
/// waiting on, and a composer.
struct MacSessionDetail: View {
	let sessionId: String
	@Environment(DeckStore.self) private var store
	@State private var viewModel: SessionDetailViewModel?
	@State private var terminal: TerminalPoller?
	@State private var voice: VoiceController?
	@State private var draft = ""
	@State private var sending = false

	private var session: SessionDigest? { store.sessions.first { $0.id == sessionId } }
	private var isTerminal: Bool { session?.kind == "shell" && store.supports(.terminal) }

	var body: some View {
		VStack(spacing: 0) {
			if isTerminal, let terminal {
				TerminalView(poller: terminal)
			} else if let viewModel {
				transcript(viewModel)
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
		.navigationTitle(session?.title ?? "Session")
		.navigationSubtitle(session?.cwd ?? "")
		.toolbar {
			if !isTerminal, session?.status == .running, let viewModel {
				ToolbarItem {
					Button {
						Task { await viewModel.stop() }
					} label: {
						Label("Stop", systemImage: "stop.circle")
					}
					.keyboardShortcut(".", modifiers: .command)
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

	private func begin() {
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
								ForEach(group.items) { MacTranscriptRow(item: $0) }
							}
						} else if let item = group.items.first {
							MacTranscriptRow(item: item)
						}
					}
					if !viewModel.streamingText.isEmpty {
						MacBubble(text: viewModel.streamingText, isUser: false)
					}
					Color.clear.frame(height: 1).id("bottom")
				}
				.padding()
				.frame(maxWidth: 860)
				.frame(maxWidth: .infinity)
			}
			.onChange(of: viewModel.items.count) { _, _ in
				if viewModel.isNearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
			}
			.onChange(of: viewModel.streamingText) { _, _ in
				if viewModel.isNearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
			}
			.onScrollGeometryChange(for: Bool.self) { geometry in
				geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 80
			} action: { _, nearBottom in
				viewModel.isNearBottom = nearBottom
			}
		}
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
		HStack(alignment: .bottom, spacing: 8) {
			TextField("Message", text: $draft, axis: .vertical)
				.textFieldStyle(.plain)
				.lineLimit(1...8)
				.padding(8)
				.background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
				.overlay(
					RoundedRectangle(cornerRadius: DeckStyle.Radius.control)
						.stroke(Color(nsColor: .separatorColor), lineWidth: 0.5))
				.onSubmit { send(viewModel) }
			Button("Send") { send(viewModel) }
				.keyboardShortcut(.return, modifiers: .command)
				.disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
		}
		.padding()
	}

	private func send(_ viewModel: SessionDetailViewModel) {
		let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty, !sending else { return }
		sending = true
		Task {
			if await viewModel.sendComposer(text: text, images: []) { draft = "" }
			sending = false
		}
	}
}

private struct MacTranscriptRow: View {
	let item: TranscriptItem

	var body: some View {
		switch item {
		case .user(_, let text, let images):
			MacBubble(text: text.isEmpty && !images.isEmpty ? "(\(images.count) image\(images.count == 1 ? "" : "s"))" : text, isUser: true)
		case .assistant(_, let text):
			MacBubble(text: text, isUser: false)
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
		case .notice(_, let text, let level):
			Text(text)
				.font(.caption)
				.foregroundStyle(level == .error ? .red : level == .warning ? .orange : .secondary)
				.frame(maxWidth: .infinity, alignment: level == .info ? .center : .leading)
		}
	}
}

private struct MacBubble: View {
	let text: String
	let isUser: Bool

	var body: some View {
		HStack {
			if isUser { Spacer(minLength: 60) }
			Group {
				if isUser { Text(text) } else { MarkdownText(text) }
			}
			.textSelection(.enabled)
			.padding(10)
			.background(
				isUser ? Color.accentColor.opacity(0.15) : Color(nsColor: .controlBackgroundColor),
				in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
			if !isUser { Spacer(minLength: 60) }
		}
	}
}
