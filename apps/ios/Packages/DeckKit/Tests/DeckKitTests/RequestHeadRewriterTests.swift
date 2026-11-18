import XCTest
@testable import DeckBrowser

final class RequestHeadRewriterTests: XCTestCase {
	private func feed(_ chunks: String...) -> [String] {
		var rewriter = RequestHeadRewriter()
		return chunks.map { String(decoding: rewriter.feed(Data($0.utf8)), as: UTF8.self) }
	}

	func testAGetReachesTheDevServerAsLocalhostAndClosesAfterward() {
		let out = feed(
			"GET /login HTTP/1.1\r\nHost: deck.localhost:3000\r\nOrigin: http://deck.localhost:3000\r\n"
				+ "Referer: http://deck.localhost:3000/login?next=/\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n"
		)
		XCTAssertEqual(out, [
			"GET /login HTTP/1.1\r\nHost: localhost:3000\r\nOrigin: http://localhost:3000\r\n"
				+ "Referer: http://localhost:3000/login?next=/\r\nAccept: */*\r\nConnection: close\r\n\r\n",
		])
	}

	func testAPostKeepsItsBodyByteForByte() {
		let out = feed(
			"POST /api/login HTTP/1.1\r\nHost: deck.localhost:5173\r\nOrigin: http://deck.localhost:5173\r\n"
				+ "Content-Length: 23\r\n\r\nemail=deck.localhost%40"
		)
		XCTAssertEqual(out, [
			"POST /api/login HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://localhost:5173\r\n"
				+ "Content-Length: 23\r\nConnection: close\r\n\r\nemail=deck.localhost%40",
		])
	}

	func testAWebSocketUpgradeKeepsItsConnectionHeader() {
		let out = feed(
			"GET /?token=x HTTP/1.1\r\nHost: deck.localhost:5173\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
				+ "Origin: http://deck.localhost:5173\r\n\r\n"
		)
		XCTAssertEqual(out, [
			"GET /?token=x HTTP/1.1\r\nHost: localhost:5173\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
				+ "Origin: http://localhost:5173\r\n\r\n",
		])
	}

	func testAHeadSplitAcrossReadsIsHeldUntilItIsWhole() {
		let out = feed("GET / HTTP/1.1\r\nHost: deck.local", "host:3000\r\n\r\n", "trailing bytes")
		XCTAssertEqual(out, ["", "GET / HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n", "trailing bytes"])
	}

	func testOnlyTheFirstHeadIsRewritten() {
		let second = "GET /b HTTP/1.1\r\nHost: deck.localhost:3000\r\n\r\n"
		XCTAssertEqual(feed("GET /a HTTP/1.1\r\nHost: deck.localhost:3000\r\n\r\n", second)[1], second)
	}

	func testNonHttpBytesPassThroughUntouched() {
		let tls = Data([0x16, 0x03, 0x01, 0x02, 0x00])
		var rewriter = RequestHeadRewriter()
		XCTAssertEqual(rewriter.feed(tls), tls)
		XCTAssertEqual(feed("SSH-2.0-OpenSSH\r\n"), ["SSH-2.0-OpenSSH\r\n"])
	}

	func testOtherHostsAndLookalikesAreLeftAlone() {
		let out = feed(
			"GET / HTTP/1.1\r\nHost: deck.localhostile:3000\r\nReferer: https://example.org/?u=http://deck.localhost\r\n\r\n"
		)
		XCTAssertEqual(out, [
			"GET / HTTP/1.1\r\nHost: deck.localhostile:3000\r\nReferer: https://example.org/?u=http://deck.localhost\r\n"
				+ "Connection: close\r\n\r\n",
		])
	}

	func testACrossOriginRequestKeepsThePagesOriginForCORS() {
		let out = feed(
			"GET /api/me HTTP/1.1\r\nHost: deck.localhost:8000\r\nOrigin: http://deck.localhost:5173\r\n"
				+ "Referer: http://deck.localhost:5173/\r\n\r\n"
		)
		XCTAssertEqual(out, [
			"GET /api/me HTTP/1.1\r\nHost: localhost:8000\r\nOrigin: http://deck.localhost:5173\r\n"
				+ "Referer: http://localhost:5173/\r\nConnection: close\r\n\r\n",
		])
	}

	func testAHeadThatNeverEndsIsEventuallyForwarded() {
		let long = "GET / HTTP/1.1\r\nX: " + String(repeating: "a", count: RequestHeadRewriter.maxHead)
		XCTAssertEqual(feed(long), [long])
	}
}
