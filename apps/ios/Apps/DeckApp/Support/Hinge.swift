import SwiftUI
import UIKit

/// The fold of a foldable iPhone, as UIKit reports it, plus the window it is
/// folding: closed (the app is on the outer display), half open (a book held
/// in two hands, or a tabletop with one half lying flat), or fully open. Stays
/// `.unknown` on phones without a hinge and on systems before iOS 27.1.
@Observable
@MainActor
final class HingeMonitor {
	enum Posture: String {
		case unknown, closed, partiallyOpen, fullyOpen
	}

	var posture: Posture = .unknown
	/// The window's full size, so a layout can put its seam on the fold.
	var windowSize: CGSize = .zero {
		// The keyboard takes height at the same width; that is not a shorter window.
		didSet { fullHeight = windowSize.width == oldValue.width ? max(fullHeight, windowSize.height) : windowSize.height }
	}
	private var fullHeight: CGFloat = 0
	/// The window's bottom safe area as UIKit has it, which settles after the
	/// window moves to the other display; the fold's panes are built again on it.
	var bottomInset: CGFloat = 0

	/// A phone window under 720 pt tall: either display of a foldable (678 and
	/// 669 pt), not a phone in portrait (850 pt or more). It gives the title
	/// band and the composer's second row to the conversation.
	var isShort: Bool {
		UIDevice.current.userInterfaceIdiom == .phone && fullHeight > 0 && fullHeight < 720
	}

	/// Tests and demos can fake the fold with `DECK_HINGE`: a posture name, or
	/// `tabletop` for half open with the fold across the window whatever the
	/// window's shape (the simulator can neither bend nor turn the open display),
	/// or `switchable` to start closed and fold or unfold on a Darwin
	/// notification (`deck.hinge.closed`, `deck.hinge.fullyOpen`), which a UI
	/// test can post from its own process.
	static let override: String? = ProcessInfo.processInfo.environment["DECK_HINGE"]
	private static let forcedTabletop = override == "tabletop"

	init() {
		if Self.forcedTabletop {
			posture = .partiallyOpen
		} else if Self.override == "switchable" {
			posture = .closed
		} else if let override = Self.override.flatMap(Posture.init(rawValue:)) {
			posture = override
		}
	}

	/// Folds or unfolds a `switchable` fake: closed, the window turns compact
	/// as the outer display is, through UIKit so every view sees the change
	/// (a SwiftUI environment override leaves UIKit's views regular, and the
	/// two then fight over layout without end).
	func fake(_ posture: Posture) {
		Self.faked = self
		_ = Self.listening
		self.posture = posture
		for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
			for window in scene.windows {
				if posture == .closed {
					window.traitOverrides.horizontalSizeClass = .compact
				} else {
					window.traitOverrides.remove(UITraitHorizontalSizeClass.self)
				}
			}
		}
	}

	/// The monitor on screen, which the notifications fold: SwiftUI builds and
	/// throws away others, so it cannot be whichever one was made first.
	private static weak var faked: HingeMonitor?

	private static let listening: Void = {
		for posture in [Posture.closed, .fullyOpen] {
			CFNotificationCenterAddObserver(
				CFNotificationCenterGetDarwinNotifyCenter(), nil,
				{ _, _, name, _, _ in
					guard let name = name?.rawValue as String?,
						let posture = Posture(rawValue: String(name.dropFirst("deck.hinge.".count)))
					else { return }
					Task { @MainActor in HingeMonitor.faked?.fake(posture) }
				},
				"deck.hinge.\(posture.rawValue)" as CFString, nil, .deliverImmediately)
		}
	}()

	/// Half open with the fold across the window, so the top half stands up and
	/// the bottom half lies flat: the layout that puts the transcript above and
	/// the voice controls below.
	var isTabletop: Bool {
		Self.forcedTabletop || (posture == .partiallyOpen && windowSize.height > windowSize.width)
	}

	/// Where the fold crosses a window folded top over bottom.
	var foldY: CGFloat? {
		guard posture != .unknown, windowSize.height > 0 else { return nil }
		return windowSize.height / 2
	}

	/// The window's midline, but only where there is a fold to land on. Like
	/// foldY above, this needs a known posture: without the check it returned
	/// half the window on every iPad and Mac, which pinned the sidebar to half
	/// the screen and made the draggable divider do nothing.
	var halfWidth: CGFloat? {
		guard posture != .unknown, windowSize.width > 0 else { return nil }
		return windowSize.width / 2
	}

	/// Half the window when it is split on the fold, nil otherwise. The one
	/// definition of "split" for the sessions layout and the sheets that must
	/// stay off the fold.
	func splitWidth(_ sizeClass: UserInterfaceSizeClass?) -> CGFloat? {
		sizeClass == .regular && !isTabletop ? halfWidth : nil
	}
}

/// A view the size of the window hosting the hinge interaction, placed once
/// behind everything (see RootView). It reports the window's safe area as
/// UIKit sees it; the window size comes from SwiftUI.
struct HingeObserver: UIViewRepresentable {
	let monitor: HingeMonitor

	final class SafeAreaView: UIView {
		var changed: (CGFloat) -> Void = { _ in }
		override func safeAreaInsetsDidChange() {
			super.safeAreaInsetsDidChange()
			// The window's: this view stops at the keyboard, which is not a
			// change of the window's safe area.
			if let window { changed(window.safeAreaInsets.bottom) }
		}
	}

	func makeUIView(context: Context) -> UIView {
		let view = SafeAreaView()
		view.isUserInteractionEnabled = false
		view.changed = { monitor.bottomInset = $0 }
		if #available(iOS 27.1, *) {
			view.addInteraction(UIHingeInteraction { _, update in
				guard HingeMonitor.override == nil else { return }
				monitor.posture = Self.posture(of: update.hinge)
			})
		}
		return view
	}

	func updateUIView(_ uiView: UIView, context: Context) {}

	@available(iOS 27.1, *)
	private static func posture(of hinge: UIHinge?) -> HingeMonitor.Posture {
		switch hinge?.status {
		case .closed: return .closed
		case .partiallyOpen: return .partiallyOpen
		case .fullyOpen: return .fullyOpen
		default: return .unknown
		}
	}
}
