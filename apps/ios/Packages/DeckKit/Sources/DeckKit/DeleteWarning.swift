import Foundation

/// The in-progress warning on a session delete confirm. Mirrors
/// runningSessions / runningWarning / deleteLabel in src/lib/delete-flow-core.ts.
public enum DeleteWarning {
	/// Sessions mid-turn. One only waiting on a question is not working.
	public static func running(_ sessions: [SessionDigest]) -> [SessionDigest] {
		sessions.filter { $0.status == .running && $0.awaitingInput != true }
	}

	/// The warning text, nil when nothing is working.
	public static func message(_ sessions: [SessionDigest]) -> String? {
		let running = running(sessions)
		if running.isEmpty { return nil }
		if sessions.count == 1 {
			return "This session is still working. Deleting it stops the current turn and any subagents, and the work in progress is lost."
		}
		let titles = running.map(MenuBarDigest.title(of:)).joined(separator: ", ")
		return "\(running.count) of these sessions \(running.count == 1 ? "is" : "are") still working: \(titles)."
	}

	/// The confirm button: names the stop when any session is working.
	public static func buttonLabel(_ sessions: [SessionDigest], plain: String) -> String {
		if running(sessions).isEmpty { return plain }
		return sessions.count == 1 ? "Stop and Delete" : "Stop and Delete \(sessions.count) Sessions"
	}
}
