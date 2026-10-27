import SwiftUI
import UIKit

/// The system camera, for a photo to attach to a message. Calls back with
/// the photo, or nil when cancelled; the caller dismisses it.
struct CameraPicker: UIViewControllerRepresentable {
	var onDone: (UIImage?) -> Void

	static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

	func makeUIViewController(context: Context) -> UIImagePickerController {
		let picker = UIImagePickerController()
		picker.sourceType = .camera
		picker.delegate = context.coordinator
		return picker
	}

	func updateUIViewController(_ picker: UIImagePickerController, context: Context) {
		context.coordinator.onDone = onDone
	}

	func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

	final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
		var onDone: (UIImage?) -> Void

		init(onDone: @escaping (UIImage?) -> Void) { self.onDone = onDone }

		func imagePickerController(
			_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
		) {
			onDone(info[.originalImage] as? UIImage)
		}

		func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone(nil) }
	}
}
