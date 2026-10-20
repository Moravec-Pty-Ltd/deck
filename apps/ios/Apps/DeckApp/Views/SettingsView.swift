import SwiftUI
import UserNotifications
import DeckKit

struct SettingsView: View {
	@Environment(DeckStore.self) private var store
	@State private var testResult: String?
	@State private var isTesting = false
	@State private var notificationStatus: UNAuthorizationStatus = .notDetermined
	@State private var showSignOutConfirm = false

	var body: some View {
		Form {
			Section("Connection") {
				if let baseURL = store.client?.credentials.baseURL {
					LabeledContent("Server", value: baseURL.absoluteString)
				}
				LabeledContent("Status") {
					ConnectionStateLabel(state: store.connection)
				}
				LabeledContent("Needs attention", value: "\(store.awaitingCount)")
			}

			Section("Projects") {
				NavigationLink("Manage projects") {
					ProjectsSettingsView()
				}
			}

			Section("Operator") {
				NavigationLink {
					LocalModelView()
				} label: {
					HStack {
						Text("Model")
						Spacer()
						Text(OperatorController.shared.modelName)
							.font(.caption)
							.foregroundStyle(.secondary)
					}
				}
				.accessibilityIdentifier("openOperatorModel")
			}

			ServerSettingsLink()

			Section("Diagnostics") {
				Button {
					Task { await sendTestRequest() }
				} label: {
					if isTesting {
						ProgressView()
					} else {
						Text("Send test request")
					}
				}
				.disabled(isTesting)

				if let testResult {
					Text(testResult)
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
			}

			Section("Notifications") {
				LabeledContent("Permission", value: notificationStatusText)
				if notificationStatus != .authorized {
					Button("Enable notifications") {
						PushManager.shared.requestAuthorizationAndRegister()
						Task { await refreshNotificationStatus() }
					}
				}
			}

			Section {
				Button("Sign out", role: .destructive) {
					showSignOutConfirm = true
				}
			}
		}
		.navigationTitle("Settings")
		.task { await refreshNotificationStatus() }
		.confirmationDialog("Sign out of deck?", isPresented: $showSignOutConfirm, titleVisibility: .visible) {
			Button("Sign out", role: .destructive) { store.signOut() }
			Button("Cancel", role: .cancel) {}
		}
	}

	private var notificationStatusText: String {
		switch notificationStatus {
		case .authorized: return "Enabled"
		case .denied: return "Denied"
		case .notDetermined: return "Not requested"
		case .provisional: return "Provisional"
		case .ephemeral: return "Ephemeral"
		@unknown default: return "Unknown"
		}
	}

	private func refreshNotificationStatus() async {
		let settings = await UNUserNotificationCenter.current().notificationSettings()
		notificationStatus = settings.authorizationStatus
	}

	private func sendTestRequest() async {
		guard let client = store.client else { return }
		isTesting = true
		do {
			let sessions = try await client.sessions()
			testResult = "OK — \(sessions.count) session\(sessions.count == 1 ? "" : "s")"
		} catch {
			testResult = "Failed: \(error.localizedDescription)"
		}
		isTesting = false
	}
}

struct ConnectionStateLabel: View {
	let state: DeckStore.ConnectionState

	var body: some View {
		switch state {
		case .signedOut:
			Text("Signed out").foregroundStyle(.secondary)
		case .connecting:
			Text("Connecting…").foregroundStyle(.secondary)
		case .live:
			Label("Live", systemImage: "circle.fill").foregroundStyle(.green)
		case .offline(let reason):
			Text("Offline: \(reason)").foregroundStyle(.red)
		}
	}
}
