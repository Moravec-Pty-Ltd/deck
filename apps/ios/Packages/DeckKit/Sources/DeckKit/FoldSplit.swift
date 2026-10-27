import Foundation

/// Where the divider stands between the session list and the session on a
/// foldable opened flat. Mirrors the web sidebar's `clampSidebarWidth`
/// (`sidebar-width.ts`), except that the default is the fold, half the
/// window, and a release near the fold snaps back to it.
public enum FoldSplit {
	/// The `@AppStorage` key the app keeps the chosen width under; 0 is the fold.
	public static let storageKey = "foldListWidth"
	/// Narrower than this and the list's rows stop reading.
	public static let minimum: Double = 260
	/// The session keeps at least the rest of the window.
	public static let maximumFraction: Double = 0.6
	/// How near the fold a release snaps to it.
	public static let snapDistance: Double = 24

	/// The list pane's width for a stored choice in a window this wide.
	public static func width(_ chosen: Double, window: Double) -> Double {
		chosen > 0 ? clamp(chosen, window: window) : window / 2
	}

	/// Within the limits, in whole points. A window too narrow for the minimum
	/// keeps the fold as the lower limit.
	public static func clamp(_ width: Double, window: Double) -> Double {
		guard width.isFinite else { return window / 2 }
		let low = min(minimum, window / 2)
		return min(window * maximumFraction, max(low, width)).rounded()
	}

	/// What to store for a drag released at `width`: 0 near the fold, so the
	/// list keeps to the fold whatever the window, otherwise the clamped width.
	public static func settle(_ width: Double, window: Double) -> Double {
		let clamped = clamp(width, window: window)
		return abs(clamped - window / 2) <= snapDistance ? 0 : clamped
	}
}
