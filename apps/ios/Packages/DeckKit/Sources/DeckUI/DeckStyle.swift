import SwiftUI

/// Shared shape tokens, so cards, controls and chips agree on their corners.
public enum DeckStyle {
	public enum Radius {
		public static let card: CGFloat = 12
		public static let control: CGFloat = 8
		public static let chip: CGFloat = 6
	}
}

extension View {
	/// Liquid Glass where the OS has it, a material on anything older.
	@ViewBuilder
	public func deckGlass<S: Shape>(in shape: S) -> some View {
		if #available(iOS 26, macOS 26, *) {
			glassEffect(.regular, in: shape)
		} else {
			background(.regularMaterial, in: shape)
		}
	}

	public func deckGlass() -> some View {
		deckGlass(in: RoundedRectangle(cornerRadius: DeckStyle.Radius.card))
	}
}
