import SwiftUI
import DeckKit

/// One device asking to sign in: a field for the code it shows, and the choice. Mirrors the web's PairApprovals card.
public struct PairingRequestRow: View {
	let request: PairingRequest
	let busy: Bool
	let onDecide: (_ code: String?) -> Void
	@State private var code = ""

	public init(request: PairingRequest, busy: Bool, onDecide: @escaping (_ code: String?) -> Void) {
		self.request = request
		self.busy = busy
		self.onDecide = onDecide
	}

	private var typed: String { code.filter { !$0.isWhitespace } }

	public var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Label("A device wants to access deck", systemImage: "iphone.and.arrow.forward")
				.font(.headline)
			Text("Type the code it shows to approve it.")
				.font(.subheadline)
				.foregroundStyle(.secondary)
			TextField("Code", text: $code)
				.font(.system(.title, design: .monospaced).weight(.semibold))
				.multilineTextAlignment(.center)
				.textFieldStyle(.roundedBorder)
				#if os(iOS)
				.keyboardType(.numberPad)
				#endif
				.accessibilityIdentifier("pairingCode")
			HStack(spacing: 12) {
				Button(role: .destructive) { onDecide(nil) } label: {
					Label("Deny", systemImage: "xmark").frame(maxWidth: .infinity)
				}
				.buttonStyle(.bordered)
				.accessibilityIdentifier("pairingDeny")
				Button { onDecide(typed) } label: {
					Label("Approve", systemImage: "checkmark").frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.disabled(typed.count != 6)
				.accessibilityIdentifier("pairingApprove")
			}
			.controlSize(.large)
			.disabled(busy)
		}
		.padding()
		.background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
	}
}
