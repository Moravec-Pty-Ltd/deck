import XCTest
@testable import DeckKit

final class DevConfigTests: XCTestCase {
	/// The full valid config from the server's parseDevConfig tests, plus the
	/// optional fields it leaves out.
	private static let fixture = #"""
	{
		"copyFromMain": [".env"],
		"setup": [{ "label": "install", "run": "pnpm i" }],
		"servers": [{
			"name": "web", "run": "pnpm dev", "cwd": "apps/web",
			"setup": [{ "label": "codegen", "run": "pnpm gen", "cwd": "packages/api" }],
			"ports": [{ "port": 5173, "primary": true }, { "port": 6006, "label": "storybook" }],
			"readyPattern": "Local:\\s+(http\\S+)"
		}]
	}
	"""#

	private func object(_ data: Data) throws -> NSDictionary {
		try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
	}

	func testTheServersShapeRoundTrips() throws {
		let data = Data(Self.fixture.utf8)
		let config = try JSONDecoder().decode(DevConfig.self, from: data)
		XCTAssertEqual(config.servers?.first?.readyPattern, #"Local:\s+(http\S+)"#)
		XCTAssertEqual(config.servers?.first?.ports?.first, DevPort(port: 5173, primary: true))
		XCTAssertEqual(try object(JSONEncoder().encode(config)), try object(data))
	}

	func testTheProjectRecordCarriesTheDevConfig() throws {
		let record = #"{"path":"/path/to/project","name":"example","dev":\#(Self.fixture)}"#
		let detail = try JSONDecoder().decode(ProjectDetail.self, from: Data(record.utf8))
		XCTAssertEqual(detail.dev?.servers?.first?.name, "web")
	}

	func testAnUntouchedDraftGivesBackTheConfig() throws {
		let config = try JSONDecoder().decode(DevConfig.self, from: Data(Self.fixture.utf8))
		XCTAssertEqual(DevConfigDraft(config).config, config)
	}

	func testTheDraftCleansAsTheWebFormDoes() {
		var server = DevServerDraft(name: " web ", run: "pnpm dev", cwd: " ", readyPattern: "")
		server.ports = [DevPortDraft(port: "3000", label: " "), DevPortDraft(port: "70000"), DevPortDraft(port: "x")]
		server.setup = [DevStepDraft(label: "install", run: ""), DevStepDraft(label: "gen", run: "pnpm gen ")]
		let draft = DevConfigDraft(
			copyFromMain: [DevPathDraft(path: " .env "), DevPathDraft(path: " ")],
			setup: [DevStepDraft(label: "", run: "pnpm i")],
			servers: [server, DevServerDraft(name: "api")])
		XCTAssertEqual(draft.config, DevConfig(
			copyFromMain: [".env"],
			setup: [],
			servers: [DevServer(name: "web", run: "pnpm dev", setup: [DevSetupStep(label: "gen", run: "pnpm gen")], ports: [DevPort(port: 3000)])]))
	}

	func testOnlyOnePortIsPrimary() {
		var server = DevServerDraft(ports: [DevPortDraft(port: "1", primary: true), DevPortDraft(port: "2")])
		server.setPrimary(server.ports[1].id, true)
		XCTAssertEqual(server.ports.map(\.primary), [false, true])
		server.setPrimary(server.ports[1].id, false)
		XCTAssertEqual(server.ports.map(\.primary), [false, false])
	}
}
