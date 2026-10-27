import SwiftUI
import DeckKit

/// Small colored status indicator: green running, gray idle, orange awaiting
/// input, red error/dead.
public struct StatusDot: View {
	let session: SessionDigest

	public init(session: SessionDigest) {
		self.session = session
	}

	private var unread: Bool { session.unread == true }

	// Unread recolours the grey dot rather than adding a second one, so marking
	// a session read never shifts its row.
	private var color: Color {
		if session.awaitingInput == true { return .orange }
		switch session.status {
		case .running: return .green
		case .idle, .unknown: return unread ? .teal : .gray
		case .error, .dead: return .red
		}
	}

	public var body: some View {
		Circle()
			.fill(color)
			.frame(width: 8, height: 8)
			.accessibilityHidden(!unread)
			.accessibilityLabel("Unread")
	}
}

public struct Chip: View {
	let text: String
	var color: Color = .secondary

	public init(text: String, color: Color = .secondary) {
		self.text = text
		self.color = color
	}

	public var body: some View {
		Text(text)
			.font(.caption2.weight(.medium))
			.lineLimit(1)
			.padding(.horizontal, 6)
			.padding(.vertical, 2)
			.background(color.opacity(0.15), in: Capsule())
			.foregroundStyle(color)
	}
}

extension Color {
	public init(hex: UInt32) {
		self.init(
			.sRGB,
			red: Double((hex >> 16) & 0xff) / 255,
			green: Double((hex >> 8) & 0xff) / 255,
			blue: Double(hex & 0xff) / 255)
	}

	// GitHub PR state hues, matching deck's web sidebar.
	public static let prOpen = Color(hex: 0x1f883d)
	public static let prMerged = Color(hex: 0x8250df)
	public static let prClosed = Color(hex: 0xcf222e)
	public static let prDraft = Color(hex: 0x6e7781)
}

public enum PRDisplay {
	public static func color(for pr: SessionPR) -> Color {
		switch pr.state?.lowercased() {
		case "merged": return .prMerged
		case "closed": return .prClosed
		case "draft": return .prDraft
		default: return .prOpen
		}
	}

	public static func label(for pr: SessionPR) -> String {
		let number = pr.number.map { "#\($0)" } ?? "PR"
		let state = pr.state?.capitalized
		return [number, state].compactMap { $0 }.joined(separator: " · ")
	}

	/// GitHub's overall review decision, as the web's PrMenu words it.
	public static func verdict(for pr: SessionPR) -> (label: String, color: Color)? {
		switch pr.reviewDecision {
		case "APPROVED": return ("Approved", .prOpen)
		case "CHANGES_REQUESTED": return ("Changes requested", .prClosed)
		case "REVIEW_REQUIRED": return ("Review required", .secondary)
		default: return nil
		}
	}

	/// Whether it can merge, or why not; a closed or merged PR shows its state.
	public static func readiness(for pr: SessionPR) -> (label: String, color: Color)? {
		switch pr.state?.lowercased() {
		case "merged": return ("Merged", .prMerged)
		case "closed": return ("Closed", .prClosed)
		case "draft": return ("Draft", .prDraft)
		case "open": break
		default: return nil
		}
		if pr.mergeable == "CONFLICTING" { return ("Conflicts", .prClosed) }
		if isBlocked(pr) { return ("Blocked", .orange) }
		if pr.mergeable == "MERGEABLE" { return ("Ready", .prOpen) }
		return nil
	}

	public static func isBlocked(_ pr: SessionPR) -> Bool {
		pr.mergeStateStatus == "BLOCKED"
	}
}

/// Green ticks per approval, red crosses per change-request (capped), mirroring
/// the web's ReviewMarks.
public struct ReviewMarks: View {
	let approvals: Int
	let changesRequested: Int
	var cap = 5

	public init(approvals: Int, changesRequested: Int, cap: Int = 5) {
		self.approvals = approvals
		self.changesRequested = changesRequested
		self.cap = cap
	}

	public var body: some View {
		if approvals > 0 || changesRequested > 0 {
			HStack(spacing: 3) {
				marks(count: approvals, symbol: "checkmark", color: .prOpen)
				marks(count: changesRequested, symbol: "xmark", color: .prClosed)
			}
		}
	}

	@ViewBuilder
	private func marks(count: Int, symbol: String, color: Color) -> some View {
		if count > 0 {
			HStack(spacing: 1) {
				if count <= cap {
					ForEach(0..<count, id: \.self) { _ in
						Image(systemName: symbol).imageScale(.small)
					}
				} else {
					Image(systemName: symbol).imageScale(.small)
					Text("\(count)").font(.caption2.weight(.semibold))
				}
			}
			.foregroundStyle(color)
			.font(.caption2.weight(.bold))
		}
	}
}

/// A colored PR state chip plus its review marks, for rows and the detail header.
public struct PRStatusBadge: View {
	let pr: SessionPR

	public init(pr: SessionPR) {
		self.pr = pr
	}

	public var body: some View {
		HStack(spacing: 6) {
			Chip(text: PRDisplay.label(for: pr), color: PRDisplay.color(for: pr))
			ReviewMarks(approvals: pr.approvals ?? 0, changesRequested: pr.changesRequested ?? 0)
		}
	}
}

/// Says the deck server is older than the app when it lacks something `needs`
/// names. Those features are hidden on the screen; this says why.
public struct ServerTooOldBanner: View {
	@Environment(DeckStore.self) private var store
	var needs: [DeckCapability]

	public init(needs: [DeckCapability] = DeckCapability.allCases) {
		self.needs = needs
	}

	public var body: some View {
		let missing = store.missing(needs)
		if !missing.isEmpty {
			Label {
				Text("This deck server is older than the app, so \(missing.map(\.label).formatted(.list(type: .and))) \(missing.count == 1 ? "is" : "are") hidden. Update deck to get \(missing.count == 1 ? "it" : "them") back.")
					.font(.footnote)
					.frame(maxWidth: .infinity, alignment: .leading)
			} icon: {
				Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
			}
			.foregroundStyle(.orange)
			.padding(.horizontal, 12)
			.padding(.vertical, 8)
			.background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: DeckStyle.Radius.control))
			.padding(.horizontal)
			.accessibilityIdentifier("serverTooOld")
		}
	}
}
