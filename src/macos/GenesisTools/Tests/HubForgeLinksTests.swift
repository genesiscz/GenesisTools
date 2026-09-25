import AppKit
import XCTest
@testable import GenesisTools

/// The web pages the hub links labels to (Hub/HubForgeLinks.swift), and the rule that keeps the
/// instant tooltip off a control whose menu or popover a click just opened (Hub/HubTooltipGuard.swift).
final class HubForgeLinksTests: XCTestCase {
    private let github = ForgeWeb(kind: "github", web: "https://github.com/acme/web")!
    private let gitlab = ForgeWeb(kind: "gitlab", web: "https://gitlab.example.test:8443/group/sub/app")!

    func testOnlyGitHubAndGitLabProjectsGetPages() {
        XCTAssertNil(ForgeWeb(kind: "bitbucket", web: "https://bitbucket.org/acme/web"))
        XCTAssertNil(ForgeWeb(kind: nil, web: "https://github.com/acme/web"))
        XCTAssertNil(ForgeWeb(kind: "github", web: nil))
        XCTAssertNil(ForgeWeb(kind: "github", web: "https://github.com"), "a host without a project")
        XCTAssertEqual(ForgeWeb(kind: "github", web: "https://github.com/acme/web/")?.project, "https://github.com/acme/web")
    }

    func testUsersLiveAtTheHostRoot() {
        XCTAssertEqual(github.user("alice")?.absoluteString, "https://github.com/alice")
        XCTAssertEqual(github.user("app/dependabot")?.absoluteString, "https://github.com/apps/dependabot")
        XCTAssertEqual(gitlab.user("bob")?.absoluteString, "https://gitlab.example.test:8443/bob")
        XCTAssertEqual(gitlab.user("app/x")?.absoluteString, "https://gitlab.example.test:8443/app%2Fx", "GitLab has no app pages")
        XCTAssertNil(github.user(" "))
    }

    func testBranchesKeepTheirSlashesAndEncodeTheRest() {
        XCTAssertEqual(github.branch("feat/2026-09-26-enhancements")?.absoluteString, "https://github.com/acme/web/tree/feat/2026-09-26-enhancements")
        XCTAssertEqual(gitlab.branch("fix/a b#c?d%e")?.absoluteString, "https://gitlab.example.test:8443/group/sub/app/-/tree/fix/a%20b%23c%3Fd%25e")
        XCTAssertNil(github.branch("HEAD"))
        XCTAssertNil(github.branch(""))
    }

    func testCompareAndCommitPages() {
        XCTAssertEqual(github.compare(base: "master", head: "feat/x")?.absoluteString, "https://github.com/acme/web/compare/master...feat/x")
        XCTAssertEqual(gitlab.compare(base: "develop", head: "feature/y")?.absoluteString, "https://gitlab.example.test:8443/group/sub/app/-/compare/develop...feature/y")
        XCTAssertEqual(github.compare(base: "main", head: "patch-1", headOwner: "dave")?.absoluteString, "https://github.com/acme/web/compare/main...dave:patch-1")
        XCTAssertNil(gitlab.compare(base: "main", head: "patch-1", headOwner: "dave"), "GitLab has no cross-project compare URL")
        XCTAssertEqual(github.commit("abc123")?.absoluteString, "https://github.com/acme/web/commit/abc123")
        XCTAssertEqual(gitlab.commit("abc123")?.absoluteString, "https://gitlab.example.test:8443/group/sub/app/-/commit/abc123")
    }

    func testLabelsOpenTheFilteredPRList() throws {
        let gh = try XCTUnwrap(github.label("good first issue"))
        XCTAssertEqual(URLComponents(url: gh, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "is:pr label:\"good first issue\"")
        XCTAssertTrue(gh.absoluteString.hasPrefix("https://github.com/acme/web/pulls?q="))
        let gl = try XCTUnwrap(gitlab.label("ui"))
        XCTAssertTrue(gl.absoluteString.hasPrefix("https://gitlab.example.test:8443/group/sub/app/-/merge_requests?"))
        XCTAssertEqual(URLComponents(url: gl, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "ui")
    }

    func testAForkPRLinksItsHeadBranchInTheFork() throws {
        let pr = try decodePR(cross: true, headRepo: "\"dave/web-fork\"")
        XCTAssertEqual(pr.authorURL?.absoluteString, "https://github.com/alice")
        XCTAssertEqual(pr.headBranchURL?.absoluteString, "https://github.com/dave/web-fork/tree/fix/x")
        XCTAssertEqual(pr.baseBranchURL?.absoluteString, "https://github.com/acme/web/tree/main")
        XCTAssertEqual(pr.compareURL?.absoluteString, "https://github.com/acme/web/compare/main...dave:fix/x")
        XCTAssertEqual(pr.commitURL("c1")?.absoluteString, "https://github.com/acme/web/commit/c1")

        let unnamed = try decodePR(cross: true, headRepo: "null")
        XCTAssertNil(unnamed.headBranchURL, "a fork the host did not name gets no guessed page")
        XCTAssertNil(unnamed.compareURL)

        let local = try decodePR(cross: false, headRepo: "null")
        XCTAssertEqual(local.headBranchURL?.absoluteString, "https://github.com/acme/web/tree/fix/x")
        XCTAssertEqual(local.compareURL?.absoluteString, "https://github.com/acme/web/compare/main...fix/x")
    }

    private func decodePR(cross: Bool, headRepo: String) throws -> HubPR {
        let json = """
        {"repo":"web","repoRoot":null,"origin":{"kind":"github","host":"github.com","web":"https://github.com/acme/web"},
         "number":7,"title":"t","state":"OPEN","draft":false,"author":"alice","headBranch":"fix/x","baseBranch":"main",
         "url":"https://github.com/acme/web/pull/7","labels":[],"reviewers":[],"crossRepository":\(cross),"headRepo":\(headRepo)}
        """
        return try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
    }

    // MARK: Tooltip guard

    @MainActor
    func testAClickMutesTheControlsUnderItUntilThePointerLeaves() {
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.borderless], backing: .buffered, defer: true)
        let button = NSView(frame: CGRect(x: 10, y: 10, width: 80, height: 20))
        let neighbour = NSView(frame: CGRect(x: 150, y: 10, width: 80, height: 20))
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(neighbour)
        let buttonToken = UUID()
        let neighbourToken = UUID()
        TooltipGuard.entered(buttonToken, view: button)
        TooltipGuard.entered(neighbourToken, view: neighbour)

        TooltipGuard.mouseDown(at: CGPoint(x: 20, y: 15), in: window)
        XCTAssertTrue(TooltipGuard.isMuted(buttonToken))
        XCTAssertFalse(TooltipGuard.isMuted(neighbourToken), "only the control under the click")
        XCTAssertFalse(TooltipGuard.allows(buttonToken, in: window), "its bubble stays down while its popover is open")

        TooltipGuard.exited(buttonToken)
        XCTAssertFalse(TooltipGuard.isMuted(buttonToken))
        TooltipGuard.exited(neighbourToken)
    }
}
