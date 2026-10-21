// swift-tools-version:6.0
import PackageDescription

let package = Package(
	name: "DeckKit",
	platforms: [.iOS("26.0"), .watchOS(.v11), .macOS("26.0")],
	products: [
		.library(name: "DeckKit", targets: ["DeckKit"]),
		// The app's shared SwiftUI views. Only the iOS (and Mac) app links it; the
		// watch app, widgets and share extension stay on DeckKit alone.
		.library(name: "DeckUI", targets: ["DeckUI"]),
		.library(name: "DeckIntents", targets: ["DeckIntents"]),
		.library(name: "DeckBrowser", targets: ["DeckBrowser"]),
		.library(name: "DeckLocalModel", targets: ["DeckLocalModel"])
	],
	dependencies: [
		// Only DeckBrowser links these. They stay out of DeckKit so the watch app
		// and the widget and share extensions don't carry SwiftNIO for a feature
		// none of them has.
		.package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
		.package(url: "https://github.com/apple/swift-nio-ssh.git", from: "0.13.0"),
		// Only DeckLocalModel links this, for the same reason: MLX is a large
		// Metal/C++ build and nothing but the iOS app runs a model.
		.package(url: "https://github.com/ml-explore/mlx-swift-lm", from: "3.32.3"),
		// mlx-swift-lm's #huggingFaceLanguageModel macro expands to code that
		// names HubCache and the tokenizer loader, and deliberately does not
		// depend on either itself, so the consumer supplies them.
		.package(url: "https://github.com/huggingface/swift-huggingface.git", from: "0.9.0"),
		.package(url: "https://github.com/huggingface/swift-transformers", from: "1.3.0")
	],
	targets: [
		.target(name: "DeckKit"),
		.target(name: "DeckUI", dependencies: ["DeckKit"]),
		.target(name: "DeckIntents", dependencies: ["DeckKit"]),
		.target(
			name: "DeckBrowser",
			dependencies: [
				"DeckKit",
				.product(name: "NIOCore", package: "swift-nio"),
				.product(name: "NIOPosix", package: "swift-nio"),
				.product(name: "NIOConcurrencyHelpers", package: "swift-nio"),
				.product(name: "NIOSSH", package: "swift-nio-ssh")
			]
		),
		.target(
			name: "DeckLocalModel",
			dependencies: [
				"DeckKit",
				.product(name: "MLXFoundationModels", package: "mlx-swift-lm"),
				// Linked for its side effect: MLXFoundationModels deliberately does
				// not depend on MLXLLM, so without this the model factory is absent
				// and loading fails with noModelFactoryAvailable.
				.product(name: "MLXLLM", package: "mlx-swift-lm"),
				.product(name: "MLXLMCommon", package: "mlx-swift-lm"),
				.product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
				.product(name: "HuggingFace", package: "swift-huggingface"),
				.product(name: "Tokenizers", package: "swift-transformers")
			]
		),
		.testTarget(name: "DeckKitTests", dependencies: ["DeckKit", "DeckIntents", "DeckBrowser", "DeckLocalModel"])
	],
	swiftLanguageModes: [.v5]
)
