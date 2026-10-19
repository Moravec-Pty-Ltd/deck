import DeckBrowser
import SwiftUI

/// How to reach the deck machine's SSH server, which is what makes its
/// localhost reachable from here.
///
/// Asked for rather than inferred: deck's own origin gives the host, but
/// nothing in deck knows the SSH user or password, and they are not deck's to
/// know. The host is prefilled from the deck origin because that is the machine
/// the dev servers are on.
struct TunnelSheet: View {
	@Bindable var model: BrowserModel
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Form {
				Section("Deck machine") {
					TextField("Host", text: $model.settings.host)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
					TextField("Port", value: $model.settings.port, format: .number)
					TextField("User", text: $model.settings.username)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
					SecureField("Password", text: $model.password)
				}

				Section {
					Toggle("Connect automatically", isOn: $model.settings.autoConnect)
				} footer: {
					Text(
						"""
						Needs sshd running on that machine with TCP forwarding allowed. \
						The local port is picked automatically and shown below; only this \
						app ever connects to it.
						""")
				}

				Section("Status") {
					LabeledContent("Tunnel", value: model.status)
					if !model.lastForward.isEmpty {
						LabeledContent("Last request", value: model.lastForward)
							.font(.caption.monospaced())
					}
				}

				Section {
					if model.isConnected {
						Button("Disconnect") { model.disconnect() }
					} else {
						Button("Connect") { model.connect() }
					}
					// The only way past a host-key mismatch, and deliberately a
					// separate deliberate action rather than a button on the error.
					Button("Forget this machine's host key", role: .destructive) {
						model.forgetHostKey()
					}
				}
			}
			.navigationTitle("Tunnel")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					Button("Done") { dismiss() }
				}
			}
		}
	}
}
