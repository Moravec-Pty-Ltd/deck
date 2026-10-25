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

	func testDetectorReportsQuietAndOpensAfreshAfterAResetMidClose() {
		var vad = VoiceDetector(threshold: 0.05, openSeconds: 0.2, closeSeconds: 2)
		_ = vad.update(level: 0.2, at: 0)
		XCTAssertEqual(vad.update(level: 0.2, at: 0.25), .start)
		XCTAssertNil(vad.update(level: 0.01, at: 1))
		XCTAssertEqual(vad.silentSince, 1)
		_ = vad.update(level: 0.01, at: 2)
		vad.reset()
		XCTAssertNil(vad.update(level: 0.2, at: 2.2))
		XCTAssertNil(vad.silentSince)
		XCTAssertEqual(vad.update(level: 0.2, at: 2.45), .start, "a take ended early on settled words leaves room for the next")
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

	func testDefaultEndOfSpeechWaitsOutAShortPause() {
		func run(pause: TimeInterval) -> VoiceDetector.Edge? {
			var vad = VoiceDetector(threshold: 0.05)
			var edge: VoiceDetector.Edge?
			for t in stride(from: 0.0, through: 0.3, by: 0.05) { _ = vad.update(level: 0.1, at: t) }
			for t in stride(from: 0.35, through: 0.3 + pause, by: 0.05) where edge == nil { edge = vad.update(level: 0.01, at: t) }
			return edge
		}
		XCTAssertNil(run(pause: 1.5))
		XCTAssertEqual(run(pause: 3), .stop)
		var vad = VoiceDetector(threshold: 0.05)
		vad.closeSeconds = EndOfSpeech.long.closeSeconds
		_ = vad.update(level: 0.1, at: 0)
		XCTAssertEqual(vad.update(level: 0.1, at: 0.25), .start)
		_ = vad.update(level: 0.01, at: 0.3)
		XCTAssertNil(vad.update(level: 0.01, at: 2.5), "a long setting waits past the default")
		XCTAssertEqual(vad.update(level: 0.01, at: 3.3), .stop)
	}

	func testAFinishedSentenceClosesSooner() {
		XCTAssertTrue(VoiceEndpoint.looksFinished("Open the pull request."))
		XCTAssertFalse(VoiceEndpoint.looksFinished("Open the pull request"))
		XCTAssertFalse(VoiceEndpoint.looksFinished("Open the pull request and."), "a trailing conjunction")
		XCTAssertFalse(VoiceEndpoint.looksFinished("and..."))
		XCTAssertFalse(VoiceEndpoint.looksFinished("Run the tests…"))
		XCTAssertTrue(VoiceEndpoint.looksFinished("Is it done?"))
		XCTAssertTrue(VoiceEndpoint.looksFinished("Stop!"))
		XCTAssertTrue(VoiceEndpoint.looksFinished("He said \"go.\""))
		XCTAssertFalse(VoiceEndpoint.looksFinished(""))
		XCTAssertTrue(VoiceEndpoint.settled(transcript: "Open it.", heardSilence: 1))
		XCTAssertFalse(VoiceEndpoint.settled(transcript: "Open it.", heardSilence: 0.6), "a word may still be on its way")
		XCTAssertFalse(VoiceEndpoint.settled(transcript: "Open it and", heardSilence: 3))
	}

	func testBargeInNeedsALongerHoldWithoutARecogniser() {
		var vad = VoiceDetector(threshold: 0.05)
		func cuts(_ level: Float, at t: TimeInterval) -> Bool {
			_ = vad.update(level: level, at: t)
			return BargeIn.interrupts(vad, now: t, wordsAt: nil)
		}
		XCTAssertFalse(cuts(0.1, at: 10))
		XCTAssertFalse(cuts(0.1, at: 10 + VoiceTiming.openSeconds), "the take-opening hold alone doesn't stop a reply")
		XCTAssertTrue(cuts(0.1, at: 10 + BargeIn.holdSeconds + 0.01))
		vad.reset()
		XCTAssertFalse(cuts(0.2, at: 20))
		XCTAssertFalse(cuts(0.0, at: 20.05))
		XCTAssertFalse(cuts(0.0, at: 20.25), "a cough, then a pause")
		XCTAssertFalse(cuts(0.2, at: 20.3))
		XCTAssertFalse(cuts(0.2, at: 20.3 + BargeIn.holdSeconds - 0.01), "the hold restarts after the pause")
		vad.reset()
		XCTAssertFalse(cuts(0.2, at: 25))
		XCTAssertFalse(cuts(0.0, at: 25.2))
		XCTAssertFalse(cuts(0.2, at: 25.3))
		XCTAssertTrue(cuts(0.2, at: 25 + BargeIn.holdSeconds + 0.01), "a gap between words keeps the hold")
		vad.reset()
		XCTAssertFalse(cuts(0.2, at: 40))
		XCTAssertFalse(cuts(0.0, at: 40.1))
		XCTAssertFalse(cuts(0.2, at: 40.4), "a long gap with no readings in it still ends the run")
		vad.reset()
		XCTAssertFalse(cuts(0.2, at: 30))
		XCTAssertFalse(cuts(0.2, at: 30.25), "a cough long enough to open the detector")
		XCTAssertFalse(cuts(0.0, at: 30.5), "has ended by the hold")
	}

	func testBargeInWithARecogniserTakesNewWordsWhileSpeechIsOpen() {
		var vad = VoiceDetector(threshold: 0.05)
		_ = vad.update(level: 0.1, at: 10)
		XCTAssertFalse(BargeIn.interrupts(vad, now: 10.1, wordsAt: 10.1), "words before the detector opens")
		_ = vad.update(level: 0.1, at: 10.25)
		XCTAssertFalse(BargeIn.interrupts(vad, now: 10.3, wordsAt: nil), "loud but no words yet")
		_ = vad.update(level: 0.0, at: 10.4)
		XCTAssertTrue(BargeIn.interrupts(vad, now: 10.9, wordsAt: 10.9), "a short \"stop\", reported after it ended")
		XCTAssertFalse(BargeIn.interrupts(vad, now: 10.9, wordsAt: 9.5), "words from earlier")
		vad.reset()
		_ = vad.update(level: 0.1, at: 20)
		_ = vad.update(level: 0.1, at: 20.46)
		XCTAssertTrue(BargeIn.interrupts(vad, now: 20.46, wordsAt: nil), "a silent recogniser leaves the loudness hold")
		XCTAssertTrue(BargeIn.addsWords("stop", to: ""))
		XCTAssertTrue(BargeIn.addsWords("hey there stop", to: "hey there"))
		XCTAssertFalse(BargeIn.addsWords("hey their", to: "hey there"), "a revision adds nothing")
		XCTAssertFalse(BargeIn.addsWords("", to: "hey there"), "a restarted recogniser")
	}

	func testPreRollKeepsTheNewestBytesOldestFirst() {
		var ring = PcmRing(capacity: 4)
		XCTAssertEqual(ring.data, Data())
		ring.append(Data([1, 2]))
		XCTAssertEqual(ring.data, Data([1, 2]))
		ring.append(Data([3, 4, 5]))
		XCTAssertEqual(ring.data, Data([2, 3, 4, 5]))
		ring.append(Data([6, 7, 8, 9, 10, 11]))
		XCTAssertEqual(ring.data, Data([8, 9, 10, 11]))
		ring.removeAll()
		XCTAssertEqual(ring.data, Data())
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
		XCTAssertTrue(VoiceSettings().handsFree, "hands-free is the default")
		XCTAssertEqual(VoiceSettings().endOfSpeech, .normal)
		let custom = VoiceSettings(chattiness: .finalOnly, handsFree: false, sensitivity: .high, endOfSpeech: .long)
		custom.save(to: defaults)
		XCTAssertEqual(VoiceSettings.load(from: defaults), custom)
		// Saved before hands-free had a key: the rest survives, hands-free defaults on.
		defaults.set(Data(#"{"chattiness":"final-only","sensitivity":"low"}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertEqual(VoiceSettings.load(from: defaults), VoiceSettings(chattiness: .finalOnly, handsFree: true, sensitivity: .low))
		// An unversioned false predates the new default and is not a choice.
		defaults.set(Data(#"{"chattiness":"final-only","handsFree":false,"sensitivity":"low"}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertTrue(VoiceSettings.load(from: defaults).handsFree)
		// A false saved at the current version is.
		defaults.set(Data(#"{"version":2,"handsFree":false}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertFalse(VoiceSettings.load(from: defaults).handsFree)
		defaults.set(Data(#"{"version":2}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertTrue(VoiceSettings.load(from: defaults).handsFree)
		defaults.set(Data(#"{"version":2,"endOfSpeech":"short","sensitivity":"high"}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertEqual(VoiceSettings.load(from: defaults).endOfSpeech, .short)
		defaults.set(Data(#"{"version":2,"endOfSpeech":"forever","sensitivity":"high"}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertEqual(VoiceSettings.load(from: defaults).endOfSpeech, .normal)
		XCTAssertEqual(VoiceSettings.load(from: defaults).sensitivity, .high)
		XCTAssertTrue(VoiceSettings.load(from: defaults).workingCue, "the working cue is on unless turned off")
		VoiceSettings(workingCue: false).save(to: defaults)
		XCTAssertFalse(VoiceSettings.load(from: defaults).workingCue)
		XCTAssertTrue(VoiceSettings.load(from: defaults).handsFreeInCar, "the car is hands-free unless turned off")
		var tapInCar = VoiceSettings()
		tapInCar.handsFreeInCar = false
		tapInCar.save(to: defaults)
		XCTAssertFalse(VoiceSettings.load(from: defaults).handsFreeInCar)
		XCTAssertTrue(VoiceSettings.load(from: defaults).handsFree, "the phone's hands-free is its own setting")
		XCTAssertTrue(VoiceSettings.load(from: defaults).announceTools, "announcements are on unless turned off")
		VoiceSettings(announceTools: false).save(to: defaults)
		XCTAssertFalse(VoiceSettings.load(from: defaults).announceTools)
	}

	func testReadOutDefaultsToSummaryAndSticks() throws {
		let defaults = try XCTUnwrap(UserDefaults(suiteName: "readout-\(UUID().uuidString)"))
		XCTAssertEqual(VoiceSettings().readOut, .summary)
		defaults.set(Data(#"{"version":2,"readOut":"aloud"}"#.utf8), forKey: "deck.voice.settings")
		XCTAssertEqual(VoiceSettings.load(from: defaults).readOut, .summary, "an unknown value takes the default")
		VoiceSettings(readOut: .brief).save(to: defaults)
		XCTAssertEqual(VoiceSettings.load(from: defaults).readOut, .brief)
	}

	func testWorkingCueTicksOnlyWhileTheAgentWorksUnheard() {
		XCTAssertTrue(VoiceCue.workingPlays(wanted: true, working: true, asking: false, busy: false))
		XCTAssertFalse(VoiceCue.workingPlays(wanted: false, working: true, asking: false, busy: false), "turned off")
		XCTAssertFalse(VoiceCue.workingPlays(wanted: true, working: false, asking: false, busy: false), "turn over")
		XCTAssertFalse(VoiceCue.workingPlays(wanted: true, working: true, asking: true, busy: false), "a question waits")
		XCTAssertFalse(VoiceCue.workingPlays(wanted: true, working: true, asking: false, busy: true), "reading or recording")
		XCTAssertTrue(VoiceCue.donePlays(willRead: false, replied: false))
		XCTAssertFalse(VoiceCue.donePlays(willRead: true, replied: false))
		XCTAssertFalse(VoiceCue.donePlays(willRead: false, replied: true))
	}

	func testListeningCuePlaysWhenHandsFreeListeningResumes() {
		XCTAssertTrue(VoiceCue.listeningPlays(wasListening: false, listening: true, reading: false, recording: false))
		XCTAssertFalse(VoiceCue.listeningPlays(wasListening: true, listening: true, reading: false, recording: false), "already listening")
		XCTAssertFalse(VoiceCue.listeningPlays(wasListening: false, listening: false, reading: false, recording: false), "hold-to-talk rests idle")
		XCTAssertFalse(VoiceCue.listeningPlays(wasListening: false, listening: true, reading: true, recording: false), "more to read")
		XCTAssertFalse(VoiceCue.listeningPlays(wasListening: false, listening: true, reading: false, recording: true), "a take is open")
	}

	func testListeningCueRisesWhereTheDoneCueFalls() {
		func crossings(_ s: [Float], from at: Int) -> Int {
			(at + 1..<at + 400).filter { (s[$0 - 1] < 0) != (s[$0] < 0) }.count
		}
		let listening = VoiceCue.listening.samples()
		let done = VoiceCue.done.samples()
		XCTAssertGreaterThan(crossings(listening, from: listening.count - 500), crossings(listening, from: 100))
		XCTAssertLessThan(crossings(done, from: done.count - 500), crossings(done, from: 100))
	}

	private func say(_ name: String, _ input: [String: JSONValue]) -> String? {
		ToolAnnouncement.phrase([ToolAnnouncement.action(name: name, input: .object(input))])
	}

	func testToolCallsArePhrasedForSpeech() {
		XCTAssertEqual(say("Read", ["file_path": .string("/path/to/project/apps/ios/SessionDetailView.swift")]), "Reading SessionDetailView")
		XCTAssertEqual(say("Edit", ["file_path": .string("src/lib/voice-core.ts")]), "Editing voice-core")
		XCTAssertEqual(say("Write", ["file_path": .string("Makefile")]), "Writing Makefile")
		XCTAssertEqual(say("Bash", ["command": .string("pnpm test --run")]), "Running pnpm test")
		XCTAssertEqual(say("Bash", ["command": .string("cd ~/code/deck && FOO=1 git status --short")]), "Running git status")
		XCTAssertEqual(say("Bash", ["command": .string("sed -n 1,20p file.ts")]), "Running sed")
		XCTAssertEqual(say("Bash", ["command": .string("ls src/lib")]), "Running ls")
		XCTAssertEqual(say("Grep", ["pattern": .string("PasteButton")]), "Searching for PasteButton")
		XCTAssertEqual(say("Grep", ["pattern": .string("paste|Paste.*Handler")]), "Searching for paste Paste Handler")
		XCTAssertEqual(say("Grep", ["pattern": .string("\\(")]), "Searching the code")
		XCTAssertEqual(say("Glob", ["pattern": .string("**/*.svelte")]), "Finding files")
		XCTAssertEqual(say("WebFetch", ["url": .string("https://www.example.com/docs")]), "Fetching example.com")
		XCTAssertEqual(say("WebSearch", ["query": .string("svelte 5 runes effect cleanup order")]), "Searching the web for svelte 5 runes effect")
		XCTAssertEqual(say("Task", ["subagent_type": .string("review"), "description": .string("Review the diff")]), "Starting a subagent: review")
		XCTAssertEqual(say("Agent", ["description": .string("Find paste handling")]), "Starting a subagent: Find paste handling")
		XCTAssertEqual(say("TodoWrite", ["todos": .array([])]), "Updating the to-do list")
		XCTAssertEqual(say("mcp__deck__send_message", [:]), "Using send message")
		XCTAssertEqual(say("ToolSearch", [:]), "Using tool search")
		XCTAssertEqual(say("mcp__plugin_docs_docs__query_docs", [:]), "Using query docs")
		XCTAssertEqual(say("Bash", ["command": .string("./run.sh --fast")]), "Running run")
		XCTAssertEqual(say("Bash", ["command": .string("cd apps/web")]), "Running a command")
		XCTAssertEqual(say("WebSearch", [:]), "Searching the web")
	}

	func testToolCallsOfOneKindMerge() {
		let read = { (f: String) in ToolAnnouncement.action(name: "Read", input: .object(["file_path": .string(f)])) }
		let bash = ToolAnnouncement.action(name: "Bash", input: .object(["command": .string("pnpm test")]))
		XCTAssertNil(ToolAnnouncement.phrase([]))
		XCTAssertEqual(ToolAnnouncement.phrase([read("a.ts"), read("b.ts"), read("c.ts")]), "Reading three files")
		XCTAssertEqual(ToolAnnouncement.phrase([bash, read("a.ts"), read("b.ts")]), "Reading two files")
		XCTAssertEqual(ToolAnnouncement.phrase([read("a.ts"), read("b.ts"), bash]), "Running pnpm test")
		let grep = ToolAnnouncement.action(name: "Grep", input: .object(["pattern": .string("a")]))
		let glob = ToolAnnouncement.action(name: "Glob", input: .object(["pattern": .string("*")]))
		XCTAssertEqual(ToolAnnouncement.phrase([grep, glob]), "Running two searches")
		let search = ToolAnnouncement.action(name: "WebSearch", input: .object(["query": .string("a")]))
		let fetch = ToolAnnouncement.action(name: "WebFetch", input: .object(["url": .string("https://example.com")]))
		XCTAssertEqual(ToolAnnouncement.phrase([search, fetch]), "Fetching example.com")
		XCTAssertEqual(ToolAnnouncement.phrase((0..<12).map { read("\($0).ts") }), "Reading 12 files")
	}

	func testAnnouncementsPlayOnlyIntoSilenceAndAtMostEveryInterval() {
		let gap = ToolAnnouncement.interval
		XCTAssertTrue(ToolAnnouncement.plays(wanted: true, working: true, asking: false, busy: false, sinceLast: gap))
		XCTAssertFalse(ToolAnnouncement.plays(wanted: true, working: true, asking: false, busy: false, sinceLast: gap - 0.1), "too soon")
		XCTAssertFalse(ToolAnnouncement.plays(wanted: false, working: true, asking: false, busy: false, sinceLast: gap), "turned off")
		XCTAssertFalse(ToolAnnouncement.plays(wanted: true, working: false, asking: false, busy: false, sinceLast: gap), "turn over")
		XCTAssertFalse(ToolAnnouncement.plays(wanted: true, working: true, asking: true, busy: false, sinceLast: gap), "a question waits")
		XCTAssertFalse(ToolAnnouncement.plays(wanted: true, working: true, asking: false, busy: true, sinceLast: gap), "something else is heard")
	}

	func testAStaleAnnouncementIsDropped() {
		let head = Utterance(toolUseId: "t1")
		XCTAssertFalse(ToolAnnouncement.stale(head, latest: "t1", queueCount: 1))
		XCTAssertTrue(ToolAnnouncement.stale(head, latest: "t2", queueCount: 1), "a newer call started")
		XCTAssertTrue(ToolAnnouncement.stale(head, latest: nil, queueCount: 1), "the turn ended")
		XCTAssertTrue(ToolAnnouncement.stale(head, latest: "t1", queueCount: 2), "a reply waits behind it")
		XCTAssertFalse(ToolAnnouncement.stale(Utterance(), latest: "t2", queueCount: 2), "only announcements go stale")
	}

	func testSkipDropsTheHeadAndAToneWaitingBehindIt() {
		let a = SpeechSegment(id: "a", text: "")
		var queue = [Utterance(segments: [a]), Utterance(cue: .done), Utterance(segments: [a])]
		Utterance.skip(&queue)
		XCTAssertEqual(queue.count, 1)
		XCTAssertNil(queue[0].cue)
		queue = [Utterance(segments: [a]), Utterance(cue: .done, pending: Task { [] })]
		Utterance.skip(&queue)
		XCTAssertEqual(queue.count, 1, "a question still being fetched keeps its place")
		queue = [Utterance(cue: .done)]
		Utterance.skip(&queue)
		XCTAssertTrue(queue.isEmpty)
	}

	func testCuesAreTooShortToOpenATake() {
		for cue in VoiceCue.allCases {
			let samples = cue.samples()
			XCTAssertFalse(samples.isEmpty)
			XCTAssertLessThan(Double(samples.count) / 16_000, VoiceTiming.openSeconds)
			XCTAssertLessThanOrEqual(samples.map(abs).max() ?? 0, 0.25)
			XCTAssertLessThan(abs(samples[0]), 0.01, "fades in")
			XCTAssertEqual(cue.wav.count, 44 + samples.count * 2)
		}
		XCTAssertTrue(VoiceCue.acknowledgements.allSatisfy { $0.count <= 20 }, "acknowledgements stay short")
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
