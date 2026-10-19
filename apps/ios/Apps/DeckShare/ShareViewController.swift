import SwiftUI
import UIKit
import DeckKit

/// Hosts the share UI. The extension is a separate process from the app, so it
/// has no store and no stream: it reads the credentials out of the shared
/// keychain group, asks deck for its sessions once, and posts.
final class ShareViewController: UIViewController {
	override func viewDidLoad() {
		super.viewDidLoad()
		let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
			.flatMap { $0.attachments ?? [] }
		let view = ShareView(
			providers: providers,
			onDone: { [weak self] in self?.finish() },
			onCancel: { [weak self] in self?.cancel() }
		)
		let host = UIHostingController(rootView: view)
		addChild(host)
		host.view.frame = self.view.bounds
		host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		self.view.addSubview(host.view)
		host.didMove(toParent: self)
	}

	private func finish() {
		extensionContext?.completeRequest(returningItems: nil)
	}

	private func cancel() {
		extensionContext?.cancelRequest(withError: NSError(domain: "tech.moravec.deck.share", code: 0))
	}
}
