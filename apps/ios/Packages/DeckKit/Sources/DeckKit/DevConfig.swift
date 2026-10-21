import Foundation

/// A project's dev-server config (`dev` on GET/PATCH /api/agent/projects/config),
/// field for field the server's `DevConfig` in `src/lib/types.ts`. The server
/// validates it with `parseDevConfig`; the app sends what the editor built and
/// shows a refusal as the server words it.
public struct DevConfig: Codable, Hashable, Sendable {
	/// Files copied from the main checkout into each new worktree.
	public var copyFromMain: [String]?
	/// Steps every server's bring-up runs first, in order.
	public var setup: [DevSetupStep]?
	public var servers: [DevServer]?

	public init(copyFromMain: [String]? = nil, setup: [DevSetupStep]? = nil, servers: [DevServer]? = nil) {
		self.copyFromMain = copyFromMain
		self.setup = setup
		self.servers = servers
	}

	/// The PATCH form: the encoded config as a JSON object.
	public func jsonObject() throws -> Any {
		try JSONSerialization.jsonObject(with: JSONEncoder().encode(self))
	}
}

/// One ordered setup step. `cwd` is relative to the worktree root.
public struct DevSetupStep: Codable, Hashable, Sendable {
	public var label: String
	public var run: String
	public var cwd: String?

	public init(label: String, run: String, cwd: String? = nil) {
		self.label = label
		self.run = run
		self.cwd = cwd
	}
}

public struct DevPort: Codable, Hashable, Sendable {
	public var port: Int
	public var label: String?
	/// The port the preview link opens; the first port when none is marked.
	public var primary: Bool?

	public init(port: Int, label: String? = nil, primary: Bool? = nil) {
		self.port = port
		self.label = label
		self.primary = primary
	}
}

/// A long-running dev command, started, stopped and monitored on its own.
public struct DevServer: Codable, Hashable, Sendable {
	public var name: String
	public var run: String
	public var cwd: String?
	public var setup: [DevSetupStep]?
	public var ports: [DevPort]?
	/// A regex over the pane's output that marks the server ready; its first
	/// capture group, when it has one, is the preview url.
	public var readyPattern: String?

	public init(
		name: String, run: String, cwd: String? = nil, setup: [DevSetupStep]? = nil,
		ports: [DevPort]? = nil, readyPattern: String? = nil
	) {
		self.name = name
		self.run = run
		self.cwd = cwd
		self.setup = setup
		self.ports = ports
		self.readyPattern = readyPattern
	}
}

// MARK: - Editing

/// The dev config as the editor holds it: every field a string, every row
/// identifiable so it can be reordered. `config` cleans it the way the web's
/// DevConfigForm does before saving: trimmed, blanks cleared, rows missing a
/// required field and ports outside 1...65535 left out.
public struct DevConfigDraft: Sendable {
	public var copyFromMain: [DevPathDraft]
	public var setup: [DevStepDraft]
	public var servers: [DevServerDraft]

	public init(copyFromMain: [DevPathDraft] = [], setup: [DevStepDraft] = [], servers: [DevServerDraft] = []) {
		self.copyFromMain = copyFromMain
		self.setup = setup
		self.servers = servers
	}

	public init(_ config: DevConfig?) {
		self.init(
			copyFromMain: (config?.copyFromMain ?? []).map { DevPathDraft(path: $0) },
			setup: (config?.setup ?? []).map(DevStepDraft.init),
			servers: (config?.servers ?? []).map(DevServerDraft.init))
	}

	public var config: DevConfig {
		DevConfig(
			copyFromMain: copyFromMain.compactMap { nonBlank($0.path) },
			setup: DevStepDraft.clean(setup),
			servers: servers.compactMap(\.server))
	}
}

public struct DevPathDraft: Identifiable, Hashable, Sendable {
	public let id = UUID()
	public var path: String

	public init(path: String = "") {
		self.path = path
	}
}

public struct DevStepDraft: Identifiable, Hashable, Sendable {
	public let id = UUID()
	public var label: String
	public var run: String
	public var cwd: String

	public init(label: String = "", run: String = "", cwd: String = "") {
		self.label = label
		self.run = run
		self.cwd = cwd
	}

	init(_ step: DevSetupStep) {
		self.init(label: step.label, run: step.run, cwd: step.cwd ?? "")
	}

	var step: DevSetupStep? {
		guard let label = nonBlank(label), let run = nonBlank(run) else { return nil }
		return DevSetupStep(label: label, run: run, cwd: nonBlank(cwd))
	}

	static func clean(_ steps: [DevStepDraft]) -> [DevSetupStep] {
		steps.compactMap(\.step)
	}
}

public struct DevPortDraft: Identifiable, Hashable, Sendable {
	public let id = UUID()
	public var port: String
	public var label: String
	public var primary: Bool

	public init(port: String = "3000", label: String = "", primary: Bool = false) {
		self.port = port
		self.label = label
		self.primary = primary
	}

	init(_ port: DevPort) {
		self.init(port: String(port.port), label: port.label ?? "", primary: port.primary ?? false)
	}

	/// The port number when the server would accept it.
	public var number: Int? {
		guard let n = Int(port.trimmingCharacters(in: .whitespaces)), (1...65535).contains(n) else { return nil }
		return n
	}

	var spec: DevPort? {
		number.map { DevPort(port: $0, label: nonBlank(label), primary: primary ? true : nil) }
	}
}

public struct DevServerDraft: Identifiable, Hashable, Sendable {
	public let id = UUID()
	public var name: String
	public var run: String
	public var cwd: String
	public var readyPattern: String
	public var ports: [DevPortDraft]
	public var setup: [DevStepDraft]

	public init(
		name: String = "", run: String = "", cwd: String = "", readyPattern: String = "",
		ports: [DevPortDraft] = [], setup: [DevStepDraft] = []
	) {
		self.name = name
		self.run = run
		self.cwd = cwd
		self.readyPattern = readyPattern
		self.ports = ports
		self.setup = setup
	}

	init(_ server: DevServer) {
		self.init(
			name: server.name, run: server.run, cwd: server.cwd ?? "", readyPattern: server.readyPattern ?? "",
			ports: (server.ports ?? []).map(DevPortDraft.init),
			setup: (server.setup ?? []).map(DevStepDraft.init))
	}

	/// Only one port is primary: marking one clears the rest.
	public mutating func setPrimary(_ id: DevPortDraft.ID, _ on: Bool) {
		for i in ports.indices {
			ports[i].primary = on && ports[i].id == id
		}
	}

	var server: DevServer? {
		guard let name = nonBlank(name), let run = nonBlank(run) else { return nil }
		return DevServer(
			name: name, run: run, cwd: nonBlank(cwd), setup: DevStepDraft.clean(setup),
			ports: ports.compactMap(\.spec), readyPattern: nonBlank(readyPattern))
	}
}

private func nonBlank(_ value: String) -> String? {
	let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
	return trimmed.isEmpty ? nil : trimmed
}
