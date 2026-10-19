import SwiftUI
import DeckKit
import DeckUI

/// Every device waiting to sign in, each with its code and Approve / Deny.
/// Closes itself once nothing is left to decide.
struct PairingSheet: View {
	@Environment(DeckStore.self) private var store
	@Environment(\.dismiss) private var dismiss
	@State private var busy: String?
	@State private var failure: String?

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(spacing: 16) {
					ForEach(store.pairingRequests) { request in
						PairingRequestRow(request: request, busy: busy != nil) { approve in
							decide(request, approve: approve)
						}
					}
					if let failure {
						Text(failure).font(.footnote).foregroundStyle(.red)
					}
				}
				.padding()
			}
			.navigationTitle("Sign-in request")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Later") { dismiss() }
				}
			}
		}
		.presentationDetents([.medium, .large])
		.onChange(of: store.pairingRequests.isEmpty) { _, empty in
			if empty { dismiss() }
		}
	}

	private func decide(_ request: PairingRequest, approve: Bool) {
		busy = request.id
		failure = nil
		Task {
			do {
				try await store.decidePairing(id: request.id, approve: approve)
			} catch {
				failure = error.localizedDescription
			}
			busy = nil
		}
	}
}

/// Opens the pairing sheet when a device asks to sign in. "Later" puts it away
/// until a new request arrives; the Sessions banner reopens it.
struct PairingPrompt: ViewModifier {
	@Environment(DeckStore.self) private var store
	@State private var deferred = Set<String>()

	private var hasNew: Bool {
		store.pairingRequests.contains { !deferred.contains($0.id) }
	}

	func body(content: Content) -> some View {
		content.sheet(isPresented: Binding(
			get: { hasNew },
			set: { if !$0 { deferred.formUnion(store.pairingRequests.map(\.id)) } }
		)) {
			PairingSheet()
		}
	}
}

/// A row at the top of the session list while a device is waiting, so a
/// request put off with "Later" is still in reach.
struct PairingBanner: View {
	@Environment(DeckStore.self) private var store
	@State private var showing = false

	var body: some View {
		let count = store.pairingRequests.count
		if count > 0 {
			Button { showing = true } label: {
				Label(
					count == 1 ? "A device wants to sign in" : "\(count) devices want to sign in",
					systemImage: "iphone.and.arrow.forward")
					.font(.subheadline.weight(.medium))
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			.buttonStyle(.plain)
			.foregroundStyle(Color.accentColor)
			.padding(.horizontal, 12)
			.padding(.vertical, 8)
			.background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
			.padding(.horizontal)
			.accessibilityIdentifier("pairingBanner")
			.sheet(isPresented: $showing) { PairingSheet() }
		}
	}
}
