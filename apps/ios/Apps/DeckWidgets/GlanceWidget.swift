import AppIntents
import SwiftUI
import WidgetKit
import DeckKit

/// The home-screen and StandBy widget: what waits on you and what is running,
/// with one-tap answers to a single-choice question.
struct GlanceWidget: Widget {
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: "deck.glance", provider: GlanceProvider()) { entry in
			GlanceView(entry: entry)
				.containerBackground(.fill.tertiary, for: .widget)
				.widgetURL(entry.glance?.url)
		}
		.configurationDisplayName("deck")
		.description("Questions waiting on you, blocked runs and running sessions.")
		.supportedFamilies([.systemSmall, .systemMedium])
		.pushHandler(GlancePushHandler.self)
	}
}

struct GlancePushHandler: WidgetPushHandler {
	func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
		Task { await WidgetPush.register(pushInfo) }
	}
}

struct GlanceEntry: TimelineEntry {
	let date: Date
	let glance: DeckGlance?
	/// Say how old the counts are: on the later entry, or when deck couldn't be
	/// reached and these are the last ones read.
	var showsAge = false
	var signedIn = true
}

struct GlanceProvider: TimelineProvider {
	private static let cacheKey = "deck.glance"

	private static var cached: DeckGlance? {
		UserDefaults.standard.data(forKey: cacheKey).flatMap { try? JSONDecoder().decode(DeckGlance.self, from: $0) }
	}

	func placeholder(in context: Context) -> GlanceEntry {
		GlanceEntry(date: .now, glance: nil)
	}

	func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
		completion(GlanceEntry(date: .now, glance: Self.cached))
	}

	// deck's widget push reloads this; the policy is the fallback.
	func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
		Task {
			let now = Date.now
			guard let credentials = CredentialStore.load() else {
				completion(Timeline(entries: [GlanceEntry(date: now, glance: nil, signedIn: false)], policy: .after(now + 15 * 60)))
				return
			}
			let client = DeckClient(credentials: credentials)
			var fresh: DeckGlance?
			do {
				async let asks = client.asks()
				async let sessions = client.sessions()
				async let runs = client.runs()
				fresh = DeckGlance(MenuBarDigest(asks: try await asks, sessions: try await sessions, runs: try await runs), at: now)
			} catch {}
			if let fresh, let data = try? JSONEncoder().encode(fresh) {
				UserDefaults.standard.set(data, forKey: Self.cacheKey)
			}
			let entries = fresh.map { [GlanceEntry(date: now, glance: $0), GlanceEntry(date: now + 5 * 60, glance: $0, showsAge: true)] }
				?? [GlanceEntry(date: now, glance: Self.cached, showsAge: true)]
			completion(Timeline(entries: entries, policy: .after(now + 15 * 60)))
		}
	}
}

/// Answers the widget's question with the option tapped, as the notification's
/// option action does; a failure raises an "Answer not sent" notification.
struct AnswerAskIntent: AppIntent {
	static var title: LocalizedStringResource = "Answer deck question"
	static var isDiscoverable = false

	@Parameter(title: "Session") var sessionId: String
	@Parameter(title: "Question") var askId: String?
	@Parameter(title: "Header") var header: String
	@Parameter(title: "Answer") var label: String

	init() {}

	init(_ answer: NotificationAnswer) {
		sessionId = answer.sessionId ?? ""
		askId = answer.askId
		header = answer.header
		label = answer.label
	}

	func perform() async throws -> some IntentResult {
		let answer = NotificationAnswer(
			sessionId: sessionId, runId: nil, askId: askId, header: header, label: label, structured: true)
		await AskNotification.post(answer, client: nil, url: "/s/\(sessionId)")
		return .result()
	}
}

/// Hierarchy comes from the primary and secondary styles and symbols, not
/// colour, so StandBy's red night tint and the tinted home screen read the same.
struct GlanceView: View {
	let entry: GlanceEntry
	@Environment(\.widgetFamily) private var family
	@Environment(\.redactionReasons) private var redaction

	var body: some View {
		VStack(alignment: .leading, spacing: 6) {
			if !entry.signedIn {
				message("Open deck to sign in.")
			} else if let glance = entry.glance {
				counts(glance)
				if let first = glance.first {
					waiting(first, glance)
				} else {
					Text("All quiet").font(.title3.weight(.semibold))
					Text("\(glance.running) running").font(.caption).foregroundStyle(.secondary)
				}
				Spacer(minLength: 0)
				if entry.showsAge {
					Text("Updated \(glance.fetchedAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))")
						.font(.caption2)
						.foregroundStyle(.secondary)
						.lineLimit(1)
				}
			} else {
				message(entry.showsAge ? "Can't reach deck." : "Loading…")
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
	}

	private func counts(_ glance: DeckGlance) -> some View {
		HStack(spacing: 10) {
			count(glance.questions, "questionmark.bubble", "waiting")
			if glance.blockedRuns > 0 { count(glance.blockedRuns, "exclamationmark.octagon", "blocked") }
			count(glance.running, "play.circle", "running")
		}
		.font(.caption.weight(.semibold))
		.widgetAccentable()
	}

	private func count(_ n: Int, _ symbol: String, _ word: String) -> some View {
		Label {
			Text(family == .systemMedium ? "\(n) \(word)" : "\(n)")
		} icon: {
			Image(systemName: symbol)
		}
		.labelStyle(.titleAndIcon)
		.accessibilityLabel("\(n) \(word)")
	}

	@ViewBuilder
	private func waiting(_ first: DeckGlance.First, _ glance: DeckGlance) -> some View {
		Text(first.title).font(.headline).lineLimit(1)
		if let question = first.question {
			Text(question)
				.font(.caption)
				.foregroundStyle(.secondary)
				.lineLimit(first.options.isEmpty ? 3 : family == .systemSmall ? 1 : 2)
				.privacySensitive()
		}
		if redaction.contains(.privacy), !first.options.isEmpty {
			Text("Unlock to answer").font(.caption2).foregroundStyle(.secondary)
		} else if !first.options.isEmpty {
			let buttons = ForEach(first.options, id: \.self) { label in
				if let answer = glance.answer(label) {
					Button(intent: AnswerAskIntent(answer)) {
						Text(label).font(.caption.weight(.semibold)).lineLimit(1).frame(maxWidth: .infinity)
					}
					.buttonStyle(.bordered)
				}
			}
			if family == .systemMedium {
				HStack(spacing: 6) { buttons }
			} else {
				VStack(spacing: 4) { buttons }
			}
		}
	}

	private func message(_ text: String) -> some View {
		Text(text).font(.callout).foregroundStyle(.secondary)
	}
}
