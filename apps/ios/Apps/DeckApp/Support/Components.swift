import SwiftUI
import DeckKit

/// Small colored status indicator: green running, gray idle, orange awaiting
/// input, red error/dead.
struct StatusDot: View {
	let session: SessionDigest

	private var color: Color {
		if session.awaitingInput == true { return .orange }
		switch session.status {
		case .running: return .green
		case .idle: return .gray
		case .error, .dead: return .red
		case .unknown: return .gray
		}
	}

	var body: some View {
		Circle()
			.fill(color)
			.frame(width: 8, height: 8)
	}
}

struct Chip: View {
	let text: String
	var color: Color = .secondary

	var body: some View {
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
	init(hex: UInt32) {
		self.init(
			.sRGB,
			red: Double((hex >> 16) & 0xff) / 255,
			green: Double((hex >> 8) & 0xff) / 255,
			blue: Double(hex & 0xff) / 255)
	}

	// GitHub PR state hues, matching deck's web sidebar.
	static let prOpen = Color(hex: 0x1f883d)
	static let prMerged = Color(hex: 0x8250df)
	static let prClosed = Color(hex: 0xcf222e)
	static let prDraft = Color(hex: 0x6e7781)
}

enum PRDisplay {
	static func color(for pr: SessionPR) -> Color {
		switch pr.state?.lowercased() {
		case "merged": return .prMerged
		case "closed": return .prClosed
		case "draft": return .prDraft
		default: return .prOpen
		}
	}

	static func label(for pr: SessionPR) -> String {
		let number = pr.number.map { "#\($0)" } ?? "PR"
		let state = pr.state?.capitalized
		return [number, state].compactMap { $0 }.joined(separator: " · ")
	}
}

/// Green ticks per approval, red crosses per change-request (capped), mirroring
/// the web's ReviewMarks.
struct ReviewMarks: View {
	let approvals: Int
	let changesRequested: Int
	var cap = 5

	var body: some View {
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
struct PRStatusBadge: View {
	let pr: SessionPR

	var body: some View {
		HStack(spacing: 6) {
			Chip(text: PRDisplay.label(for: pr), color: PRDisplay.color(for: pr))
			ReviewMarks(approvals: pr.approvals ?? 0, changesRequested: pr.changesRequested ?? 0)
		}
	}
}
