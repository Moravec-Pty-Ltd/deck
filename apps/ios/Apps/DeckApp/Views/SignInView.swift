import SwiftUI
import AVFoundation
import DeckKit

struct SignInView: View {
	@Environment(DeckStore.self) private var store
	@State private var showScanner = false
	@State private var serverURL = ""
	@State private var token = ""
	@State private var errorMessage: String?

	var body: some View {
		NavigationStack {
			VStack(spacing: 24) {
				VStack(spacing: 8) {
					Image(systemName: "square.stack.3d.up")
						.font(.system(size: 40))
						.foregroundStyle(.secondary)
					Text("Sign in to deck")
						.font(.title2.bold())
					Text("Scan the QR code shown on your deck server's sign-in page to connect this device.")
						.font(.subheadline)
						.foregroundStyle(.secondary)
						.multilineTextAlignment(.center)
				}
				.padding(.top, 40)

				Button {
					requestScanner()
				} label: {
					Label("Scan QR code", systemImage: "qrcode.viewfinder")
						.frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.controlSize(.large)

				if let errorMessage {
					Text(errorMessage)
						.font(.footnote)
						.foregroundStyle(.red)
						.multilineTextAlignment(.center)
				}

				Divider()

				DisclosureGroup("Enter details manually") {
					VStack(alignment: .leading, spacing: 12) {
						TextField("Server URL", text: $serverURL)
							.textContentType(.URL)
							.keyboardType(.URL)
							.autocorrectionDisabled()
							.textInputAutocapitalization(.never)
						SecureField("Token", text: $token)
							.autocorrectionDisabled()
							.textInputAutocapitalization(.never)
						Button("Connect") {
							connectManually()
						}
						.buttonStyle(.bordered)
						.disabled(serverURL.isEmpty || token.isEmpty)
					}
					.padding(.top, 8)
				}

				Spacer()
			}
			.padding()
			.navigationTitle("deck")
			.navigationBarTitleDisplayMode(.inline)
			.sheet(isPresented: $showScanner) {
				QRScanSheet { code in
					handle(code: code)
				}
			}
		}
	}

	private func requestScanner() {
		switch AVCaptureDevice.authorizationStatus(for: .video) {
		case .authorized:
			errorMessage = nil
			showScanner = true
		case .notDetermined:
			AVCaptureDevice.requestAccess(for: .video) { granted in
				Task { @MainActor in
					if granted {
						errorMessage = nil
						showScanner = true
					} else {
						errorMessage = "Camera access is required to scan the sign-in QR code."
					}
				}
			}
		default:
			errorMessage = "Camera access is disabled. Enable it in Settings to scan the sign-in QR code."
		}
	}

	private func handle(code: String) {
		showScanner = false
		guard let credentials = DeckQR.parse(code) else {
			errorMessage = "That QR code isn't a deck sign-in code."
			return
		}
		errorMessage = nil
		store.signIn(credentials)
	}

	private func connectManually() {
		guard let url = URL(string: serverURL), url.scheme != nil, url.host != nil else {
			errorMessage = "Enter a valid server URL, e.g. http://192.168.1.10:4818"
			return
		}
		errorMessage = nil
		store.signIn(Credentials(baseURL: url, token: token))
	}
}

private struct QRScanSheet: View {
	@Environment(\.dismiss) private var dismiss
	var onCode: (String) -> Void

	var body: some View {
		NavigationStack {
			QRScannerView(onCode: onCode)
				.ignoresSafeArea()
				.overlay(alignment: .bottom) {
					Text("Point your camera at the QR code on deck's sign-in page")
						.font(.footnote)
						.foregroundStyle(.white)
						.padding(8)
						.background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
						.padding(.bottom, 32)
				}
				.toolbar {
					ToolbarItem(placement: .cancellationAction) {
						Button("Cancel") { dismiss() }
					}
				}
		}
	}
}
