import Foundation
import Observation

#if canImport(MLXFoundationModels)
import FoundationModels
import HuggingFace
import MLXFoundationModels
import MLXHuggingFace
// Linked for its side effect rather than its symbols: MLXFoundationModels
// deliberately does not depend on MLXLLM, so without this import the model
// factory is never registered and loading fails with noModelFactoryAvailable.
import MLXLLM
import MLXLMCommon
import Tokenizers
#endif

/// A model downloaded onto this device for the operator to think with
/// (deck#239), and the one place that knows which one is chosen.
///
/// deck's operator ran on Apple's own on-device model, whose context is 4,096
/// tokens: every tool result had to be cut to 2,000 characters, no catalogue
/// could go in the instructions, and it refused instructions about its own
/// output. A downloaded model has tens of thousands of tokens and does what it
/// is told, which is the whole reason this exists.
///
/// MLX does the work: `mlx-swift-lm` bridges a downloaded model to Apple's own
/// `FoundationModels.LanguageModel`, so deck's seven operator tools and the
/// conversation around them are unchanged. Only which model answers differs.
@MainActor
@Observable
public final class LocalModelStore {
	public static let shared = LocalModelStore()

	/// Where a chosen model stands. Not the same question as whether the device
	/// could run one, which is `support`.
	public enum State: Equatable, Sendable {
		/// Chosen but not on the device yet.
		case notDownloaded
		case downloading(fraction: Double)
		case ready
		/// The download or the load failed, with what to tell the user.
		case failed(String)
	}

	/// Whether this device can run a downloaded model at all.
	public enum Support: Equatable, Sendable {
		case supported
		/// Third-party models plug into FoundationModels only from iOS 27.
		case systemTooOld
		/// No MLX here, which is every platform but iOS, macOS and visionOS.
		case platformUnsupported

		public var reason: String? {
			switch self {
			case .supported: nil
			case .systemTooOld: "Running your own model needs iOS 27 or later."
			case .platformUnsupported: "This device cannot run a downloaded model."
			}
		}
	}

	private static let chosenKey = "deck.localModel.chosenId"

	private let defaults: UserDefaults

	/// The Hugging Face repo of the model the operator should use. Empty means
	/// nothing chosen, which is how a fresh install stays on Apple's model
	/// until someone asks for something else.
	public private(set) var chosenId: String

	public private(set) var state: State = .notDownloaded

	/// Built on demand per chosen id and kept, so the operator reuses one model
	/// rather than reloading weights per turn. Type-erased because
	/// `MLXLanguageModel` is newer than this package's floor.
	private var built: Any?
	private var builtFor: String?

	public init(defaults: UserDefaults = .standard) {
		self.defaults = defaults
		self.chosenId = defaults.string(forKey: Self.chosenKey) ?? ""
	}

	public static var support: Support {
		#if canImport(MLXFoundationModels)
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *) { return .supported }
		return .systemTooOld
		#else
		return .platformUnsupported
		#endif
	}

	/// Whether the operator should think with a downloaded model right now: one
	/// is chosen, this device can run it, and it is on disk.
	public var isActive: Bool {
		!chosenId.isEmpty && Self.support == .supported && state == .ready
	}

	/// The model to hand the operator, or nil to leave it on Apple's own.
	///
	/// Type-erased on purpose: DeckKit holds the operator and must not link
	/// MLX, so it takes this as `Any` and casts it behind an availability
	/// check. See OperatorBrain.useModel.
	public var operatorModel: Any? {
		isActive ? built : nil
	}

	/// Choose a model, or pass an empty string to go back to Apple's own. The
	/// choice is remembered; downloading is a separate, explicit step.
	public func choose(_ id: String) {
		let next = LocalModelCatalogue.normalise(id)
		guard next != chosenId else { return }
		chosenId = next
		defaults.set(next, forKey: Self.chosenKey)
		// The old model's weights stay on disk: switching back should not mean
		// downloading again. Only the loaded copy goes.
		built = nil
		builtFor = nil
		state = .notDownloaded
		if !next.isEmpty { Task { await refresh() } }
	}

	/// Ask whether the chosen model is already on the device, without
	/// downloading anything. Called when the screen opens and after a choice.
	public func refresh() async {
		guard !chosenId.isEmpty, Self.support == .supported else {
			state = .notDownloaded
			return
		}
		#if canImport(MLXFoundationModels)
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *) {
			await readAvailability()
		}
		#endif
	}

	/// Fetch the weights, reporting progress. Loading them is part of this: a
	/// model that downloads but cannot load is not ready, and finding that out
	/// now beats finding out mid-sentence on the first question.
	public func download() async {
		guard !chosenId.isEmpty else { return }
		guard Self.support == .supported else {
			state = .failed(Self.support.reason ?? "This device cannot run a downloaded model.")
			return
		}
		#if canImport(MLXFoundationModels)
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *) {
			await fetch()
		}
		#endif
	}

	/// How much disk the chosen model's weights take, or nil when none are
	/// there. Read from the cache rather than from the catalogue, so a
	/// hand-typed model reports its real size too.
	public var downloadedBytes: Int64? {
		#if canImport(MLXFoundationModels)
		guard let directory = Self.repoDirectory(for: chosenId) else { return nil }
		return Self.directoryBytes(directory)
		#else
		return nil
		#endif
	}

	/// Forget the weights. The operator falls back to Apple's model until
	/// something is downloaded again.
	public func delete() async {
		await unload()
		#if canImport(MLXFoundationModels)
		if let directory = Self.repoDirectory(for: chosenId) {
			try? FileManager.default.removeItem(at: directory)
		}
		#endif
		state = .notDownloaded
	}

	/// Drop the loaded copy from memory, keeping the weights on disk. Worth
	/// doing when the operator is switched off: a model resident costs most of
	/// what it costs to run.
	public func unload() async {
		#if canImport(MLXFoundationModels)
		if #available(iOS 27.0, macOS 27.0, visionOS 27.0, *) {
			await (built as? MLXLanguageModel)?.evict()
		}
		#endif
		built = nil
		builtFor = nil
	}
}

#if canImport(MLXFoundationModels)
extension LocalModelStore {
	/// Where the hub keeps one repo. The same directory the downloader fills,
	/// so deleting it is what "not downloaded" means.
	fileprivate static func repoDirectory(for id: String) -> URL? {
		guard !id.isEmpty, let repo = Repo.ID(rawValue: id) else { return nil }
		return HubCache.default.repoDirectory(repo: repo, kind: .model)
	}

	/// Bytes under a directory, or nil if it is not there. Walked rather than
	/// asked for, because the hub splits a repo into blobs and snapshots that
	/// link to them and no single file is the model.
	fileprivate static func directoryBytes(_ directory: URL) -> Int64? {
		let manager = FileManager.default
		guard manager.fileExists(atPath: directory.path) else { return nil }
		guard let walk = manager.enumerator(
			at: directory,
			includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
			options: [.skipsHiddenFiles])
		else { return nil }
		var total: Int64 = 0
		for case let url as URL in walk {
			let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
			// Only real files: a snapshot entry is a link to a blob already
			// counted, and counting both would double the figure.
			guard values?.isRegularFile == true, let size = values?.fileSize else { continue }
			total += Int64(size)
		}
		return total
	}
}

@available(iOS 27.0, macOS 27.0, visionOS 27.0, *)
extension LocalModelStore {
	/// The capabilities deck needs declared. The adapter does not infer them
	/// from the model id and refuses a request that exceeds what was declared,
	/// so all three are named here:
	///
	/// - `toolCalling` is the operator. Without it there is no point.
	/// - `reasoning` because Qwen's tool turns need thinking left on; with it
	///   off the model narrates what it would do instead of calling anything.
	/// - `guidedGeneration` is the adapter's own default, kept so a future
	///   `@Generable` reply does not need another capability added here.
	private static var capabilities: [LanguageModelCapabilities.Capability] {
		[.toolCalling, .reasoning, .guidedGeneration]
	}

	fileprivate func model() -> MLXLanguageModel? {
		if builtFor == chosenId, let existing = built as? MLXLanguageModel { return existing }
		guard !chosenId.isEmpty else { return nil }
		let fresh = #huggingFaceLanguageModel(
			configuration: ModelConfiguration(id: chosenId),
			capabilities: Self.capabilities)
		built = fresh
		builtFor = chosenId
		return fresh
	}

	fileprivate func readAvailability() async {
		guard let model = model() else { return }
		switch await model.availability {
		case .available: state = .ready
		case .downloading: state = .downloading(fraction: 0)
		case .unavailable(let reason): state = Self.unavailable(reason)
		}
	}

	private static func unavailable(_ reason: MLXLanguageModel.Availability.UnavailableReason) -> State {
		switch reason {
		case .modelNotDownloaded: .notDownloaded
		case .deviceNotCapable: .failed("This device does not have the memory to run that model. Try a smaller one.")
		case .downloadFailed: .failed("The download did not finish. Check the connection and try again.")
		@unknown default: .failed("That model is not available.")
		}
	}

	fileprivate func fetch() async {
		guard let model = model() else { return }
		state = .downloading(fraction: 0)
		// Progress is reported by the adapter's shared observable, keyed by
		// model id, so watch that while the preload runs rather than wiring a
		// second progress path.
		let watcher = Task { @MainActor [weak self] in
			while !Task.isCancelled {
				if let fraction = MLXDownloadProgress.shared.activeDownloads
					.first(where: { $0.modelID == model.modelID })?.fractionCompleted {
					self?.state = .downloading(fraction: fraction)
				}
				try? await Task.sleep(for: .milliseconds(400))
			}
		}
		defer { watcher.cancel() }
		do {
			try await model.preload()
			state = .ready
		} catch {
			built = nil
			builtFor = nil
			state = .failed(Self.readable(error))
		}
	}

	/// MLX reports a missing or wrong-format repo as a decode or network
	/// failure, which reads as a bug rather than a typo. Name the two mistakes
	/// someone typing a repo id actually makes.
	private static func readable(_ error: Error) -> String {
		let raw = error.localizedDescription
		if raw.localizedCaseInsensitiveContains("404") || raw.localizedCaseInsensitiveContains("not found") {
			return "No such model on Hugging Face. Check the owner and name."
		}
		if raw.localizedCaseInsensitiveContains("gguf") || raw.localizedCaseInsensitiveContains("safetensors") {
			return "Those weights are not in MLX format. Look for an mlx-community version of the model."
		}
		return raw
	}
}
#endif
