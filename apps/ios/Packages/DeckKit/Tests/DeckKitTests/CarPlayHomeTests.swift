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

	func testTapToTalkStates() {
		let of = { CarPlayHome.VoiceState.of($0, recording: $1, working: $2, handsFree: false) }
		XCTAssertEqual(of(.idle, false, false), .ready)
		XCTAssertEqual(of(.idle, false, true), .thinking)
		XCTAssertEqual(of(.listening, true, true), .hearing)
		XCTAssertEqual(of(.transcribing, false, false), .thinking)
		XCTAssertEqual(of(.speaking, false, false), .speaking)
		XCTAssertEqual(CarPlayHome.VoiceState.states(handsFree: false), [.ready, .hearing, .thinking, .speaking])
		XCTAssertEqual(CarPlayHome.VoiceState.hearing.buttonTitle(handsFree: false), "Send")
		XCTAssertEqual(CarPlayHome.VoiceState.speaking.tap(handsFree: false), .talk)
		XCTAssertEqual(CarPlayHome.VoiceState.ready.tap(handsFree: false), .talk)
		XCTAssertEqual(CarPlayHome.VoiceState.hearing.tap(handsFree: false), .send)
		XCTAssertEqual(CarPlayHome.VoiceState.ready.title, "Tap Talk to speak")
	}

	func testHandsFreeStates() {
		let of = { CarPlayHome.VoiceState.of($0, recording: $1, working: $2, handsFree: true) }
		XCTAssertEqual(of(.listening, false, false), .listening)
		XCTAssertEqual(of(.listening, false, true), .thinking)
		XCTAssertEqual(of(.listening, true, true), .hearing)
		XCTAssertEqual(of(.speaking, false, true), .speaking)
		XCTAssertEqual(of(.transcribing, false, false), .thinking)
		XCTAssertEqual(of(.idle, false, true), .paused)
		let states = CarPlayHome.VoiceState.states(handsFree: true)
		XCTAssertLessThanOrEqual(states.count, 5)
		XCTAssertEqual(states.map(\.title), ["Listening", "Listening", "Working on it", "Speaking", "Paused, tap to resume"])
		XCTAssertEqual(states.map { $0.tap(handsFree: true) }, [.pause, .send, .pause, .pause, .resume])
		XCTAssertFalse(states.contains { $0.title.contains("Send") })
	}
}
