import Foundation

/// A capability token deck advertises on GET /api/agent (the server's
/// agent-capabilities.ts). Only the tokens the apps gate a feature on are
/// listed; deck may advertise more, and only ever adds them.
public enum DeckCapability: String, CaseIterable, Sendable {
	case stream
	case history
	case images
	case files
	case diff
	case servers
	case speech
	case voiceOperator = "operator"
	case search
	case user
	case quickMessages = "quick-messages"
	case projectConfig = "project-config"
	case projectsWrite = "projects-write"
	case clone
	case fsComplete = "fs-complete"
	case git
	case prDismiss = "pr-dismiss"
	case expensiveModels = "expensive-models"
	case terminal
	case settings
	case pairing
	case reviews

	/// What the feature is called where a banner names what is missing.
	public var label: String {
		switch self {
		case .stream: return "live transcripts"
		case .history: return "older history"
		case .images: return "attached images"
		case .files: return "mentioned files"
		case .diff: return "changes"
		case .servers: return "dev servers"
		case .speech: return "voice mode"
		case .voiceOperator: return "the operator"
		case .search: return "transcript search"
		case .user: return "merge on your own PRs"
		case .quickMessages: return "quick messages"
		case .projectConfig: return "project settings"
		case .projectsWrite: return "adding and removing projects"
		case .clone: return "cloning a project"
		case .fsComplete: return "folder suggestions"
		case .git: return "branches and worktrees"
		case .prDismiss: return "dismissing a PR"
		case .expensiveModels: return "the expensive-model check"
		case .terminal: return "terminals"
		case .settings: return "server settings"
		case .pairing: return "approving new devices"
		case .reviews: return "PR reviews"
		}
	}
}

/// What a deck server says it supports (GET /api/agent).
public struct ServerInfo: Codable, Equatable, Sendable {
	public let version: String?
	public let capabilities: [String]

	public init(version: String?, capabilities: [String]) {
		self.version = version
		self.capabilities = capabilities
	}

	/// A deck older than GET /api/agent, which answers it 404: older than every
	/// token, so it supports none of them.
	public static let legacy = ServerInfo(version: nil, capabilities: [])

	public func supports(_ capability: DeckCapability) -> Bool {
		capabilities.contains(capability.rawValue)
	}

	/// The capabilities in `needs` this server does not advertise, in order.
	public func missing(_ needs: [DeckCapability] = DeckCapability.allCases) -> [DeckCapability] {
		needs.filter { !supports($0) }
	}
}

extension DeckClient {
	/// What the server supports. A 404 is a deck from before capabilities
	/// existed, reported as `ServerInfo.legacy` rather than an error.
	public func serverInfo() async throws -> ServerInfo {
		do {
			return try await get("/api/agent")
		} catch DeckError.http(let status, _) where status == 404 {
			return .legacy
		}
	}
}
