import XCTest
@testable import DeckKit
@testable import DeckLocalModel

/// The Mac app reads the same availability messages as the phone, so they
/// have to name the system they are shown on.
final class AppPlatformTests: XCTestCase {
	func testTheOperatorNamesTheSystemItNeeds() {
		XCTAssertEqual(OperatorAvailability.systemTooOld.reason(on: .iOS), "The operator needs iOS 26 or later.")
		XCTAssertEqual(OperatorAvailability.systemTooOld.reason(on: .macOS), "The operator needs macOS 26 or later.")
	}

	func testTheMacPointsAtSystemSettings() {
		XCTAssertEqual(OperatorAvailability.notReady.reason(on: .macOS), "Turn on Apple Intelligence in System Settings, then try again.")
		XCTAssertEqual(OperatorAvailability.notReady.reason(on: .iOS), "Turn on Apple Intelligence in Settings, then try again.")
	}

	func testAvailableHasNoReasonAnywhere() {
		for platform in AppPlatform.allCases {
			XCTAssertNil(OperatorAvailability.available.reason(on: platform))
			XCTAssertNil(LocalModelStore.Support.supported.reason(on: platform))
		}
	}

	func testADownloadedModelNamesTheSystemItNeeds() {
		XCTAssertEqual(LocalModelStore.Support.systemTooOld.reason(on: .macOS), "Running your own model needs macOS 27 or later.")
		XCTAssertEqual(LocalModelStore.Support.systemTooOld.reason(on: .iOS), "Running your own model needs iOS 27 or later.")
	}

	func testTheReasonFollowsTheCurrentPlatform() {
		XCTAssertEqual(OperatorAvailability.systemTooOld.reason, OperatorAvailability.systemTooOld.reason(on: .current))
	}

	func testOnlyThePhoneHasAWakeWord() {
		XCTAssertTrue(AppPlatform.iOS.hasWakeWord)
		XCTAssertFalse(AppPlatform.macOS.hasWakeWord)
		XCTAssertFalse(AppPlatform.watchOS.hasWakeWord)
	}

	func testTheMicrophoneSettingIsWhereTheSystemKeepsIt() {
		XCTAssertTrue(AppPlatform.macOS.microphoneSetting.hasPrefix("System Settings"))
		XCTAssertEqual(AppPlatform.iOS.microphoneSetting, "Settings > deck")
	}

	// A hands-free setting saved on a device that has it must not hold the
	// Mac's mic open after a push-to-talk take.
	func testTheMicStaysOpenOnlyForHandsFreeWhereMonitoringWorks() {
		XCTAssertTrue(VoiceAudio.keepsMicOpen(handsFree: true, supportsMonitoring: true))
		XCTAssertFalse(VoiceAudio.keepsMicOpen(handsFree: true, supportsMonitoring: false))
		XCTAssertFalse(VoiceAudio.keepsMicOpen(handsFree: false, supportsMonitoring: true))
		XCTAssertFalse(VoiceAudio.keepsMicOpen(handsFree: false, supportsMonitoring: false))
	}
}
