#if canImport(UIKit) && !os(watchOS)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Putting text on the clipboard from the shared layer. UIPasteboard covers
/// iOS, iPadOS and Mac Catalyst alike; AppKit covers a plain macOS build.
/// watchOS has no pasteboard at all, so `isAvailable` is false there and the
/// callers leave the affordance out rather than offering one that does nothing.
public enum TextClipboard {
	public static var isAvailable: Bool {
		#if os(watchOS)
		return false
		#else
		return true
		#endif
	}

	public static func copy(_ text: String) {
		#if canImport(UIKit) && !os(watchOS)
		UIPasteboard.general.string = text
		#elseif canImport(AppKit)
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(text, forType: .string)
		#endif
	}
}
