import XCTest
@testable import GenesisTools

/// PR/MR descriptions with their references and branch names as links (Hub/HubPRLinks.swift), the
/// PR and issue URLs they use (Hub/HubForgeLinks.swift), and the colors of state-like labels.
final class HubPRLinksTests: XCTestCase {
    private let github = ForgeWeb(kind: "github", web: "https://github.com/acme/web")!
    private let gitlab = ForgeWeb(kind: "gitlab", web: "https://gitlab.example.test/group/app")!

    func testPullRequestAndIssuePages() {
        XCTAssertEqual(github.pullRequest(12)?.absoluteString, "https://github.com/acme/web/pull/12")
        XCTAssertEqual(github.issue(12)?.absoluteString, "https://github.com/acme/web/issues/12")
        XCTAssertEqual(gitlab.pullRequest(7)?.absoluteString, "https://gitlab.example.test/group/app/-/merge_requests/7")
        XCTAssertEqual(gitlab.issue(7)?.absoluteString, "https://gitlab.example.test/group/app/-/issues/7")
    }

    func testGitHubNumbersLinkToTheirPage() {
        let out = PRDescriptionLinker.linkify("Stacked on #423, see acme/api#5.", context: PRLinkContext(forge: github))
        XCTAssertEqual(out, "Stacked on [#423](<https://github.com/acme/web/issues/423>), see [acme/api#5](<https://github.com/acme/api/issues/5>).")
    }

    func testGitLabBangIsAnMRAndHashIsAnIssue() {
        let out = PRDescriptionLinker.linkify("Fixes #3 after !12", context: PRLinkContext(forge: gitlab))
        XCTAssertEqual(out, "Fixes [#3](<https://gitlab.example.test/group/app/-/issues/3>) after [!12](<https://gitlab.example.test/group/app/-/merge_requests/12>)")
    }

    func testAListedPROpensInTheHubWithTheBrowserBesideIt() throws {
        let context = PRLinkContext(forge: github) { $0 == 423 ? "https://github.com/acme/web/pull/423" : nil }
        let out = PRDescriptionLinker.linkify("see #423", context: context)
        let app = try XCTUnwrap(PRDescriptionLinker.inAppURL(prID: "https://github.com/acme/web/pull/423"))
        XCTAssertEqual(out, "see [#423](<\(app.absoluteString)>)[↗](<https://github.com/acme/web/issues/423>)")
        XCTAssertEqual(PRDescriptionLinker.prID(from: app), "https://github.com/acme/web/pull/423")
        XCTAssertNil(PRDescriptionLinker.prID(from: URL(string: "https://github.com/acme/web/pull/423")!))
    }

    func testCodeLinksFencesAndEntitiesStayAsTheyAre() {
        let text = [
            "`#12` and [#13](https://x.test/13) and https://x.test/a#14 and &#15; and word#16",
            "```",
            "#17",
            "```",
        ].joined(separator: "\n")
        XCTAssertEqual(PRDescriptionLinker.linkify(text, context: PRLinkContext(forge: github)), text)
    }

    func testBranchesInCodeSpansAndByTheRepositoryNaming() {
        let context = PRLinkContext(forge: github, branches: ["feat/a", "develop"])
        let out = PRDescriptionLinker.linkify(
            "Stacked on `feat/a` and feat/b. Base `develop`; we develop here; src/hub stays.",
            context: context
        )
        XCTAssertEqual(
            out,
            "Stacked on [`feat/a`](<https://github.com/acme/web/tree/feat/a>) and [feat/b](<https://github.com/acme/web/tree/feat/b>). Base [`develop`](<https://github.com/acme/web/tree/develop>); we develop here; src/hub stays."
        )
    }

    func testOnlyTrailingPeriodsLeaveABranchAndADotPathStaysText() {
        // "feat/a" teaches the naming: feat/b links by it, as in the test above.
        let context = PRLinkContext(forge: github, branches: ["feat/a"])
        let out = PRDescriptionLinker.linkify("See ../feat/x and .feat/y, then feat/b.", context: context)
        XCTAssertEqual(out, "See ../feat/x and .feat/y, then [feat/b](<https://github.com/acme/web/tree/feat/b>).")
    }

    func testHTMLCommentsAreDropped() {
        let out = PRDescriptionLinker.linkify("a\n<!-- auto-generated -->\nb", context: PRLinkContext(forge: nil))
        XCTAssertEqual(out, "a\nb")
    }

    func testNothingIsLinkedWithoutAKnownHost() {
        XCTAssertEqual(PRDescriptionLinker.linkify("#1 `feat/a`", context: PRLinkContext(forge: nil, branches: ["feat/a"])), "#1 `feat/a`")
    }

    func testStateLabelsGetTheStateTone() {
        XCTAssertEqual(PRStateTone(label: "Merged into develop"), .merged)
        XCTAssertEqual(PRStateTone(label: "NOT merged into develop"), .pending)
        XCTAssertEqual(PRStateTone(label: "Closed"), .closed)
        XCTAssertEqual(PRStateTone(label: "WIP"), .draft)
        XCTAssertEqual(PRStateTone(label: "Ready for review"), .open)
        XCTAssertNil(PRStateTone(label: "backend"))
        XCTAssertNil(PRStateTone(label: "reopened-bug"))
    }
}
