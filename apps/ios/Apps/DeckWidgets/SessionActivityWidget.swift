import ActivityKit
import SwiftUI
import WidgetKit

/// A running session on the lock screen and in the Dynamic Island: status,
/// time since it started, cost so far, the newest reply, and a Stop button.
struct SessionActivityWidget: Widget {
	var body: some WidgetConfiguration {
		ActivityConfiguration(for: SessionActivityAttributes.self) { context in
			LockScreenCard(context: context)
				.widgetURL(sessionURL(context.attributes.sessionId))
		} dynamicIsland: { context in
			DynamicIsland {
				DynamicIslandExpandedRegion(.leading) {
					StatusDot(state: context.state).font(.caption).padding(.leading, 4)
				}
				DynamicIslandExpandedRegion(.trailing) {
					Elapsed(startedAt: context.attributes.startedAt, state: context.state)
						.font(.caption.monospacedDigit())
						.foregroundStyle(.secondary)
				}
				DynamicIslandExpandedRegion(.center) {
					Text(context.attributes.title).font(.subheadline.weight(.semibold)).lineLimit(1)
				}
				DynamicIslandExpandedRegion(.bottom) {
					CardBody(context: context)
				}
			} compactLeading: {
				StatusDot(state: context.state).font(.caption)
			} compactTrailing: {
				Elapsed(startedAt: context.attributes.startedAt, state: context.state)
					.font(.caption2.monospacedDigit())
					.frame(maxWidth: 44)
			} minimal: {
				StatusDot(state: context.state).font(.caption)
			}
			.widgetURL(sessionURL(context.attributes.sessionId))
		}
	}
}

private func sessionURL(_ id: String) -> URL? {
	URL(string: "deck://s/\(id)")
}

private func statusLine(_ state: SessionActivityAttributes.ContentState) -> String {
	if state.awaitingInput { return "Waiting for your answer" }
	switch state.status {
	case "running": return "Working…"
	case "idle": return "Finished"
	case "error": return "Ended with an error"
	default: return state.status.capitalized
	}
}

private func costLine(_ state: SessionActivityAttributes.ContentState) -> String {
	var parts = ["\(state.turns) turn\(state.turns == 1 ? "" : "s")"]
	if state.costUsd > 0 { parts.append(String(format: "$%.2f", state.costUsd)) }
	return parts.joined(separator: " · ")
}

/// Counts up while the session runs; shows how long ago it last changed once
/// it stops.
private struct Elapsed: View {
	let startedAt: Date
	let state: SessionActivityAttributes.ContentState

	var body: some View {
		if state.status == "running" {
			Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
		} else {
			Text(Date(timeIntervalSince1970: state.updatedAt / 1000), style: .relative)
		}
	}
}

/// The status as a symbol whose shape, not only its colour, tells the states
/// apart: StandBy's night mode tints everything red.
private struct StatusDot: View {
	let state: SessionActivityAttributes.ContentState

	private var symbol: (name: String, color: Color) {
		if state.awaitingInput { return ("questionmark.circle.fill", .orange) }
		switch state.status {
		case "running": return ("play.circle.fill", .green)
		case "idle": return ("checkmark.circle.fill", .gray)
		default: return ("exclamationmark.triangle.fill", .red)
		}
	}

	var body: some View {
		Image(systemName: symbol.name)
			.foregroundStyle(symbol.color)
			.accessibilityLabel(statusLine(state))
	}
}

/// The reply text, the cost line, and Stop while the turn runs.
private struct CardBody: View {
	let context: ActivityViewContext<SessionActivityAttributes>

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(context.state.lastText.isEmpty ? statusLine(context.state) : context.state.lastText)
				.font(.footnote)
				.lineLimit(3)
				.privacySensitive()
			HStack {
				Text(costLine(context.state))
					.font(.caption2)
					.foregroundStyle(.secondary)
				Spacer()
				if context.state.status == "running" {
					Button(intent: StopSessionActivityIntent(sessionId: context.attributes.sessionId)) {
						Label("Stop", systemImage: "stop.fill")
					}
					.buttonStyle(.bordered)
					.tint(.red)
					.controlSize(.small)
				}
			}
		}
	}
}

private struct LockScreenCard: View {
	let context: ActivityViewContext<SessionActivityAttributes>
	@Environment(\.isActivityFullscreen) private var fullscreen

	var body: some View {
		if fullscreen {
			StandByCard(attributes: context.attributes, state: context.state)
		} else {
			card
		}
	}

	private var card: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 8) {
				StatusDot(state: context.state)
				Text(context.attributes.title)
					.font(.subheadline.weight(.semibold))
					.lineLimit(1)
				Spacer()
				Elapsed(startedAt: context.attributes.startedAt, state: context.state)
					.font(.caption.monospacedDigit())
					.foregroundStyle(.secondary)
			}
			CardBody(context: context)
		}
		.padding(12)
		.activityBackgroundTint(Color.black.opacity(0.6))
	}
}

/// StandBy's full-screen card. StandBy scales the lock-screen presentation up
/// about 2x within the same height, so this keeps lock-screen sizes and spends
/// them on what reads from across a desk: status in words, elapsed time, the
/// title, and Stop as a large target beside it.
struct StandByCard: View {
	let attributes: SessionActivityAttributes
	let state: SessionActivityAttributes.ContentState

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			HStack(spacing: 6) {
				StatusDot(state: state)
				Text(statusLine(state))
				Spacer()
				Elapsed(startedAt: attributes.startedAt, state: state)
					.monospacedDigit()
			}
			.font(.subheadline.weight(.semibold))
			HStack(spacing: 10) {
				Text(attributes.title)
					.font(.title2.bold())
					.lineLimit(2)
					.minimumScaleFactor(0.7)
				Spacer(minLength: 0)
				if state.status == "running" {
					Button(intent: StopSessionActivityIntent(sessionId: attributes.sessionId)) {
						Label("Stop", systemImage: "stop.fill").font(.headline)
					}
					.buttonStyle(.borderedProminent)
					.controlSize(.large)
					.tint(.red)
				}
			}
			if !state.lastText.isEmpty {
				Text(state.lastText)
					.font(.footnote)
					.foregroundStyle(.secondary)
					.lineLimit(2)
					.privacySensitive()
			}
		}
		.padding(14)
		.activityBackgroundTint(Color.black.opacity(0.6))
	}
}
