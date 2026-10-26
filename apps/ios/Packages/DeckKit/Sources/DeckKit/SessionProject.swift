import Foundation

/// Which registered project a session belongs to. Mirrors deck's `deriveGroup`
/// in `src/lib/time.ts`: a session working in a worktree belongs to the repo it
/// branched from, and where projects nest the longest path wins.
///
/// deck already decides what is hidden and says so on the digest, so this is
/// only for the question the digest cannot answer: *which* project hides a
/// session, so the list knows to offer "unhide the project" rather than a
/// per-session unhide that would not bring it back.
public enum SessionProject {
	/// The marker deck puts between a repo and the worktrees it owns.
	private static let worktreeMarker = "-worktrees/"

	/// The project a session works in, or nil when it works somewhere deck does
	/// not have registered (an adhoc terminal, most often).
	public static func owning(_ session: SessionDigest, in projects: [DeckProject]) -> DeckProject? {
		// A worktree session names its repo outright, so there is nothing to
		// derive; fall through to the path rules when it doesn't.
		if let repo = session.worktree?.repo, let match = projects.first(where: { $0.path == repo }) {
			return match
		}
		guard let cwd = session.cwd, !cwd.isEmpty else { return nil }
		let base = cwd.range(of: worktreeMarker).map { String(cwd[cwd.startIndex..<$0.lowerBound]) } ?? cwd
		// Longest wins, so a project registered inside another claims its own
		// sessions rather than the outer one taking them.
		return projects
			.filter { contains($0.path, base) || contains($0.path, cwd) }
			.max { $0.path.count < $1.path.count }
	}

	/// The project Start preselects: the open session's own project, hidden or
	/// not, else what is already picked, else the first project not hidden.
	public static func startDefault(
		openSession: SessionDigest?, current: DeckProject?, in projects: [DeckProject]
	) -> DeckProject? {
		openSession.flatMap { owning($0, in: projects) }
			?? current
			?? projects.first { $0.hidden != true } ?? projects.first
	}

	/// Whether the session is hidden *because of* its project, in which case
	/// unhiding the session on its own would leave it hidden.
	public static func hides(_ session: SessionDigest, in projects: [DeckProject]) -> Bool {
		owning(session, in: projects)?.hidden == true
	}

	/// The directory itself, or anything under it. Compared with the separator
	/// so "/p/acme" does not claim "/p/acme-other".
	private static func contains(_ project: String, _ path: String) -> Bool {
		path == project || path.hasPrefix(project + "/")
	}
}
