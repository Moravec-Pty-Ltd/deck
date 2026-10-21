import SwiftUI
import DeckKit

/// Pick a session and send. Deliberately one screen: a share sheet is a
/// two-second decision, so there is nothing to configure and nothing to read
/// except which session, with the most recently active first.
struct ShareView: View {
	let providers: [NSItemProvider]
	let onDone: () -> Void
	let onCancel: () -> Void

	@State private var sessions: [SessionDigest] = []
	@State private var files: [SharedFile] = []
	@State private var note = ""
	@State private var loading = true
	@State private var sending: String?
	@State private var failure: String?

	private var client: DeckClient? {
		CredentialStore.load().map { DeckClient(credentials: $0) }
	}

	var body: some View {
		NavigationStack {
			Group {
				if loading {
					ProgressView("Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
				} else if client == nil {
					unavailable("Not signed in", "Open deck and sign in, then share again.")
				} else if let failure {
					unavailable("Couldn't share", failure)
				} else if sessions.isEmpty {
					unavailable("No sessions", "Start one in deck, then share again.")
				} else {
					list
				}
			}
			.navigationTitle(title)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel", action: onCancel).disabled(sending != nil)
				}
			}
		}
		.task { await load() }
	}

	private var title: String {
		files.count == 1 ? files[0].name : "Share \(files.count) files"
	}

	private var list: some View {
		List {
			Section {
				TextField("Say something about it (optional)", text: $note, axis: .vertical)
					.lineLimit(1...3)
					.disabled(sending != nil)
			}
			Section("Send to") {
				ForEach(sessions) { session in
					Button {
						Task { await send(to: session) }
					} label: {
						row(session)
					}
					.buttonStyle(.plain)
					.disabled(sending != nil)
				}
			}
		}
	}

	private func row(_ session: SessionDigest) -> some View {
		let when = RelativeFormat.string(session.lastActiveAt)
		return HStack {
			VStack(alignment: .leading, spacing: 2) {
				Text(session.title ?? session.id).lineLimit(1)
				Text(when).font(.caption).foregroundStyle(.secondary)
			}
			Spacer()
			if sending == session.id { ProgressView() }
		}
		.contentShape(Rectangle())
	}

	private func unavailable(_ title: String, _ message: String) -> some View {
		ContentUnavailableView(title, systemImage: "paperplane", description: Text(message))
	}

	private func load() async {
		files = await ShareItems.load(from: providers)
		if let rejected = files.compactMap(ShareLimits.rejection(for:)).first {
			failure = rejected
			loading = false
			return
		}
		if files.isEmpty {
			failure = "Nothing in this share could be read."
			loading = false
			return
		}
		if let client, let fetched = try? await client.sessions() {
			sessions = ShareTargets.pick(fetched)
		} else if client != nil {
			failure = "deck didn't answer. Is it running?"
		}
		loading = false
	}

	private func send(to session: SessionDigest) async {
		guard let client else { return }
		sending = session.id
		do {
			try await client.upload(sessionId: session.id, files: files, text: note)
			onDone()
		} catch {
			failure = error.localizedDescription
			sending = nil
		}
	}
}
