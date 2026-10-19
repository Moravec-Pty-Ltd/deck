import XCTest
@testable import DeckBrowser

final class LoopbackHostTests: XCTestCase {
	func testLoopbackBecomesTheSentinelSoWebKitWillProxyIt() {
		let url = LoopbackHost.resolve("localhost:5173", tunnelled: true)
		XCTAssertEqual(url?.absoluteString, "http://deck.localhost:5173")
	}

	func testEveryLoopbackSpellingIsRewritten() {
		for host in ["localhost", "127.0.0.1", "[::1]"] {
			let url = LoopbackHost.resolve("http://\(host):3000/api", tunnelled: true)
			XCTAssertEqual(url?.absoluteString, "http://deck.localhost:3000/api", host)
		}
	}

	func testLoopbackIsLeftAloneWhenTheTunnelIsDown() {
		let url = LoopbackHost.resolve("localhost:5173", tunnelled: false)
		XCTAssertEqual(url?.absoluteString, "http://localhost:5173")
	}

	func testARealHostIsNeverRewritten() {
		let url = LoopbackHost.resolve("example.org/docs", tunnelled: true)
		XCTAssertEqual(url?.absoluteString, "https://example.org/docs")
	}

	func testLoopbackDefaultsToHttpAndEverythingElseToHttps() {
		XCTAssertEqual(LoopbackHost.resolve("127.0.0.1:8080", tunnelled: false)?.scheme, "http")
		XCTAssertEqual(LoopbackHost.resolve("example.org", tunnelled: false)?.scheme, "https")
	}

	func testABareIPv6LiteralIsNotMistakenForAHostnameWithAPort() {
		// Splitting on the first colon would read "[" as the host and default to
		// https, which a dev server would refuse.
		let url = LoopbackHost.resolve("[::1]:3000", tunnelled: true)
		XCTAssertEqual(url?.absoluteString, "http://deck.localhost:3000")
	}

	func testAnExplicitSchemeWins() {
		XCTAssertEqual(LoopbackHost.resolve("http://example.org", tunnelled: false)?.scheme, "http")
	}

	func testTypingTheSentinelBackInStillLoads() {
		// display() puts "localhost" in the address bar, but the sentinel can
		// still arrive by hand or from a copied URL.
		let url = LoopbackHost.resolve("deck.localhost:5173", tunnelled: true)
		XCTAssertEqual(url?.absoluteString, "http://deck.localhost:5173")
	}

	func testEmptyTextIsNotAURL() {
		XCTAssertNil(LoopbackHost.resolve("   ", tunnelled: true))
	}

	func testTheForwardTargetIsLocalhostNotAnIPv4Literal() {
		// The far side has to resolve it, so a dev server bound to ::1 only is
		// still reachable. 127.0.0.1 would be refused there.
		XCTAssertEqual(LoopbackHost.target("deck.localhost"), "localhost")
		XCTAssertEqual(LoopbackHost.target("example.org"), "example.org")
	}

	func testTheSentinelIsHiddenFromTheAddressBar() {
		XCTAssertEqual(
			LoopbackHost.display("http://deck.localhost:5173/settings"),
			"http://localhost:5173/settings")
	}
}
