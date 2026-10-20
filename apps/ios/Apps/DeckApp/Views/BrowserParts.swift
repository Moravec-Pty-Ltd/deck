import DeckBrowser
import SwiftUI
import WebKit

// The dev browser's pieces that are the same on the phone and the Mac. The
// Mac target compiles this file by path.

@MainActor
enum BrowserStatus {
	static func colour(_ model: BrowserModel) -> Color {
		if model.isDirect { return .green }
		if case .failed = model.tunnelState { return .red }
		return model.isConnected ? .green : .secondary
	}
}

struct TabChip: View {
	let tab: BrowserTab
	let isSelected: Bool
	let select: () -> Void
	let close: () -> Void

	var body: some View {
		HStack(spacing: 5) {
			if tab.isDerived {
				Circle()
					.fill(tab.listening ? Color.green : Color.gray.opacity(0.4))
					.frame(width: 6, height: 6)
			}
			Text(tab.title).font(.caption.monospaced()).lineLimit(1)
			if isSelected {
				Button(action: close) {
					Image(systemName: "xmark").font(.caption2)
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Close \(tab.title)")
			}
		}
		.padding(.horizontal, 10)
		.padding(.vertical, 6)
		.background(isSelected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
		.clipShape(Capsule())
		.onTapGesture(perform: select)
	}
}

#if os(macOS)
typealias PlatformView = NSView
typealias PlatformViewRepresentable = NSViewRepresentable
#else
typealias PlatformView = UIView
typealias PlatformViewRepresentable = UIViewRepresentable
#endif

/// Hosts a WKWebView, swapping it when the tab changes or the proxy forces a
/// rebuild. The container stays put so SwiftUI keeps one view to lay out.
struct WebViewHost: PlatformViewRepresentable {
	let webView: WKWebView

	#if os(macOS)
	func makeNSView(context: Context) -> NSView { NSView() }
	func updateNSView(_ container: NSView, context: Context) { attach(to: container) }
	#else
	func makeUIView(context: Context) -> UIView { UIView() }
	func updateUIView(_ container: UIView, context: Context) { attach(to: container) }
	#endif

	private func attach(to container: PlatformView) {
		guard webView.superview !== container else { return }
		container.subviews.forEach { $0.removeFromSuperview() }
		webView.translatesAutoresizingMaskIntoConstraints = false
		container.addSubview(webView)
		NSLayoutConstraint.activate([
			webView.topAnchor.constraint(equalTo: container.topAnchor),
			webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
			webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
			webView.trailingAnchor.constraint(equalTo: container.trailingAnchor)
		])
	}
}
