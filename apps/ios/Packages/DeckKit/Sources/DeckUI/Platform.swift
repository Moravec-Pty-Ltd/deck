import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// The few UIKit-only names the shared views use, mapped onto AppKit so DeckUI
// also builds for a plain macOS target.

#if canImport(UIKit)
public typealias PlatformImage = UIImage
#elseif canImport(AppKit)
public typealias PlatformImage = NSImage
#endif

extension Image {
	public init(platformImage: PlatformImage) {
		#if canImport(UIKit)
		self.init(uiImage: platformImage)
		#else
		self.init(nsImage: platformImage)
		#endif
	}
}

extension Color {
	static var deckSecondaryGroupedBackground: Color {
		#if canImport(UIKit)
		Color(.secondarySystemGroupedBackground)
		#else
		Color(nsColor: .controlBackgroundColor)
		#endif
	}

	static var deckTertiaryGroupedBackground: Color {
		#if canImport(UIKit)
		Color(.tertiarySystemGroupedBackground)
		#else
		Color(nsColor: .underPageBackgroundColor)
		#endif
	}

	static var deckTertiaryFill: Color {
		#if canImport(UIKit)
		Color(.tertiarySystemFill)
		#else
		Color(nsColor: .quaternaryLabelColor)
		#endif
	}

	static var deckSeparator: Color {
		#if canImport(UIKit)
		Color(.separator)
		#else
		Color(nsColor: .separatorColor)
		#endif
	}
}

extension View {
	/// An inline navigation title where the platform has one; macOS has no
	/// large titles to opt out of.
	func deckInlineNavigationTitle() -> some View {
		#if canImport(UIKit)
		navigationBarTitleDisplayMode(.inline)
		#else
		self
		#endif
	}
}
