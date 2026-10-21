import SwiftUI

/// Shown when the watch has no credentials yet. There is no on-watch QR flow;
/// pairing always comes from the iPhone app via WatchConnectivity (PhoneSync).
struct PairingView: View {
	var body: some View {
		NavigationStack {
			VStack(spacing: 12) {
				Image(systemName: "iphone.gen3")
					.font(.largeTitle)
					.foregroundStyle(.secondary)
				Text("Open deck on your iPhone to sync sign-in.")
					.font(.footnote)
					.multilineTextAlignment(.center)
					.foregroundStyle(.secondary)
			}
			.padding()
			.navigationTitle("deck")
		}
	}
}
