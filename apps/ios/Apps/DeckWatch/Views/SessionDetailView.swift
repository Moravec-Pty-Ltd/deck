import SwiftUI
import WatchKit
import DeckKit

struct SessionDetailView: View {
	@Environment(DeckStore.self) private var store
	@Environment(WatchRouter.self) private var router
	let session: SessionDigest

	@State private var detail: SessionDetail?
	@State private var isLoadingDetail = false
	@State private var replyText = ""
	@State private var isSending = false
	@State private var isStopping = false
	@State private var confirmStop = false
	@State private var errorMessage: String?

	/// The digest keeps updating live from the event log; look up the latest
	/// copy rather than trusting the one captured at push time.
	private var live: SessionDigest {
		store.sessions.first { $0.id == session.id } ?? session
	}

	private var pendingAsk: DeckAsk? {
		store.asks.first { $0.sessionId == session.id }
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 12) {
				statusLine

				if isLoadingDetail && detail == nil {
					ProgressView()
				} else if let text = detail?.lastResult, !text.isEmpty {
					MarkdownText(text).font(.footnote)
				} else {
					Text("No output yet").font(.footnote).foregroundStyle(.secondary)
				}

				if let ask = pendingAsk {
					Button {
						router.path.append(ask)
					} label: {
						Label("Needs your input", systemImage: "exclamationmark.bubble.fill")
					}
					.buttonStyle(.bordered)
					.tint(.orange)
				}

				if live.kind != "shell", store.supports(.speech), store.supports(.stream) {
					Button {
						router.path.append(VoiceRoute(session: live))
					} label: {
						Label("Voice", systemImage: "waveform")
					}
					.buttonStyle(.bordered)
				}

				Divider()

				VStack(alignment: .leading, spacing: 4) {
					Text("Reply").font(.caption).foregroundStyle(.secondary)
					TextField("Message", text: $replyText)
					Button("Send") { send() }
						.disabled(replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
				}

				let offered = store.quickMessages(for: live)
				if !offered.isEmpty {
					VStack(alignment: .leading, spacing: 4) {
						Text("Quick messages").font(.caption).foregroundStyle(.secondary)
						ForEach(offered) { message in
							Button(message.displayLabel) { sendQuick(message.text) }
								.buttonStyle(.bordered)
								.disabled(isSending)
						}
					}
				}

				if live.status == .running {
					Button(role: .destructive) {
						confirmStop = true
					} label: {
						Text("Stop")
					}
					.disabled(isStopping)
				}
			}
			.padding(.horizontal)
			.padding(.bottom)
		}
		.navigationTitle(live.title ?? "Session")
		.task { await loadDetail() }
		.confirmationDialog("Stop this session?", isPresented: $confirmStop, titleVisibility: .visible) {
			Button("Stop", role: .destructive) { stop() }
			Button("Cancel", role: .cancel) {}
		}
		.alert("Something went wrong", isPresented: Binding(
			get: { errorMessage != nil },
			set: { if !$0 { errorMessage = nil } }
		)) {
			Button("OK", role: .cancel) { errorMessage = nil }
		} message: {
			Text(errorMessage ?? "")
		}
	}

	private var statusLine: some View {
		HStack(spacing: 6) {
			Circle().fill(dotColor).frame(width: 8, height: 8)
			Text(live.status.rawValue.capitalized)
			if live.awaitingInput == true {
				Text("· awaiting input")
					.foregroundStyle(.orange)
			}
		}
		.font(.caption)
		.foregroundStyle(.secondary)
	}

	private var dotColor: Color {
		if live.awaitingInput == true { return .orange }
		switch live.status {
		case .running: return .green
		case .idle: return .gray
		case .error, .dead: return .red
		case .unknown: return .gray
		}
	}

	private func loadDetail() async {
		guard let client = store.client else { return }
		isLoadingDetail = true
		detail = try? await client.session(id: session.id)
		isLoadingDetail = false
	}

	private func send() {
		let text = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty else { return }
		isSending = true
		Task {
			do {
				try await store.send(sessionId: session.id, text: text)
				replyText = ""
				WKInterfaceDevice.current().play(.success)
			} catch {
				errorMessage = error.localizedDescription
			}
			isSending = false
		}
	}

	private func sendQuick(_ text: String) {
		isSending = true
		Task {
			do {
				try await store.sendQuickMessage(sessionId: session.id, text: text)
				WKInterfaceDevice.current().play(.success)
			} catch {
				errorMessage = error.localizedDescription
			}
			isSending = false
		}
	}

	private func stop() {
		isStopping = true
		Task {
			do {
				try await store.stop(sessionId: session.id)
			} catch {
				errorMessage = error.localizedDescription
			}
			isStopping = false
		}
	}
}
