import XCTest
@testable import DeckBrowser

final class KnownHostsTests: XCTestCase {
	private var defaults: UserDefaults!

	override func setUp() {
		super.setUp()
		// A throwaway suite, so a test run never reads or writes the real trust store.
		defaults = UserDefaults(suiteName: "deck.browser.tests.\(UUID().uuidString)")
	}

	override func tearDown() {
		defaults.removePersistentDomain(forName: defaults.description)
		defaults = nil
		super.tearDown()
	}

	func testTheFirstConnectionLearnsTheKeyAndTheSecondTrustsIt() {
		let hosts = KnownHosts(defaults: defaults)
		XCTAssertEqual(hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa"), .learned)
		XCTAssertEqual(hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa"), .trusted)
	}

	func testADifferentKeyIsRefused() {
		let hosts = KnownHosts(defaults: defaults)
		_ = hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa")
		XCTAssertEqual(
			hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:bbb"),
			.changed(expected: "SHA256:aaa", got: "SHA256:bbb"))
	}

	func testARefusalDoesNotOverwriteWhatWeTrust() {
		let hosts = KnownHosts(defaults: defaults)
		_ = hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa")
		_ = hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:bbb")
		XCTAssertEqual(hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa"), .trusted)
	}

	func testForgettingAHostLetsTheNewKeyBeLearned() {
		let hosts = KnownHosts(defaults: defaults)
		_ = hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa")
		hosts.forget(host: "mac", port: 22)
		XCTAssertNil(hosts.fingerprint(host: "mac", port: 22))
		XCTAssertEqual(hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:bbb"), .learned)
	}

	func testTheSameMachineOnAnotherPortIsADifferentEndpoint() {
		let hosts = KnownHosts(defaults: defaults)
		_ = hosts.verify(host: "mac", port: 22, fingerprint: "SHA256:aaa")
		XCTAssertEqual(hosts.verify(host: "mac", port: 2222, fingerprint: "SHA256:bbb"), .learned)
	}

	func testTheHostIsMatchedWithoutRegardToCase() {
		let hosts = KnownHosts(defaults: defaults)
		_ = hosts.verify(host: "Mac.local", port: 22, fingerprint: "SHA256:aaa")
		XCTAssertEqual(hosts.verify(host: "mac.local", port: 22, fingerprint: "SHA256:aaa"), .trusted)
	}

	func testTheFingerprintReadsLikeSshKeygens() {
		// Comparable by eye against `ssh-keygen -lf` on the machine itself,
		// which is the only way to check a mismatch is benign.
		let fingerprint = KnownHosts.fingerprint(ofOpenSSHKey: "ssh-ed25519 AAAAC3Nz example")
		XCTAssertTrue(fingerprint.hasPrefix("SHA256:"))
		XCTAssertFalse(fingerprint.contains("="), "no base64 padding, same as OpenSSH")
		XCTAssertEqual(fingerprint, KnownHosts.fingerprint(ofOpenSSHKey: "ssh-ed25519 AAAAC3Nz example"))
	}
}

final class TunnelSettingsTests: XCTestCase {
	func testSettingsRoundTripThroughDefaults() {
		let defaults = UserDefaults(suiteName: "deck.browser.tests.\(UUID().uuidString)")!
		var settings = TunnelSettings(host: "mac.local", port: 2222, username: "jin", localPort: 1081)
		settings.autoConnect = false
		settings.save(to: defaults)
		XCTAssertEqual(TunnelSettings.load(from: defaults), settings)
	}

	func testAFreshSettingStartsAtTheDeckMachine() {
		let settings = TunnelSettings().defaulting(toHostOf: URL(string: "https://example.ts.net:4818"))
		XCTAssertEqual(settings.host, "example.ts.net")
	}

	func testAHostYouHaveAlreadySetIsNotOverwritten() {
		let settings = TunnelSettings(host: "mac.local")
			.defaulting(toHostOf: URL(string: "https://example.ts.net:4818"))
		XCTAssertEqual(settings.host, "mac.local")
	}

	func testIncompleteSettingsCannotBuildAConfig() {
		XCTAssertNil(DevTunnel.Config(settings: TunnelSettings(host: "mac.local"), password: "x"))
		XCTAssertNotNil(
			DevTunnel.Config(settings: TunnelSettings(host: "mac.local", username: "jin"), password: "x"))
	}
}
