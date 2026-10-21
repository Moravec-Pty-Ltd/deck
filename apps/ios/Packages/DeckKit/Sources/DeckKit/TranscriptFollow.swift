import Foundation

/// Whether a transcript keeps its newest output in view. While the reader is at
/// (or near) the end, anything that changes the layout pulls the view back down
/// to it; once they scroll up to read, it stays put until they scroll back.
public enum TranscriptFollow {
	/// How close to the end, in points, still counts as being at it.
	public static let threshold: Double = 120

	/// The scroll view's shape at one moment, in points.
	public struct Geometry: Equatable, Sendable {
		public var offset: Double
		public var contentHeight: Double
		public var containerHeight: Double

		public init(offset: Double, contentHeight: Double, containerHeight: Double) {
			self.offset = offset
			self.contentHeight = contentHeight
			self.containerHeight = containerHeight
		}

		public var distanceToEnd: Double { contentHeight - offset - containerHeight }
	}

	public struct Step: Equatable, Sendable {
		/// Whether the end is followed after this change.
		public var isNearBottom: Bool
		/// Whether to scroll to the end now.
		public var pin: Bool
	}

	/// What one geometry change means for following. Only the offset moving on
	/// its own (the reader scrolling) changes whether the end is followed: the
	/// content growing (a message, streamed text, a lazy row taking its real
	/// height) or the view resizing moves the end, never the reader. And only a
	/// move up can stop following, because a pin to an end the lazy stack is
	/// still estimating can land short, and that must not read as the reader
	/// leaving. While the reader's finger (or momentum) is moving the view, it
	/// never pins: scrolling up a lazy stack measures the rows coming into view,
	/// so the content changes height on every frame of the scroll.
	public static func step(from old: Geometry, to new: Geometry, isNearBottom: Bool, userScrolling: Bool = false) -> Step {
		if userScrolling {
			return Step(isNearBottom: new.distanceToEnd < threshold, pin: false)
		}
		if new.contentHeight != old.contentHeight || new.containerHeight != old.containerHeight {
			return Step(isNearBottom: isNearBottom, pin: isNearBottom)
		}
		if new.offset < old.offset {
			return Step(isNearBottom: new.distanceToEnd < threshold, pin: false)
		}
		if new.offset > old.offset, new.distanceToEnd < threshold {
			return Step(isNearBottom: true, pin: false)
		}
		return Step(isNearBottom: isNearBottom, pin: false)
	}
}
