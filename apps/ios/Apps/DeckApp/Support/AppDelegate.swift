import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate {
	func application(
		_ application: UIApplication,
		didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
	) -> Bool {
		// Set before app start so a launch-by-notification-tap is still caught.
		UNUserNotificationCenter.current().delegate = PushManager.shared
		return true
	}

	/// Phones stay portrait. An iPad turns freely, and so does a foldable's
	/// open display: it is two phones wide, and turning it puts the fold across
	/// the screen for the tabletop layout.
	func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
		if UIDevice.current.userInterfaceIdiom == .pad { return .all }
		guard let bounds = window?.windowScene?.screen.bounds, min(bounds.width, bounds.height) >= 600 else {
			return .portrait
		}
		return .all
	}

	func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
		Task { @MainActor in
			PushManager.shared.didRegister(deviceToken: deviceToken)
		}
	}

	func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
		#if DEBUG
		print("deck: APNs registration failed: \(error)")
		#endif
	}
}
