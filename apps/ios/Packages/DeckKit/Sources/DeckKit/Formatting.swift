import Foundation

/// deck's API reports timestamps as epoch milliseconds (JS `Date.now()`).
public enum RelativeFormat {
	private static let formatter: RelativeDateTimeFormatter = {
		let formatter = RelativeDateTimeFormatter()
		formatter.unitsStyle = .abbreviated
		return formatter
	}()

	public static func string(_ epochMs: Double?) -> String {
		guard let epochMs else { return "" }
		let date = Date(timeIntervalSince1970: epochMs / 1000)
		return formatter.localizedString(for: date, relativeTo: Date())
	}
}

public enum CostFormat {
	public static func string(_ costUsd: Double?) -> String? {
		guard let costUsd else { return nil }
		return String(format: "$%.2f", costUsd)
	}
}
