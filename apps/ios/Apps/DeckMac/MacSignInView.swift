import SwiftUI
import DeckKit

/// Sign in without a camera: paste the server and token (or a whole sign-in
/// link), or ask the server for access and approve the request from a browser
/// that is already signed in.
struct MacSignInView: View {
	@Environment(DeckStore.self) private var store
	@State private var serverURL = ""
	@State private var token = ""
	@State private var errorMessage: String?
	@State private var ticket: PairingTicket?
	@State private var pairing: Task<Void, Never>?

	var body: some View {
		VStack(spacing: 20) {
			VStack(spacing: 6) {
				Image(systemName: "square.stack.3d.up")
					.font(.system(size: 36))
					.foregroundStyle(.secondary)
				Text("Sign in to deck")
					.font(.title2.bold())
			}
			Form {
				Section {
					TextField("Server URL", text: $serverURL, prompt: Text("http://localhost:4818"))
						.autocorrectionDisabled()
				} footer: {
					Text("A sign-in link from deck's QR page fills in the token too.")
						.font(.caption)
						.foregroundStyle(.secondary)
				}
				Section("Paste the token") {
					SecureField("Token", text: $token)
					Button("Connect", action: connectWithToken)
						.keyboardShortcut(.defaultAction)
						.disabled(serverURL.isEmpty || (token.isEmpty && DeckQR.parse(serverURL) == nil))
				}
				Section("Or ask for access") {
					pairingRow
				}
			}
			.formStyle(.grouped)
			if let errorMessage {
				Text(errorMessage)
					.font(.footnote)
					.foregroundStyle(.red)
					.multilineTextAlignment(.center)
			}
		}
		.padding(24)
		.frame(maxWidth: 520)
		.onDisappear { pairing?.cancel() }
	}

	@ViewBuilder
	private var pairingRow: some View {
		if let ticket {
			VStack(alignment: .leading, spacing: 8) {
				Text(ticket.code)
					.font(.system(size: 34, weight: .semibold, design: .monospaced))
					.textSelection(.enabled)
				Text("Approve this request in deck in a browser that is already signed in, after checking it shows the same code.")
					.font(.callout)
					.foregroundStyle(.secondary)
				HStack {
					ProgressView().controlSize(.small)
					Text("Waiting for approval")
						.font(.caption)
						.foregroundStyle(.secondary)
					Spacer()
					Button("Cancel", action: cancelPairing)
				}
			}
		} else {
			Button("Request access", action: requestAccess)
				.disabled(serverURL.isEmpty)
		}
	}

	private func origin() -> URL? {
		let text = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
		if let credentials = DeckQR.parse(text) { return credentials.baseURL }
		guard let url = URL(string: text), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil
		else { return nil }
		return url
	}

	private func connectWithToken() {
		if let credentials = DeckQR.parse(serverURL), token.isEmpty {
			errorMessage = nil
			store.signIn(credentials)
			return
		}
		guard let url = origin() else {
			errorMessage = "Enter a valid server URL, e.g. http://localhost:4818"
			return
		}
		errorMessage = nil
		store.signIn(Credentials(baseURL: url, token: token.trimmingCharacters(in: .whitespacesAndNewlines)))
	}

	private func requestAccess() {
		guard let url = origin() else {
			errorMessage = "Enter a valid server URL, e.g. http://localhost:4818"
			return
		}
		errorMessage = nil
		let client = PairingClient(baseURL: url)
		pairing?.cancel()
		pairing = Task { await pair(client) }
	}

	private func pair(_ client: PairingClient) async {
		do {
			let ticket = try await client.request()
			self.ticket = ticket
			while !Task.isCancelled {
				try await Task.sleep(for: .seconds(2))
				let claim = try await client.status(secret: ticket.secret)
				if claim != .pending {
					finish(claim, baseURL: client.baseURL)
					return
				}
			}
		} catch is CancellationError {
			return
		} catch {
			self.ticket = nil
			errorMessage = "Couldn't reach deck: \(error.localizedDescription)"
		}
	}

	private func finish(_ claim: PairingClaim, baseURL: URL) {
		ticket = nil
		switch claim {
		case .approved(let token):
			store.signIn(Credentials(baseURL: baseURL, token: token))
		case .denied:
			errorMessage = "The request was denied."
		case .expired:
			errorMessage = "The request expired. Ask again."
		case .unknown, .pending:
			errorMessage = "deck no longer knows this request. Ask again."
		}
	}

	private func cancelPairing() {
		pairing?.cancel()
		pairing = nil
		ticket = nil
	}
}
