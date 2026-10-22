import XCTest
@testable import DeckKit
import DeckUI

final class SessionPRTests: XCTestCase {
	private func pr(_ fields: String) throws -> SessionPR {
		try JSONDecoder().decode(SessionPR.self, from: Data("{ \"repo\": \"acme/app\", \"number\": 42 \(fields) }".utf8))
	}

	private func session(branch: String?, pr: String?) throws -> SessionDigest {
		let worktree = branch.map { #", "worktree": { "branch": "\#($0)" }"# } ?? ""
		let pr = pr.map { #", "pr": { "number": \#($0) }"# } ?? ""
		return try JSONDecoder().decode(SessionDigest.self, from: Data(#"{ "id": "c_1", "status": "idle"\#(worktree)\#(pr) }"#.utf8))
	}

	func testMergeNeedsAnOpenMergeablePROfYourOwn() throws {
		let ready = try pr(#", "state": "open", "mergeable": "MERGEABLE", "author": "me""#)
		XCTAssertTrue(ready.canMerge(as: "me"))
		XCTAssertTrue(ready.canMerge(as: nil), "an unknown login allows, as the server does")
		XCTAssertFalse(ready.canMerge(as: "someone"), "never someone else's PR")
		XCTAssertFalse(try pr(#", "state": "open", "mergeable": "CONFLICTING""#).canMerge(as: "me"))
		XCTAssertFalse(try pr(#", "state": "open", "mergeable": "UNKNOWN""#).canMerge(as: "me"))
		XCTAssertFalse(try pr(#", "state": "draft", "mergeable": "MERGEABLE""#).canMerge(as: "me"))
		XCTAssertFalse(try pr(#", "state": "merged", "mergeable": "MERGEABLE""#).canMerge(as: "me"))
	}

	func testAReviewSessionIsParkedOnThePRsRef() throws {
		XCTAssertTrue(try session(branch: "pr/7", pr: "7").isReviewSession)
		XCTAssertFalse(try session(branch: "fix-login", pr: "7").isReviewSession, "a work session on its own branch")
		XCTAssertFalse(try session(branch: "pr/8", pr: "7").isReviewSession, "another PR's ref")
		XCTAssertFalse(try session(branch: "pr/7", pr: nil).isReviewSession)
		XCTAssertFalse(try session(branch: nil, pr: "7").isReviewSession)
	}

	func testReadinessSaysWhyItCannotMerge() throws {
		func label(_ fields: String) throws -> String? { PRDisplay.readiness(for: try pr(fields))?.label }
		XCTAssertEqual(try label(#", "state": "open", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN""#), "Ready")
		XCTAssertEqual(try label(#", "state": "open", "mergeable": "MERGEABLE", "mergeStateStatus": "BLOCKED""#), "Blocked")
		XCTAssertEqual(try label(#", "state": "open", "mergeable": "CONFLICTING""#), "Conflicts")
		XCTAssertEqual(try label(#", "state": "draft", "mergeable": "MERGEABLE""#), "Draft")
		XCTAssertEqual(try label(#", "state": "merged""#), "Merged")
		XCTAssertNil(try label(#", "state": "open", "mergeable": "UNKNOWN""#))
	}
}
