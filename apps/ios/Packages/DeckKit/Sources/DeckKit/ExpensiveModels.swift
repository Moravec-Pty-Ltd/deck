import Foundation

/// Whether picking a model should ask first, by the server's rules: a model
/// row GET /api/agent/kinds marks `expensive`, or a model whose id or provider
/// contains (case-insensitively) an entry of `expensiveModels` from GET
/// /api/agent/defaults. The app never keeps its own list.
public enum ExpensiveModels {
	/// True when switching or starting on `model` should confirm first.
	/// Reselecting `current`, or the default (nil/empty), never asks.
	public static func needsConfirm(
		model: String?,
		provider: String? = nil,
		current: String? = nil,
		list: [String],
		rows: [KindModel] = []
	) -> Bool {
		let picked = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		guard !picked.isEmpty, picked != current else { return false }
		return isExpensive(model: picked, provider: provider, list: list, rows: rows)
	}

	public static func isExpensive(model: String, provider: String? = nil, list: [String], rows: [KindModel] = []) -> Bool {
		let provider = provider.flatMap { $0.isEmpty ? nil : $0 }
		if rows.contains(where: { $0.expensive == true && $0.model == model && (provider == nil || $0.provider == provider) }) {
			return true
		}
		let haystack = "\(model) \(provider ?? "")".lowercased()
		return list.contains { !$0.isEmpty && haystack.contains($0.lowercased()) }
	}
}
