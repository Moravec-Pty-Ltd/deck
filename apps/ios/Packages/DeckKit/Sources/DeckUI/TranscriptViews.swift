import SwiftUI
import DeckKit

extension View {
	/// Keeps a transcript's end in view while the reader is at it (see
	/// `TranscriptFollow`). Apply to the `ScrollView`; `endId` names a fixed-size
	/// marker after the last row, because aiming at the last row itself lands
	/// short while a lazy stack is still estimating heights. `paused` holds off
	/// pinning while the caller scrolls somewhere else on purpose.
	public func followsTranscriptEnd(
		isNearBottom: Binding<Bool>, proxy: ScrollViewProxy, endId: String = "bottom", paused: Bool = false
	) -> some View {
		modifier(TranscriptEndFollower(isNearBottom: isNearBottom, proxy: proxy, endId: endId, paused: paused))
	}
}

private struct TranscriptEndFollower: ViewModifier {
	@Binding var isNearBottom: Bool
	let proxy: ScrollViewProxy
	let endId: String
	let paused: Bool
	@State private var userScrolling = false

	func body(content: Content) -> some View {
		content
			.onScrollPhaseChange { _, phase in
				userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
			}
			.onScrollGeometryChange(for: TranscriptFollow.Geometry.self) { geometry in
				TranscriptFollow.Geometry(
					offset: geometry.contentOffset.y,
					contentHeight: geometry.contentSize.height,
					containerHeight: geometry.containerSize.height)
			} action: { old, new in
				let step = TranscriptFollow.step(from: old, to: new, isNearBottom: isNearBottom, userScrolling: userScrolling)
				if step.isNearBottom != isNearBottom { isNearBottom = step.isNearBottom }
				if step.pin, !paused { proxy.scrollTo(endId, anchor: .bottom) }
			}
	}
}

/// A spinner and "Working…", shown while a session's turn runs.
public struct WorkingLabel: View {
	public init() {}

	public var body: some View {
		HStack(spacing: 8) {
			WorkingSpinner().accessibilityHidden(true)
			Text("Working…")
				.font(.footnote)
				.foregroundStyle(.secondary)
		}
		.accessibilityElement(children: .combine)
	}
}
