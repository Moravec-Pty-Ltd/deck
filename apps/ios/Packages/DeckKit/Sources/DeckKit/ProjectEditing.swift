import Foundation

/// The fields the app's project editor changes. `changes(from:)` is the PATCH
/// body: only what differs, since the server keeps every field a body omits.
public struct ProjectDraft: Equatable, Sendable {
	public var name: String
	public var group: String
	public var template: String
	public var reviewPrompt: String
	/// A Claude account name; empty is the built-in Default.
	public var account: String

	public init(name: String = "", group: String = "", template: String = "", reviewPrompt: String = "", account: String = "") {
		self.account = account
		self.name = name
		self.group = group
		self.template = template
		self.reviewPrompt = reviewPrompt
	}

	/// The stored record when there is one, else what the projects list knows.
	public init(project: DeckProject, detail: ProjectDetail?) {
		self.init(
			name: detail?.name ?? project.name,
			group: detail?.group ?? project.group ?? "",
			template: detail?.template ?? "",
			reviewPrompt: detail?.reviewPrompt ?? "",
			account: detail?.account ?? "")
	}

	/// The changed fields, trimmed the way the server stores them. A blank
	/// group, prompt or account clears it; a blank name is left out, because the server
	/// would keep the old one anyway.
	public func changes(from original: ProjectDraft) -> [String: String] {
		var body: [String: String] = [:]
		let pairs: [(String, String, String)] = [
			("group", group, original.group),
			("template", template, original.template),
			("reviewPrompt", reviewPrompt, original.reviewPrompt),
			("account", account, original.account)
		]
		for (key, value, old) in pairs where trim(value) != trim(old) {
			body[key] = trim(value)
		}
		if !trim(name).isEmpty, trim(name) != trim(original.name) { body["name"] = trim(name) }
		return body
	}

	private func trim(_ value: String) -> String {
		value.trimmingCharacters(in: .whitespacesAndNewlines)
	}
}

/// Clone urls, mirroring deck's `src/lib/repo-url.ts`. The server re-derives
/// all of it; the app uses these for the destination preview and the name it
/// fills in.
public enum RepoURL {
	/// The folder `git clone` would create: the last `/`- or `:`-separated
	/// segment without a trailing slash or `.git`. Nil for an empty url or a
	/// `.`/`..` tail.
	public static func name(from url: String) -> String? {
		var trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
		while trimmed.hasSuffix("/") { trimmed.removeLast() }
		if trimmed.lowercased().hasSuffix(".git") { trimmed.removeLast(4) }
		let tail = trimmed.split(separator: "/", omittingEmptySubsequences: false).last?
			.split(separator: ":", omittingEmptySubsequences: false).last.map(String.init) ?? ""
		return tail.isEmpty || tail == "." || tail == ".." ? nil : tail
	}

	/// Whether deck would hand this url to `git clone`: https, ssh and git
	/// schemes, or scp-style `host:owner/repo`, with a host that can't be read
	/// as an ssh option.
	public static func isSafe(_ url: String) -> Bool {
		let u = url.trimmingCharacters(in: .whitespacesAndNewlines)
		if u.isEmpty || u.hasPrefix("-") || u.contains(where: { $0.isWhitespace || $0 == "\\" }) { return false }
		// A Windows drive (C:repo) reads like scp-style but is a local path.
		if u.range(of: "^[A-Za-z]:", options: .regularExpression) != nil { return false }
		if let range = u.range(of: "^(https|ssh|git)://", options: [.regularExpression, .caseInsensitive]) {
			let authority = u[range.upperBound...].prefix { $0 != "/" }
			return isSafeHost(String(authority))
		}
		return isSafeScp(u)
	}

	/// Where a clone of `url` into `parent` lands, or nil until both are usable.
	public static func destination(parent: String, url: String) -> String? {
		var base = parent.trimmingCharacters(in: .whitespacesAndNewlines)
		while base.hasSuffix("/") { base.removeLast() }
		guard !base.isEmpty, isSafe(url), let name = name(from: url) else { return nil }
		return "\(base)/\(name)"
	}

	private static func isSafeScp(_ u: String) -> Bool {
		guard let range = u.range(of: "^[^/:]+:[^/:]", options: .regularExpression) else { return false }
		let host = u[range].prefix { $0 != ":" }
		return isSafeHost(String(host))
	}

	private static func isSafeHost(_ authority: String) -> Bool {
		let host = authority.split(separator: "@", omittingEmptySubsequences: false).last ?? ""
		return !host.isEmpty && !host.hasPrefix("-")
	}
}

/// How the path field asks for folder suggestions.
public enum PathCompletion {
	/// After a suggestion is picked, list what is inside it.
	public static func drillIn(_ path: String) -> String {
		path.hasSuffix("/") ? path : path + "/"
	}

	/// The suggestions worth showing: not the folder already typed.
	public static func visible(_ suggestions: [String], typed: String) -> [String] {
		let current = typed.hasSuffix("/") ? String(typed.dropLast()) : typed
		return suggestions.filter { $0 != current }
	}
}
