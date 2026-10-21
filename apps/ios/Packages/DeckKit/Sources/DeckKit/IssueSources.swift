import Foundation
import Observation

/// Where a project's issues come from. Mirrors the web's IssueSources.svelte;
/// the server keeps Linear and ClickUp keys in its OS keyring and never sends
/// one back, so the app only ever holds a key it is about to send.
public enum IssueSourceType: String, CaseIterable, Identifiable, Sendable {
	case github, linear, clickup

	public var id: String { rawValue }

	public var label: String {
		switch self {
		case .github: return "GitHub"
		case .linear: return "Linear"
		case .clickup: return "ClickUp"
		}
	}
}

/// A provider id that is a string from one API and a number from another.
private struct LenientID: Decodable {
	let value: String

	init(from decoder: Decoder) throws {
		let container = try decoder.singleValueContainer()
		if let int = try? container.decode(Int.self) {
			value = String(int)
		} else {
			value = try container.decode(String.self)
		}
	}
}

/// One stored source, as GET /api/agent/projects/config lists it.
public struct IssueSource: Decodable, Identifiable, Hashable, Sendable {
	public let id: String
	public let type: String
	public let owner: String?
	public let repo: String?
	public let teamName: String?
	public let stateIds: [String]?
	public let listName: String?
	public let statuses: [String]?

	public init(
		id: String, type: String, owner: String? = nil, repo: String? = nil, teamName: String? = nil,
		stateIds: [String]? = nil, listName: String? = nil, statuses: [String]? = nil
	) {
		self.id = id
		self.type = type
		self.owner = owner
		self.repo = repo
		self.teamName = teamName
		self.stateIds = stateIds
		self.listName = listName
		self.statuses = statuses
	}

	public var kind: IssueSourceType? { IssueSourceType(rawValue: type) }

	/// What the web's source row says.
	public var summary: String {
		switch kind {
		case .github: return "\(owner ?? "")/\(repo ?? "")"
		case .linear: return "\(teamName ?? "") · \(stateIds?.count ?? 0) state(s)"
		case .clickup: return "\(listName ?? "") · \(statuses?.count ?? 0) status(es)"
		case nil: return type
		}
	}
}

/// A saved key, by label only (GET /api/agent/credentials).
public struct SavedCredential: Decodable, Identifiable, Hashable, Sendable {
	public let id: String
	public let type: String
	public let label: String
	public let projects: [String]

	public init(id: String, type: String, label: String, projects: [String] = []) {
		self.id = id
		self.type = type
		self.label = label
		self.projects = projects
	}

	public var displayLabel: String {
		projects.isEmpty ? label : "\(label), used by \(projects.joined(separator: ", "))"
	}
}

public struct LinearTeam: Decodable, Identifiable, Hashable, Sendable {
	public let id: String
	public let name: String
	public let key: String
}

public struct LinearState: Decodable, Identifiable, Hashable, Sendable {
	public let id: String
	public let name: String
	public let type: String
}

/// A ClickUp workspace, space, folder or list.
public struct ClickupItem: Decodable, Identifiable, Hashable, Sendable {
	public let id: String
	public let name: String

	private enum CodingKeys: String, CodingKey { case id, name }

	public init(from decoder: Decoder) throws {
		let container = try decoder.container(keyedBy: CodingKeys.self)
		id = try container.decode(LenientID.self, forKey: .id).value
		name = try container.decode(String.self, forKey: .name)
	}
}

public struct ClickupStatus: Decodable, Hashable, Sendable {
	public let status: String
	public let type: String
}

struct LinearMe: Decodable {
	let name: String
	let email: String
}

struct ClickupMe: Decodable {
	let id: Int
	let username: String
}

private struct ProjectSourcesRecord: Decodable {
	let sources: [IssueSource]?
}

/// Which key a Linear or ClickUp request authenticates with: one the server
/// already holds, named by id, or one just typed. Never both.
public enum IssueSourceKey: Equatable, Sendable, CustomStringConvertible {
	case saved(String)
	case new(String)

	var field: [String: Any] {
		switch self {
		case .saved(let id): return ["credentialId": id]
		case .new(let key): return ["apiKey": key]
		}
	}

	public var description: String {
		switch self {
		case .saved(let id): return "saved(\(id))"
		case .new: return "new(<redacted>)"
		}
	}
}

/// The POST /api/agent/projects/sources bodies, by type, as the web sends them.
public enum IssueSourceBody {
	public static func github(owner: String, repo: String) -> [String: Any] {
		["type": "github", "owner": owner.trimmingCharacters(in: .whitespaces), "repo": repo.trimmingCharacters(in: .whitespaces)]
	}

	public static func linear(
		key: IssueSourceKey, teamId: String, teamName: String, assigneeEmail: String, stateIds: [String]
	) -> [String: Any] {
		key.field.merging([
			"type": "linear", "teamId": teamId, "teamName": teamName,
			"assigneeEmail": assigneeEmail, "stateIds": stateIds
		]) { $1 }
	}

	public struct ClickupPlace: Sendable {
		public var teamId = "", teamName = ""
		public var spaceId = "", spaceName = ""
		public var folderId = "", folderName = ""
		public var listId = "", listName = ""
		public init() {}
	}

	public static func clickup(
		key: IssueSourceKey, place: ClickupPlace, statuses: [String], assigneeUserId: Int, assigneeName: String
	) -> [String: Any] {
		var body = key.field.merging([
			"type": "clickup", "assigneeName": assigneeName, "assigneeUserId": assigneeUserId,
			"teamId": place.teamId, "teamName": place.teamName,
			"spaceId": place.spaceId, "spaceName": place.spaceName,
			"listId": place.listId, "listName": place.listName, "statuses": statuses
		]) { $1 }
		if !place.folderId.isEmpty {
			body["folderId"] = place.folderId
			body["folderName"] = place.folderName
		}
		return body
	}
}

extension DeckClient {
	/// A project's sources, read from its stored record.
	public func issueSources(projectPath: String) async throws -> [IssueSource] {
		let record: ProjectSourcesRecord = try await get(
			"/api/agent/projects/config", query: [URLQueryItem(name: "path", value: projectPath)])
		return record.sources ?? []
	}

	/// The keys already saved for a provider, labels only.
	public func issueCredentials(type: IssueSourceType) async throws -> [SavedCredential] {
		try await get("/api/agent/credentials", query: [URLQueryItem(name: "type", value: type.rawValue)])
	}

	/// One step of the setup cascade. A provider failure is a 400 whose
	/// message the server has already cut the key out of.
	public func issueSourceLookup<T: Decodable>(
		type: IssueSourceType, action: String, key: IssueSourceKey, params: [String: String] = [:]
	) async throws -> T {
		var body: [String: Any] = key.field
		body["type"] = type.rawValue
		body["action"] = action
		for (name, value) in params { body[name] = value }
		return try await post("/api/agent/projects/sources/lookup", json: body)
	}

	@discardableResult
	public func addIssueSource(projectPath: String, body: [String: Any]) async throws -> IssueSource {
		var body = body
		body["projectPath"] = projectPath
		return try await post("/api/agent/projects/sources", json: body)
	}

	public func removeIssueSource(projectPath: String, id: String) async throws {
		_ = try await requestData("DELETE", "/api/agent/projects/sources", query: [
			URLQueryItem(name: "project", value: projectPath),
			URLQueryItem(name: "id", value: id)
		])
	}
}

/// Adding one source: the key step, then the provider's cascade (me and teams,
/// then states for Linear; me and workspaces, spaces, folders, lists, statuses
/// for ClickUp), exactly as the web walks it. A typed key lives only in this
/// object, in memory, and is cleared once the source is saved.
@MainActor
@Observable
public final class IssueSourceSetup: Identifiable {
	public let type: IssueSourceType
	public private(set) var credentials: [SavedCredential] = []
	/// "" is "enter a new key".
	public var credentialId = ""
	public var apiKey = ""
	public private(set) var connected = false
	public private(set) var meLabel = ""
	public private(set) var busy = false
	public private(set) var errorMessage: String?

	public var githubOwner = ""
	public var githubRepo = ""

	public private(set) var linearTeams: [LinearTeam] = []
	public private(set) var linearTeamId = ""
	public private(set) var linearStates: [LinearState] = []
	public var linearStateIds: [String] = []
	private var linearEmail = ""

	public private(set) var clickupTeams: [ClickupItem] = []
	public private(set) var clickupSpaces: [ClickupItem] = []
	public private(set) var clickupFolders: [ClickupItem] = []
	public private(set) var clickupLists: [ClickupItem] = []
	public private(set) var clickupStatuses: [ClickupStatus] = []
	public private(set) var place = IssueSourceBody.ClickupPlace()
	public var clickupSelected: [String] = []
	private var clickupUserId = 0
	private var clickupUserName = ""

	private let client: DeckClient

	public init(client: DeckClient, type: IssueSourceType) {
		self.client = client
		self.type = type
	}

	public var key: IssueSourceKey { credentialId.isEmpty ? .new(apiKey) : .saved(credentialId) }
	public var hasKey: Bool { !credentialId.isEmpty || !apiKey.trimmingCharacters(in: .whitespaces).isEmpty }

	public var canSave: Bool {
		guard !busy else { return false }
		switch type {
		case .github:
			return !githubOwner.trimmingCharacters(in: .whitespaces).isEmpty
				&& !githubRepo.trimmingCharacters(in: .whitespaces).isEmpty
		case .linear: return connected && !linearTeamId.isEmpty && !linearStateIds.isEmpty
		case .clickup: return connected && !place.listId.isEmpty && !clickupSelected.isEmpty
		}
	}

	/// Offer the keys already saved for this provider, the first picked. A
	/// failed fetch just means typing a key.
	public func start() async {
		guard type != .github else { return }
		credentials = (try? await client.issueCredentials(type: type)) ?? []
		credentialId = credentials.first?.id ?? ""
	}

	public func connect() async {
		await run {
			if self.type == .linear {
				let me: LinearMe = try await Self.lookup(self.client, self.type, self.key, "me")
				self.meLabel = "\(me.name) <\(me.email)>"
				self.linearEmail = me.email
				self.linearTeams = try await Self.lookup(self.client, self.type, self.key, "teams")
			} else {
				let me: ClickupMe = try await Self.lookup(self.client, self.type, self.key, "me")
				self.meLabel = me.username
				self.clickupUserId = me.id
				self.clickupUserName = me.username
				self.clickupTeams = try await Self.lookup(self.client, self.type, self.key, "teams")
			}
			self.connected = true
		}
	}

	public func selectLinearTeam(_ id: String) async {
		linearTeamId = id
		linearStates = []
		linearStateIds = []
		guard !id.isEmpty else { return }
		await run {
			self.linearStates = try await Self.lookup(self.client, self.type, self.key, "states", ["teamId": id])
			// Default to the "to do / up next" buckets.
			self.linearStateIds = self.linearStates.filter { $0.type == "unstarted" }.map(\.id)
		}
	}

	public func selectClickupTeam(_ id: String) async {
		place.teamId = id
		place.teamName = clickupTeams.first { $0.id == id }?.name ?? ""
		clickupSpaces = []
		clearSpace()
		guard !id.isEmpty else { return }
		await run { self.clickupSpaces = try await Self.lookup(self.client, self.type, self.key, "spaces", ["teamId": id]) }
	}

	public func selectClickupSpace(_ id: String) async {
		clearSpace()
		place.spaceId = id
		place.spaceName = clickupSpaces.first { $0.id == id }?.name ?? ""
		guard !id.isEmpty else { return }
		await run {
			self.clickupFolders = try await Self.lookup(self.client, self.type, self.key, "folders", ["spaceId": id])
			try await self.loadLists()
		}
	}

	/// "" is the space's folderless lists.
	public func selectClickupFolder(_ id: String) async {
		place.folderId = id
		place.folderName = clickupFolders.first { $0.id == id }?.name ?? ""
		await run { try await self.loadLists() }
	}

	public func selectClickupList(_ id: String) async {
		place.listId = id
		place.listName = clickupLists.first { $0.id == id }?.name ?? ""
		clickupStatuses = []
		clickupSelected = []
		guard !id.isEmpty else { return }
		await run {
			self.clickupStatuses = try await Self.lookup(self.client, self.type, self.key, "statuses", ["listId": id])
			self.clickupSelected = self.clickupStatuses
				.filter { ["to do", "up next"].contains($0.status.lowercased()) }
				.map(\.status)
		}
	}

	public static func toggled(_ list: [String], _ value: String) -> [String] {
		list.contains(value) ? list.filter { $0 != value } : list + [value]
	}

	/// Save the source; true once stored, at which point the typed key is
	/// dropped: the server has it now.
	public func save(projectPath: String) async -> Bool {
		var saved = false
		await run {
			try await self.client.addIssueSource(projectPath: projectPath, body: self.body)
			saved = true
		}
		if saved { apiKey = "" }
		return saved
	}

	/// Forget the typed key, as when the form is closed.
	public func discard() {
		apiKey = ""
	}

	var body: [String: Any] {
		switch type {
		case .github:
			return IssueSourceBody.github(owner: githubOwner, repo: githubRepo)
		case .linear:
			let teamName = linearTeams.first { $0.id == linearTeamId }?.name ?? ""
			return IssueSourceBody.linear(
				key: key, teamId: linearTeamId, teamName: teamName, assigneeEmail: linearEmail, stateIds: linearStateIds)
		case .clickup:
			return IssueSourceBody.clickup(
				key: key, place: place, statuses: clickupSelected,
				assigneeUserId: clickupUserId, assigneeName: clickupUserName)
		}
	}

	private func clearSpace() {
		place.spaceId = ""
		place.spaceName = ""
		place.folderId = ""
		place.folderName = ""
		place.listId = ""
		place.listName = ""
		clickupFolders = []
		clickupLists = []
		clickupStatuses = []
		clickupSelected = []
	}

	private func loadLists() async throws {
		let params = place.folderId.isEmpty ? ["spaceId": place.spaceId] : ["folderId": place.folderId]
		clickupLists = try await Self.lookup(client, type, key, "lists", params)
		place.listId = ""
		place.listName = ""
		clickupStatuses = []
		clickupSelected = []
	}

	// Nonisolated so the generic decode does not carry the main actor along.
	private nonisolated static func lookup<T: Decodable>(
		_ client: DeckClient, _ type: IssueSourceType, _ key: IssueSourceKey, _ action: String, _ params: [String: String] = [:]
	) async throws -> T {
		try await client.issueSourceLookup(type: type, action: action, key: key, params: params)
	}

	private func run(_ work: @escaping @MainActor () async throws -> Void) async {
		busy = true
		errorMessage = nil
		do {
			try await work()
		} catch {
			errorMessage = DeckError.message(for: error)
		}
		busy = false
	}
}
