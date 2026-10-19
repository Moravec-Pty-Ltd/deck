import XCTest
import DeckKit
@testable import DeckBrowser

final class BrowserTabsTests: XCTestCase {
	private func port(_ n: Int, label: String? = nil, primary: Bool = false, listening: Bool = true) -> String {
		let l = label.map { #","label":"\#($0)""# } ?? ""
		return #"{"port":\#(n)\#(l),"primary":\#(primary),"listening":\#(listening)}"#
	}

	private func server(
		_ name: String,
		state: String = "running",
		ports: [String] = [],
		preview: String? = nil
	) -> ServerRuntime {
		let p = preview.map { #","previewUrl":"\#($0)""# } ?? ""
		let json = #"{"name":"\#(name)","state":"\#(state)","ports":[\#(ports.joined(separator: ","))]\#(p)}"#
		return try! JSONDecoder().decode(ServerRuntime.self, from: Data(json.utf8))
	}

	func testOneTabPerDeclaredPort() {
		let tabs = BrowserTabs.derived(from: [
			server("web", ports: [port(5173, label: "app"), port(3000, label: "api")])
		])
		XCTAssertEqual(tabs.map(\.title), ["app", "api"])
		XCTAssertEqual(tabs.map(\.url), ["http://localhost:5173", "http://localhost:3000"])
	}

	func testThePrimaryPortComesFirst() {
		let tabs = BrowserTabs.derived(from: [
			server("web", ports: [port(3000, label: "api"), port(5173, label: "app", primary: true)])
		])
		XCTAssertEqual(tabs.map(\.title), ["app", "api"])
	}

	func testAPortWithNoLabelIsTitledByItsNumber() {
		let tabs = BrowserTabs.derived(from: [server("web", ports: [port(5173)])])
		XCTAssertEqual(tabs.map(\.title), [":5173"])
	}

	func testOnlyServersWorthPreviewingGetTabs() {
		let tabs = BrowserTabs.derived(from: [
			server("up", state: "running", ports: [port(5173)]),
			server("quiet", state: "stalled", ports: [port(5174)]),
			server("booting", state: "starting", ports: [port(5175)]),
			server("off", state: "stopped", ports: [port(5176)]),
			server("broken", state: "errored", ports: [port(5177)])
		])
		XCTAssertEqual(tabs.compactMap(\.port), [5173, 5174])
	}

	func testAPortDeclaredByTwoServersGetsOneTab() {
		let tabs = BrowserTabs.derived(from: [
			server("web", ports: [port(5173, label: "app")]),
			server("other", ports: [port(5173, label: "also app")])
		])
		XCTAssertEqual(tabs.map(\.title), ["app"])
	}

	func testTheCapturedUrlWinsForThePrimaryPort() {
		// deck read this off the server's own output, so it knows the real path
		// and scheme better than we can guess.
		let tabs = BrowserTabs.derived(from: [
			server(
				"web",
				ports: [port(5173, primary: true), port(3000)],
				preview: "http://localhost:5173/app")
		])
		XCTAssertEqual(tabs.map(\.url), ["http://localhost:5173/app", "http://localhost:3000"])
	}

	func testAPortThatIsNotAnsweringYetIsMarkedNotListening() {
		let tabs = BrowserTabs.derived(from: [
			server("web", ports: [port(5173, listening: true), port(3000, listening: false)])
		])
		XCTAssertEqual(tabs.map(\.listening), [true, false])
	}

	func testARefreshDoesNotYankThePageYouAreOn() {
		var tabs = BrowserTabs.derived(from: [server("web", ports: [port(5173, label: "app")])])
		tabs[0].url = "http://localhost:5173/settings/deep"

		let merged = BrowserTabs.merge(
			current: tabs,
			servers: [server("web", ports: [port(5173, label: "app", listening: false)])])

		XCTAssertEqual(merged.map(\.url), ["http://localhost:5173/settings/deep"])
		XCTAssertEqual(merged.map(\.listening), [false], "the fresh state still lands")
	}

	func testANewPortArrivesAndAVanishedOneLeaves() {
		let before = BrowserTabs.derived(from: [server("web", ports: [port(5173)])])
		let after = BrowserTabs.merge(
			current: before,
			servers: [server("web", ports: [port(3000)])])
		XCTAssertEqual(after.compactMap(\.port), [3000])
	}

	func testATabYouOpenedSurvivesEveryRefresh() {
		let mine = BrowserTabs.opened("https://example.org")
		let merged = BrowserTabs.merge(
			current: [mine],
			servers: [server("web", ports: [port(5173, label: "app")])])

		XCTAssertEqual(merged.map(\.title), ["app", "example.org"])
		XCTAssertEqual(merged.last?.id, mine.id, "and keeps its identity, so it does not reload")
	}

	func testAFreshTabIsTitledForTheAddressBar() {
		XCTAssertEqual(BrowserTabs.opened().title, "New tab")
		XCTAssertEqual(BrowserTabs.title(for: "http://deck.localhost:5173/x"), "localhost:5173")
		XCTAssertEqual(BrowserTabs.title(for: "https://example.org"), "example.org")
	}
}
