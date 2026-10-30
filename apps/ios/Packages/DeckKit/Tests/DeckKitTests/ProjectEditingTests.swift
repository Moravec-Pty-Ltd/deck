import XCTest
@testable import DeckKit

final class ProjectEditingTests: XCTestCase {
	func testAnUntouchedDraftHasNoChanges() {
		let draft = ProjectDraft(name: "example", group: "apps", template: "t", reviewPrompt: "r")
		var edited = draft
		edited.template = " t\n"
		XCTAssertEqual(edited.changes(from: draft), [:], "whitespace the server trims is no change")
	}

	func testABlankNameIsNeverSent() {
		var draft = ProjectDraft(name: "example")
		draft.name = "  "
		XCTAssertEqual(draft.changes(from: ProjectDraft(name: "example")), [:])
		draft.name = "renamed"
		XCTAssertEqual(draft.changes(from: ProjectDraft(name: "example")), ["name": "renamed"])
	}

	func testTheAccountIsSentAndClearsToEmpty() {
		var draft = ProjectDraft(name: "example")
		draft.account = "work"
		XCTAssertEqual(draft.changes(from: ProjectDraft(name: "example")), ["account": "work"])
		XCTAssertEqual(ProjectDraft(name: "example").changes(from: draft), ["account": ""])
	}

	func testTheDraftPrefersTheStoredRecord() {
		let project = DeckProject(path: "/path/to/project", name: "listed", group: nil)
		let detail = ProjectDetail(path: project.path, name: "stored", group: "apps", template: "go", automation: nil)
		XCTAssertEqual(ProjectDraft(project: project, detail: detail), ProjectDraft(name: "stored", group: "apps", template: "go"))
		XCTAssertEqual(ProjectDraft(project: project, detail: nil).name, "listed")
	}

	func testRepoNamesMatchTheWeb() {
		XCTAssertEqual(RepoURL.name(from: "https://github.com/acme/repo.git"), "repo")
		XCTAssertEqual(RepoURL.name(from: "git@github.com:acme/web.GIT/"), "web")
		XCTAssertEqual(RepoURL.name(from: "host:repo"), "repo")
		XCTAssertNil(RepoURL.name(from: ""))
		XCTAssertNil(RepoURL.name(from: "https://example.com/.."))
	}

	func testOnlyNetworkCloneUrlsAreSafe() {
		for url in ["https://github.com/acme/repo.git", "ssh://git@example.com/acme/repo", "git://example.com/repo", "git@github.com:acme/repo.git"] {
			XCTAssertTrue(RepoURL.isSafe(url), url)
		}
		for url in ["", "file:///tmp/repo", "ext::sh -c x", "-oProxyCommand=x", "ssh://-oProxyCommand=x/repo", "git@-evil:path", "C:repo", "/path/to/repo", "http://example.com/repo", "a b:c"] {
			XCTAssertFalse(RepoURL.isSafe(url), url)
		}
	}

	func testTheCloneDestinationJoinsParentAndName() {
		XCTAssertEqual(RepoURL.destination(parent: "~/code/", url: "https://github.com/acme/repo.git"), "~/code/repo")
		XCTAssertNil(RepoURL.destination(parent: "", url: "https://github.com/acme/repo.git"))
		XCTAssertNil(RepoURL.destination(parent: "~/code", url: "file:///tmp/repo"))
	}

	func testPickingASuggestionListsItsChildren() {
		XCTAssertEqual(PathCompletion.drillIn("~/code"), "~/code/")
		XCTAssertEqual(PathCompletion.drillIn("~/code/"), "~/code/")
		XCTAssertEqual(PathCompletion.visible(["~/code", "~/code-old"], typed: "~/code/"), ["~/code-old"])
	}
}
