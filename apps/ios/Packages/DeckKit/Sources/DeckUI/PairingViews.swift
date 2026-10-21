import SwiftUI
import DeckKit

/// One device asking to sign in: the code to compare against the one it shows,
/// and the choice. Mirrors the web's PairApprovals card.
public struct PairingRequestRow: View {
	let request: PairingRequest
	let busy: Bool
	let onDecide: (Bool) -> Void

	public init(request: PairingRequest, busy: Bool, onDecide: @escaping (Bool) -> Void) {
		self.request = request
		self.busy = busy
		self.onDecide = onDecide
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Label("A device wants to access deck", systemImage: "iphone.and.arrow.forward")
				.font(.headline)
			Text("Approve only if this code shows on that device:")
				.font(.subheadline)
				.foregroundStyle(.secondary)
			Text(request.code)
				.font(.system(.largeTitle, design: .monospaced).weight(.semibold))
				.tracking(6)
				.frame(maxWidth: .infinity)
				.accessibilityIdentifier("pairingCode")
			HStack(spacing: 12) {
				Button(role: .destructive) { onDecide(false) } label: {
					Label("Deny", systemImage: "xmark").frame(maxWidth: .infinity)
				}
				.buttonStyle(.bordered)
				.accessibilityIdentifier("pairingDeny")
				Button { onDecide(true) } label: {
					Label("Approve", systemImage: "checkmark").frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.accessibilityIdentifier("pairingApprove")
			}
			.controlSize(.large)
			.disabled(busy)
		}
		.padding()
		.background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
	}
}
