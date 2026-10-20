import XCTest
@testable import DeckKit

final class VoiceCoreTests: XCTestCase {
	private let options = [AskOption(label: "Rewrite"), AskOption(label: "Patch it"), AskOption(label: "Leave as is")]

	func testQuestionSpeechListsNumberedOptions() {
		let question = AskQuestion(question: "How should I fix it?", options: options)
		XCTAssertEqual(
			VoiceQuestions.speech(for: question, index: 0, total: 2),
			"Question 1 of 2. How should I fix it? Options: one, Rewrite. two, Patch it. three, Leave as is.")
		XCTAssertEqual(VoiceQuestions.speech(for: AskQuestion(question: "Continue?", options: [AskOption(label: "Yes")])), "Continue? Options: one, Yes.")
	}

	func testSpokenAnswersMatchLabelsNumbersAndOrdinals() {
		XCTAssertEqual(VoiceQuestions.match("Patch it.", options: options), "Patch it")
		XCTAssertEqual(VoiceQuestions.match("two", options: options), "Patch it")
		XCTAssertEqual(VoiceQuestions.match("Option 3", options: options), "Leave as is")
		XCTAssertEqual(VoiceQuestions.match("the second one", options: options), "Patch it")
		XCTAssertEqual(VoiceQuestions.match("rewrite please", options: options), "Rewrite")
		XCTAssertEqual(VoiceQuestions.match("Let's leave as is for now", options: options), "Leave as is")
	}

	func testSpokenAnswersFallBackToFreeText() {
		XCTAssertNil(VoiceQuestions.match("Actually, do something else entirely", options: options))
		XCTAssertNil(VoiceQuestions.match("rewrite and then patch it", options: options))
		XCTAssertNil(VoiceQuestions.match("", options: options))
		XCTAssertNil(VoiceQuestions.match("two", options: []))
	}

	func testAskFlowWalksEveryQuestionIntoTheSharedDraft() {
		let ask = DeckAsk(sessionId: "s", askId: "toolu_1", questions: [
			AskQuestion(question: "How?", header: "Approach", options: options),
			AskQuestion(question: "Anything else?")
		])
		var flow = VoiceAskFlow(ask: ask)
		XCTAssertEqual(flow.prompt, "Question 1 of 2. How? Options: one, Rewrite. two, Patch it. three, Leave as is.")
		flow.answer("number two")
		XCTAssertFalse(flow.isComplete)
		XCTAssertEqual(flow.prompt, "Question 2 of 2. Anything else?")
		flow.answer(" No, ship it. ")
		XCTAssertTrue(flow.isComplete)
		XCTAssertEqual(flow.draft.answers, [
			StructuredAnswer(header: "Approach", labels: ["Patch it"]),
			StructuredAnswer(header: "Anything else?", labels: ["No, ship it."])
		])
		XCTAssertEqual(flow.draft.text, "Answering your questions:\n- Approach: Patch it\n- Anything else?: No, ship it.")
	}

	func testDetectorOpensAfterSpeechAndClosesAfterSilence() {
		var vad = VoiceDetector(threshold: 0.05, openSeconds: 0.2, closeSeconds: 1.2)
		XCTAssertNil(vad.update(level: 0.1, at: 0))
		XCTAssertNil(vad.update(level: 0.1, at: 0.1))
		XCTAssertEqual(vad.update(level: 0.1, at: 0.25), .start)
		XCTAssertNil(vad.update(level: 0.01, at: 0.3))
		XCTAssertNil(vad.update(level: 0.1, at: 0.9), "a pause shorter than closeSeconds keeps the mic open")
		XCTAssertNil(vad.update(level: 0.01, at: 1.0))
		XCTAssertNil(vad.update(level: 0.01, at: 2.1))
		XCTAssertEqual(vad.update(level: 0.01, at: 2.25), .stop)
		XCTAssertEqual(vad.state, .silent)
		XCTAssertNil(vad.update(level: 0.2, at: 3.0))
		XCTAssertNil(vad.update(level: 0.0, at: 3.05))
		XCTAssertEqual(vad.state, .silent, "a blip shorter than openSeconds is ignored")
	}

	func testWavHeaderAndTakeRules() {
		let pcm = Data([0, 0, 255, 127])
		let wav = VoiceAudio.wav(pcm16: pcm, sampleRate: 16_000)
		XCTAssertEqual(wav.count, 44 + 4)
		XCTAssertEqual(String(data: wav.prefix(4), encoding: .ascii), "RIFF")
		XCTAssertEqual(String(data: wav[8..<12], encoding: .ascii), "WAVE")
		XCTAssertEqual(wav[24..<28], Data([0x80, 0x3e, 0, 0]), "16 kHz little-endian")
		XCTAssertEqual(wav.suffix(4), pcm)
		XCTAssertTrue(VoiceAudio.isUsableTake(cancelled: false, seconds: 0.8, bytes: 10))
		XCTAssertFalse(VoiceAudio.isUsableTake(cancelled: true, seconds: 0.8, bytes: 10))
		XCTAssertFalse(VoiceAudio.isUsableTake(cancelled: false, seconds: 0.2, bytes: 10))
		XCTAssertFalse(VoiceAudio.isUsableTake(cancelled: false, seconds: 0.8, bytes: 0))
		let samples: [Float] = [0.5, -0.5]
		samples.withUnsafeBufferPointer { XCTAssertEqual(VoiceAudio.rms($0), 0.5, accuracy: 0.0001) }
	}

	func testVoiceSettingsRoundTrip() {
		let defaults = UserDefaults(suiteName: "deck-voice-tests")!
		defaults.removePersistentDomain(forName: "deck-voice-tests")
		XCTAssertEqual(VoiceSettings.load(from: defaults), VoiceSettings())
		let custom = VoiceSettings(chattiness: .finalOnly, handsFree: true, sensitivity: .high)
		custom.save(to: defaults)
		XCTAssertEqual(VoiceSettings.load(from: defaults), custom)
	}

	func testSpeechRequestsUseDecksProxies() async throws {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.protocolClasses = [SpeechStub.self]
		let client = DeckClient(credentials: Credentials(baseURL: URL(string: "https://example.test")!, token: "example-token"), configuration: configuration)
		let segments = try await client.speechSegments(text: "Hello there.")
		XCTAssertEqual(segments.map(\.id), ["abc"])
		let audio = try await client.speechAudio(id: "abc")
		XCTAssertEqual(audio, Data("RIFF".utf8))
		let transcription = try await client.transcribe(audio: Data([1, 2, 3]), mimeType: "audio/wav")
		XCTAssertEqual(transcription.text, "heard audio/wav 3")
	}
}

private final class SpeechStub: URLProtocol {
	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func startLoading() {
		let path = request.url!.path
		var body = Data()
		var type = "application/json"
		if path == "/api/agent/speech/segments" {
			body = Data(#"{"segments":[{"id":"abc","text":"Hello there."}]}"#.utf8)
		} else if path == "/api/agent/speech/audio/abc" {
			body = Data("RIFF".utf8)
			type = "audio/wav"
		} else if path == "/api/agent/speech/transcribe" {
			var uploaded = Data()
			if let stream = request.httpBodyStream {
				stream.open()
				var buffer = [UInt8](repeating: 0, count: 64)
				while stream.hasBytesAvailable {
					let n = stream.read(&buffer, maxLength: buffer.count)
					if n <= 0 { break }
					uploaded.append(contentsOf: buffer.prefix(n))
				}
			} else {
				uploaded = request.httpBody ?? Data()
			}
			body = Data("{\"text\":\"heard \(request.value(forHTTPHeaderField: "Content-Type") ?? "") \(uploaded.count)\",\"seconds\":1}".utf8)
		}
		client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": type])!, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: body)
		client?.urlProtocolDidFinishLoading(self)
	}
	override func stopLoading() {}
}
