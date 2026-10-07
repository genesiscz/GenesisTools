import XCTest
@testable import GenesisTools

/// A review window's saved state (Review/ReviewSessionState.swift), the hub's saved place
/// (Hub/HubPlace.swift) and the face record a rebuild reads argv from (App/FaceRecord.swift).
final class ReviewSessionStateTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "review-session-state-tests"

    override func setUp() {
        defaults = UserDefaults(suiteName: suite)
        defaults.removePersistentDomain(forName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    // MARK: Scope

    func testEveryScopeSurvivesTheDiskForm() throws {
        let scopes: [DiffScope] = [
            .lastTurns(3), .uncommitted, .unstaged, .staged, .branch,
            .commit(sha: "abc1234", title: "fix it"),
            .range(base: "b1", head: "h1", label: "#7 title", fallbackBase: "b0"),
            .compare(from: CompareEnd(base: "b1", head: "h1"), to: CompareEnd(base: nil, head: "h2"), label: "v1 → v2", targetRef: "main"),
        ]
        for scope in scopes {
            let data = try JSONEncoder().encode(SavedScope(scope))
            let back = try JSONDecoder().decode(SavedScope.self, from: data)
            XCTAssertEqual(back.scope, scope, "\(scope) must come back as itself")
        }
    }

    func testARangeComesBackOnlyWhenTheLaunchNamesTheSameShas() {
        let launch = DiffScope.range(base: "b1", head: "h2", label: "#7")
        XCTAssertNil(SavedScope.restorable(SavedScope(.range(base: "b1", head: "h1", label: "#7")), launch: launch),
                     "a proposal whose PR moved on opens on its new shas")
        XCTAssertEqual(SavedScope.restorable(SavedScope(launch), launch: launch), launch)
        XCTAssertEqual(SavedScope.restorable(SavedScope(.commit(sha: "abc1234", title: "x")), launch: launch), .commit(sha: "abc1234", title: "x"),
                       "a commit the reader picked inside the review comes back")
        XCTAssertNil(SavedScope.restorable(nil, launch: launch))
    }

    // MARK: Key

    func testTheKeyNamesWhatTheWindowShows() {
        let proposal = ReviewSessionKey.key(proposalPath: "/p/./a b.json", prTarget: "42", repo: "/r", launchScope: .uncommitted, session: nil)
        XCTAssertEqual(proposal, "proposal:/p/a b.json", "a proposal wins over the PR and the repo")
        XCTAssertEqual(ReviewSessionKey.key(proposalPath: nil, prTarget: "group/app!7", repo: "/r", launchScope: .uncommitted, session: nil), "pr:group/app!7")
        let plain = ReviewSessionKey.key(proposalPath: nil, prTarget: nil, repo: "/r", launchScope: .branch, session: "s1")
        XCTAssertEqual(plain, "repo:/r|scope:branch|session:s1")
        XCTAssertNotEqual(plain, ReviewSessionKey.key(proposalPath: nil, prTarget: nil, repo: "/r", launchScope: .uncommitted, session: "s1"),
                          "a review opened on another scope is another window")
    }

    // MARK: Page

    func testThePageMessageDecodes() {
        let body: [String: Any] = [
            "type": "state",
            "anchor": ["fileId": "src/a.ts", "line": 120, "side": "additions"],
            "boxes": [["threadId": "thread:9", "kind": "reply", "noteId": NSNull(), "body": "half a reply"]],
            "composer": ["fileId": "src/a.ts", "side": "additions", "startLine": 3, "endLine": 5, "editingId": NSNull(), "body": "typed"],
        ]
        let page = ReviewSessionState.pageState(from: body)
        XCTAssertEqual(page?.anchor, ReviewSessionState.Anchor(fileId: "src/a.ts", line: 120, side: "additions"))
        XCTAssertEqual(page?.boxes, [ReviewSessionState.ThreadBox(threadId: "thread:9", kind: "reply", noteId: nil, body: "half a reply")])
        XCTAssertEqual(page?.composer?.body, "typed")
        XCTAssertNil(ReviewSessionState.pageState(from: ["type": "state", "anchor": ["line": 1]]), "an anchor without its file is dropped")
    }

    func testAnEmptyPageMessageDecodes() {
        let page = ReviewSessionState.pageState(from: ["type": "state", "anchor": NSNull(), "boxes": [], "composer": NSNull()])
        XCTAssertEqual(page, ReviewSessionState.PageState(anchor: nil, boxes: [], composer: nil))
    }

    // MARK: Apply and capture

    func testAStateCapturedFromOneModelPutsTheNextOneInTheSamePlace() throws {
        let first = ReviewModel(repo: URL(fileURLWithPath: "/work/tools"), options: DiffViewOptions(), renderer: NullRenderer())
        first.scope = .commit(sha: "abc1234", title: "fix")
        first.selectedID = "src/b.ts"
        first.filter = "b."
        first.treeMode = false
        first.collapsed = ["src/x", "lib"]
        first.dismissedNewsHead = "h9"
        defaults.set("commits", forKey: ReviewSessionPersistence.DefaultsKey.contextTab)
        defaults.set(false, forKey: ReviewContextPanel.collapsedKey)
        defaults.set(true, forKey: ReviewSessionPersistence.DefaultsKey.threadsClosed)
        let page = ReviewSessionState.PageState(anchor: .init(fileId: "src/b.ts", line: 40, side: "additions"), boxes: [], composer: nil)

        let state = ReviewSessionPersistence.capture(model: first, defaults: defaults, page: page)
        let stored = try JSONDecoder().decode(ReviewSessionState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(stored, state)
        XCTAssertEqual(stored.collapsed, ["lib", "src/x"], "sorted, so an unchanged set never rewrites the file")

        defaults.removePersistentDomain(forName: suite)
        let second = ReviewModel(repo: URL(fileURLWithPath: "/work/tools"), options: DiffViewOptions(), renderer: NullRenderer())
        ReviewSessionPersistence.apply(stored, to: second, launchScope: .uncommitted, defaults: defaults)
        XCTAssertEqual(second.scope, .commit(sha: "abc1234", title: "fix"))
        XCTAssertEqual(second.selectedID, "src/b.ts")
        XCTAssertEqual(second.filter, "b.")
        XCTAssertFalse(second.treeMode)
        XCTAssertEqual(second.collapsed, ["src/x", "lib"])
        XCTAssertEqual(second.dismissedNewsHead, "h9")
        XCTAssertEqual(defaults.string(forKey: ReviewSessionPersistence.DefaultsKey.contextTab), "commits")
        XCTAssertEqual(defaults.object(forKey: ReviewContextPanel.collapsedKey) as? Bool, false)
        XCTAssertEqual(defaults.object(forKey: ReviewSessionPersistence.DefaultsKey.threadsClosed) as? Bool, true)
        XCTAssertNil(defaults.object(forKey: ReviewSessionPersistence.DefaultsKey.threadsThisFile), "a setting the window never had stays unset")
    }

    func testAttachRestoresFromTheStore() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("review-state-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = DiskCache(directory: dir, namespace: "window")
        var saved = ReviewSessionState()
        saved.scope = SavedScope(.branch)
        saved.selectedFile = "README.md"
        cache.write(saved, key: "repo:/w|scope:uncommitted|session:-")

        let model = ReviewModel(repo: URL(fileURLWithPath: "/w"), options: DiffViewOptions(), renderer: NullRenderer())
        ReviewSessionPersistence.attach(model: model, key: "repo:/w|scope:uncommitted|session:-", launchScope: .uncommitted, cache: cache)
        XCTAssertEqual(model.scope, .branch)
        XCTAssertEqual(model.selectedID, "README.md")

        let other = ReviewModel(repo: URL(fileURLWithPath: "/w"), options: DiffViewOptions(), renderer: NullRenderer())
        ReviewSessionPersistence.attach(model: other, key: "repo:/w|scope:branch|session:-", launchScope: .uncommitted, cache: cache)
        XCTAssertEqual(other.scope, .uncommitted, "another key restores nothing")
    }

    // MARK: Hub place

    func testAHubPlaceOpensWithTheFlagsOfItsMode() {
        XCTAssertEqual(HubPlace(mode: "sessions", selection: "s1", tab: "changes").arguments, ["--session", "s1", "--tab", "changes"])
        XCTAssertEqual(HubPlace(mode: "sessions", selection: nil, tab: "changes").arguments, [])
        XCTAssertEqual(HubPlace(mode: "prs", selection: "https://github.com/o/r/pull/4", tab: nil).arguments,
                       ["--mode", "prs", "--pr", "https://github.com/o/r/pull/4"])
        XCTAssertEqual(HubPlace(mode: "worktrees", selection: WorktreeCleanup.selectionID, tab: nil).arguments,
                       ["--mode", "worktrees", "--worktree", "cleanup"])
        XCTAssertEqual(HubPlace(mode: "inbox", selection: HubModel.wholeList, tab: nil).arguments, ["--mode", "inbox"])
        XCTAssertEqual(HubPlace(mode: "agents", selection: AgentTree.mainKey("p1"), tab: nil).arguments, ["--mode", "agents", "--session", "p1"])
        XCTAssertEqual(HubPlace(mode: "agents", selection: "p1|aE-x", tab: nil).arguments, ["--session", "p1", "--agent", "aE-x"])
        XCTAssertEqual(HubPlace(mode: "nonsense", selection: "x", tab: nil).arguments, [])
    }

    func testResumeSwapsTheLaunchPlaceForTheSavedOne() {
        let place = HubPlace(mode: "prs", selection: "o/r#4", tab: nil)
        XCTAssertEqual(HubPlace.resumed(["--session", "old", "--tab", "transcript", "--no-activate", "--resume"], place: place),
                       ["--no-activate", "--mode", "prs", "--pr", "o/r#4"])
        XCTAssertEqual(HubPlace.resumed(["--session", "old", "--resume"], place: nil), ["--session", "old"],
                       "no saved place (an older hub) keeps the launch's own flags")
        XCTAssertEqual(HubPlace.resumed(["--session", "old"], place: place), ["--session", "old"], "without --resume the file is ignored")
    }

    // MARK: Face record

    func testOnlyWindowFacesAreRecorded() throws {
        XCTAssertTrue(FaceRecord.isWindowFace([]))
        XCTAssertTrue(FaceRecord.isWindowFace(["--window"]))
        XCTAssertTrue(FaceRecord.isWindowFace(["--hub"]))
        XCTAssertTrue(FaceRecord.isWindowFace(["--review", "--repo", "/a b"]))
        XCTAssertFalse(FaceRecord.isWindowFace(["--review", "--snapshot", "/tmp/x.png"]))
        XCTAssertFalse(FaceRecord.isWindowFace(["--hub", "--bench", "/tmp/b.json"]))
        XCTAssertFalse(FaceRecord.isWindowFace(["--rpc", "{}"]))
        XCTAssertFalse(FaceRecord.isWindowFace(["https://example.org/"]))

        let data = try XCTUnwrap(FaceRecord.encode(pid: 42, argv: ["--review", "--repo", "/a b"]))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["pid"] as? Int, 42)
        XCTAssertEqual(object["argv"] as? [String], ["--review", "--repo", "/a b"], "the path keeps its space")
    }
}
