import AppIntents
import DeckKit

func intentClient() throws -> DeckClient {
	guard let credentials = CredentialStore.load() else {
		throw DeckIntentError.notSignedIn
	}
	return DeckClient(credentials: credentials)
}

/// The model/effort/base/prompt the web new-session modal would preselect, as
/// the server resolves them. Intents run without a DeckStore, so they fetch the
/// defaults directly; a failed fetch just falls back to CLI defaults (and the
/// keyboardless fallback prompt) rather than failing the start.
func intentStartDefaults(
	client: DeckClient, kind: String, review: Bool = false, projectPath: String
) async -> StartDefaults {
	let project = try? await client.startDefaults(project: projectPath)
	return StartDefaults.resolve(kind: kind, review: review, project: project)
}

public enum DeckIntentError: Error, CustomLocalizedStringResourceConvertible {
	case notSignedIn
	case notFound
	case nothingPending

	public var localizedStringResource: LocalizedStringResource {
		switch self {
		case .notSignedIn: return "deck is not signed in. Open the app and scan the QR code first."
		case .notFound: return "I could not find that in deck."
		case .nothingPending: return "Nothing in deck is waiting on you."
		}
	}
}

// MARK: - Session

public struct SessionEntity: AppEntity, Sendable {
	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "deck Session")
	public static let defaultQuery = SessionEntityQuery()

	public let id: String
	public let title: String
	public let status: String
	public let awaitingInput: Bool

	public var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(
			title: "\(title)",
			subtitle: "\(awaitingInput ? "needs you" : status)")
	}

	init(digest: SessionDigest) {
		self.id = digest.id
		self.title = digest.title ?? digest.cwd.map { ($0 as NSString).lastPathComponent } ?? digest.id
		self.status = digest.status.rawValue
		self.awaitingInput = digest.awaitingInput ?? false
	}
}

public struct SessionEntityQuery: EntityQuery, EntityStringQuery, Sendable {
	public init() {}

	public func entities(for identifiers: [String]) async throws -> [SessionEntity] {
		let sessions = try await intentClient().sessions()
		return sessions.filter { identifiers.contains($0.id) }.map(SessionEntity.init)
	}

	public func entities(matching string: String) async throws -> [SessionEntity] {
		let sessions = try await intentClient().sessions()
		let needle = string.lowercased()
		return sessions.map(SessionEntity.init).filter { $0.title.lowercased().contains(needle) }
	}

	public func suggestedEntities() async throws -> [SessionEntity] {
		let sessions = try await intentClient().sessions()
		return sessions
			.sorted { ($0.lastActiveAt ?? 0) > ($1.lastActiveAt ?? 0) }
			.prefix(8)
			.map(SessionEntity.init)
	}
}

// MARK: - Issue

public struct IssueEntity: AppEntity, Sendable {
	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Open Issue")
	public static let defaultQuery = IssueEntityQuery()

	/// projectPath|source|issueId, so starting work needs no second lookup.
	public let id: String
	public let issueId: String
	/// The id as Shortcuts and Siri show it (`#42` for GitHub); `issueId` stays
	/// whole for the API call the intent makes.
	public let shortId: String
	public let source: String
	public let sourceId: String?
	public let title: String
	public let url: String?
	public let projectPath: String
	public let projectName: String

	public var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(title: "\(shortId)", subtitle: "\(title)")
	}

	init(issue: DeckIssue, project: DeckProject) {
		self.id = "\(project.path)|\(issue.source)|\(issue.issueId)"
		self.issueId = issue.issueId
		self.shortId = issue.shortId
		self.source = issue.source
		self.sourceId = issue.sourceId
		self.title = issue.title ?? issue.shortId
		self.url = issue.url
		self.projectPath = project.path
		self.projectName = project.name
	}

	var deckIssue: DeckIssue {
		DeckIssue(source: source, sourceId: sourceId, issueId: issueId, title: title, url: url)
	}
}

func allIssues() async throws -> [IssueEntity] {
	let client = try intentClient()
	let projects = try await client.projects()
	return try await withThrowingTaskGroup(of: [IssueEntity].self) { group in
		for project in projects {
			group.addTask {
				let response = try? await client.issues(project: project.path)
				return (response?.issues ?? []).map { IssueEntity(issue: $0, project: project) }
			}
		}
		var all: [IssueEntity] = []
		for try await batch in group { all.append(contentsOf: batch) }
		return all
	}
}

public struct IssueEntityQuery: EntityQuery, EntityStringQuery, Sendable {
	public init() {}

	public func entities(for identifiers: [String]) async throws -> [IssueEntity] {
		try await allIssues().filter { identifiers.contains($0.id) }
	}

	public func entities(matching string: String) async throws -> [IssueEntity] {
		let needle = string.lowercased()
		return try await allIssues().filter {
			$0.title.lowercased().contains(needle) || $0.issueId.lowercased().contains(needle)
		}
	}

	public func suggestedEntities() async throws -> [IssueEntity] {
		Array(try await allIssues().prefix(10))
	}
}

// MARK: - PR

public struct PREntity: AppEntity, Sendable {
	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Open Pull Request")
	public static let defaultQuery = PREntityQuery()

	/// projectPath|repo|number
	public let id: String
	public let repo: String
	public let number: Int
	public let title: String
	public let url: String?
	public let author: String?
	public let baseRefName: String?
	public let projectPath: String

	public var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(title: "\(repo) #\(String(number))", subtitle: "\(title)")
	}

	init(pr: DeckPR, project: DeckProject) {
		self.id = "\(project.path)|\(pr.repo)|\(pr.number)"
		self.repo = pr.repo
		self.number = pr.number
		self.title = pr.title ?? "#\(pr.number)"
		self.url = pr.url
		self.author = pr.author
		self.baseRefName = pr.baseRefName
		self.projectPath = project.path
	}

	var deckPR: DeckPR {
		DeckPR(repo: repo, number: number, title: title, url: url,
			headRefName: nil, baseRefName: baseRefName, isDraft: nil, author: author)
	}
}

func allPRs() async throws -> [PREntity] {
	let client = try intentClient()
	let projects = try await client.projects()
	return try await withThrowingTaskGroup(of: [PREntity].self) { group in
		for project in projects {
			group.addTask {
				let response = try? await client.prs(project: project.path)
				return (response?.prs ?? []).map { PREntity(pr: $0, project: project) }
			}
		}
		var all: [PREntity] = []
		for try await batch in group { all.append(contentsOf: batch) }
		return all
	}
}

public struct PREntityQuery: EntityQuery, EntityStringQuery, Sendable {
	public init() {}

	public func entities(for identifiers: [String]) async throws -> [PREntity] {
		try await allPRs().filter { identifiers.contains($0.id) }
	}

	public func entities(matching string: String) async throws -> [PREntity] {
		let needle = string.lowercased()
		return try await allPRs().filter {
			$0.title.lowercased().contains(needle)
				|| $0.repo.lowercased().contains(needle)
				|| String($0.number).contains(needle)
		}
	}

	public func suggestedEntities() async throws -> [PREntity] {
		Array(try await allPRs().prefix(10))
	}
}

// MARK: - Project

/// A project registered with deck, so Siri can start a session in one without
/// an issue or a PR to hang it off.
public struct ProjectEntity: AppEntity, Sendable {
	public static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "deck Project")
	public static let defaultQuery = ProjectEntityQuery()

	/// The project's path, which is what the create call wants.
	public let id: String
	public let name: String

	public var displayRepresentation: DisplayRepresentation {
		DisplayRepresentation(title: "\(name)")
	}

	init(project: DeckProject) {
		self.id = project.path
		self.name = project.name
	}
}

public struct ProjectEntityQuery: EntityQuery, EntityStringQuery, Sendable {
	public init() {}

	public func entities(for identifiers: [String]) async throws -> [ProjectEntity] {
		let projects = try await intentClient().projects()
		return projects.filter { identifiers.contains($0.path) }.map(ProjectEntity.init)
	}

	public func entities(matching string: String) async throws -> [ProjectEntity] {
		let needle = string.lowercased()
		return try await intentClient().projects()
			.map(ProjectEntity.init)
			.filter { $0.name.lowercased().contains(needle) }
	}

	public func suggestedEntities() async throws -> [ProjectEntity] {
		try await intentClient().projects().map(ProjectEntity.init)
	}
}
