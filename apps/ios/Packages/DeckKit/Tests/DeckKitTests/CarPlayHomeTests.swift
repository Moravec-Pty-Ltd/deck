import XCTest
@testable import DeckKit

final class CarPlayHomeTests: XCTestCase {
	private func session(_ id: String, kind: String = "claude", asking: Bool = false) -> SessionDigest {
		let json = #"{"id":"\#(id)","kind":"\#(kind)","status":"idle","awaitingInput":\#(asking)}"#
		return try! JSONDecoder().decode(SessionDigest.self, from: Data(json.utf8))
	}

	func testAskingSessionsLeadAndOrderIsOtherwiseKept() {
		let list = [session("a"), session("b"), session("c", asking: true), session("d")]
		let asks = [DeckAsk(sessionId: "d", questions: [AskQuestion(question: "Which?")])]
		XCTAssertEqual(CarPlayHome.sessions(list, asks: asks, limit: 10).map(\.id), ["c", "d", "a", "b"])
	}

	func testTerminalsAreLeftOutAndTheListIsCut() {
		let list = [session("a"), session("t", kind: "shell"), session("b"), session("c")]
		XCTAssertEqual(CarPlayHome.sessions(list, asks: [], limit: 2).map(\.id), ["a", "b"])
		XCTAssertEqual(CarPlayHome.sessions(list, asks: [], limit: -1).map(\.id), [])
	}

	func testVoiceStateFollowsTheController() {
		XCTAssertEqual(CarPlayHome.VoiceState.of(.idle, working: false), .ready)
		XCTAssertEqual(CarPlayHome.VoiceState.of(.idle, working: true), .thinking)
		XCTAssertEqual(CarPlayHome.VoiceState.of(.transcribing, working: false), .thinking)
		XCTAssertEqual(CarPlayHome.VoiceState.of(.listening, working: true), .listening)
		XCTAssertEqual(CarPlayHome.VoiceState.of(.speaking, working: false), .speaking)
		XCTAssertEqual(CarPlayHome.VoiceState.listening.buttonTitle, "Send")
		XCTAssertEqual(CarPlayHome.VoiceState.speaking.buttonTitle, "Talk")
	}
}
