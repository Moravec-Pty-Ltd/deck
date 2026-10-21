import SwiftUI
import AVFoundation

/// Minimal QR scanner: AVCaptureSession + AVCaptureMetadataOutput wrapped for
/// SwiftUI. Reports the first decoded QR string once, then stays idle until
/// the view is torn down and recreated.
struct QRScannerView: UIViewControllerRepresentable {
	var onCode: (String) -> Void

	func makeUIViewController(context: Context) -> QRScannerViewController {
		let controller = QRScannerViewController()
		controller.onCode = onCode
		return controller
	}

	func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
	var onCode: ((String) -> Void)?

	private let session = AVCaptureSession()
	private var previewLayer: AVCaptureVideoPreviewLayer?
	private var hasScanned = false

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .black
		configureSession()
	}

	override func viewWillAppear(_ animated: Bool) {
		super.viewWillAppear(animated)
		hasScanned = false
		let session = session
		if !session.isRunning {
			Task.detached(priority: .userInitiated) { session.startRunning() }
		}
	}

	override func viewWillDisappear(_ animated: Bool) {
		super.viewWillDisappear(animated)
		let session = session
		if session.isRunning {
			Task.detached(priority: .userInitiated) { session.stopRunning() }
		}
	}

	override func viewDidLayoutSubviews() {
		super.viewDidLayoutSubviews()
		previewLayer?.frame = view.bounds
	}

	private func configureSession() {
		guard let device = AVCaptureDevice.default(for: .video),
			let input = try? AVCaptureDeviceInput(device: device),
			session.canAddInput(input) else { return }
		session.addInput(input)

		let output = AVCaptureMetadataOutput()
		guard session.canAddOutput(output) else { return }
		session.addOutput(output)
		output.setMetadataObjectsDelegate(self, queue: .main)
		output.metadataObjectTypes = [.qr]

		let preview = AVCaptureVideoPreviewLayer(session: session)
		preview.frame = view.bounds
		preview.videoGravity = .resizeAspectFill
		view.layer.addSublayer(preview)
		previewLayer = preview
	}

	func metadataOutput(
		_ output: AVCaptureMetadataOutput,
		didOutput metadataObjects: [AVMetadataObject],
		from connection: AVCaptureConnection
	) {
		guard !hasScanned,
			let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
			object.type == .qr,
			let value = object.stringValue else { return }
		hasScanned = true
		onCode?(value)
	}
}
