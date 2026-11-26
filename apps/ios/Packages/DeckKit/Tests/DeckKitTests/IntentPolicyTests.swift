import AppIntents
import XCTest
@testable import DeckIntents

final class IntentPolicyTests: XCTestCase {
	func testIntentsThatChangeSomethingNeedTheDeviceUnlocked() {
		let changing: [any AppIntent.Type] = [
			StartWorkIntent.self, StartSessionIntent.self, StartReviewIntent.self,
			AnswerIntent.self, SendPromptIntent.self, StopSessionIntent.self
		]
		for intent in changing { XCTAssertEqual(intent.authenticationPolicy, .requiresAuthentication, "\(intent)") }
		let reading: [any AppIntent.Type] = [CheckAttentionIntent.self, ListSessionsIntent.self, SessionStatusIntent.self]
		for intent in reading { XCTAssertNotEqual(intent.authenticationPolicy, .requiresAuthentication, "\(intent)") }
	}
}
