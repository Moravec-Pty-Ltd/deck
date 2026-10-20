import XCTest
@testable import DeckKit

final class PairingTests: XCTestCase {
	private let url = URL(string: "http://localhost:4818/api/pair/status?secret=s")!

	func testTheTicketDecodes() throws {
		let json = #"{"secret":"abc","code":"042117","expiresAt":1700000000000}"#
		let ticket = try JSONDecoder().decode(PairingTicket.self, from: Data(json.utf8))
		XCTAssertEqual(ticket.code, "042117")
		XCTAssertEqual(ticket.expiry, Date(timeIntervalSince1970: 1_700_000_000))
	}

	func testPollingStopsAtTheTicketExpiryOrFiveMinutes() {
		let start = Date(timeIntervalSince1970: 1_700_000_000)
		let soon = PairingTicket(secret: "s", code: "1", expiresAt: (start.timeIntervalSince1970 + 60) * 1000)
		XCTAssertEqual(soon.pollDeadline(from: start), start.addingTimeInterval(60))
		let late = PairingTicket(secret: "s", code: "1", expiresAt: (start.timeIntervalSince1970 + 3600) * 1000)
		XCTAssertEqual(late.pollDeadline(from: start), start.addingTimeInterval(300))
	}

	func testAnApprovalCarriesTheCookieToken() {
		let headers = ["Set-Cookie": "deck_token=t0ken; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"]
		XCTAssertEqual(PairingClient.claim(status: "approved", headers: headers, url: url), .approved(token: "t0ken"))
	}

	func testAnApprovalWithoutTheCookieIsUnknown() {
		let headers = ["Set-Cookie": "other=1; Path=/"]
		XCTAssertEqual(PairingClient.claim(status: "approved", headers: headers, url: url), .unknown)
		XCTAssertEqual(PairingClient.claim(status: "approved", headers: [:], url: url), .unknown)
	}

	func testTheOtherStatuses() {
		XCTAssertEqual(PairingClient.claim(status: "pending", headers: [:], url: url), .pending)
		XCTAssertEqual(PairingClient.claim(status: "denied", headers: [:], url: url), .denied)
		XCTAssertEqual(PairingClient.claim(status: "expired", headers: [:], url: url), .expired)
		XCTAssertEqual(PairingClient.claim(status: "unknown", headers: [:], url: url), .unknown)
		XCTAssertEqual(PairingClient.claim(status: nil, headers: [:], url: url), .unknown)
	}
}
