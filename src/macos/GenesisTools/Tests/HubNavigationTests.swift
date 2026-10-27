import Combine
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// Back and forward through the hub (`HubNavHistory`, `HubModel.goBack`) and the group order a
/// dragged header leaves behind (`GroupPrefs.drop`).
final class HubNavigationTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        HubDefaults.isolate()
    }

    @MainActor
    private func isolatedModel(wanted: String? = nil) -> HubModel {
        let model = HubModel(wantedSession: wanted, tab: .transcript)
        model.panes = [.transcript]
        model.readSessionCache = { _ in nil }
        model.writeSessionCache = { _, _ in }
        model.readDecisions = { SessionDecisionsEnvelope(sessionId: $0, decisions: []) }
        return model
    }

    @MainActor
    func testRefreshPreservesNavigationAndRejectsAnOlderListCompletion() async throws {
        let a = HubSession(sessionId: "fixture-a"), b = HubSession(sessionId: "fixture-b"), c = HubSession(sessionId: "fixture-c")
        let model = isolatedModel(wanted: a.sessionId)
        let initial = expectation(description: "initial list")
        model.readSessions = { _ in [a, b] }
        model.writeSessionCache = { _, _ in initial.fulfill() }
        model.loadSessions()
        await fulfillment(of: [initial], timeout: 2)
        XCTAssertEqual(model.selectedID, a.id)
        model.select(b.id)
        model.initialMode = .prs
        model.setMode(.sessions)

        let started = expectation(description: "both refreshes requested")
        started.expectedFulfillmentCount = 2
        var pending: [CheckedContinuation<[HubSession], Error>] = []
        model.readSessions = { _ in try await withCheckedThrowingContinuation { continuation in
            pending.append(continuation)
            started.fulfill()
        } }
        let published = expectation(description: "newest list publishes")
        var writes = 0
        model.writeSessionCache = { _, _ in writes += 1; published.fulfill() }
        model.loadSessions()
        model.loadSessions()
        await fulfillment(of: [started], timeout: 2)
        model.sessions.append(c)
        model.select(c.id)
        pending[1].resume(returning: [b, c])
        await fulfillment(of: [published], timeout: 2)
        pending[0].resume(returning: [a])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(model.selectedID, c.id)
        XCTAssertEqual(model.mode, .sessions)
        XCTAssertEqual(model.sessions.map(\.id), [b.id, c.id])
        XCTAssertEqual(writes, 1)
    }

    @MainActor
    func testCommitNavigationSupersedesAnOlderStartupSessionLookup() async throws {
        let model = isolatedModel()
        model.loadingWorktrees = true
        let old = HubSession(sessionId: "fixture-older")
        let started = expectation(description: "older startup lookup starts")
        let returned = expectation(description: "older startup lookup returns")
        var pending: CheckedContinuation<[HubSession], Error>?
        model.readSessions = { hours in
            XCTAssertEqual(hours, HubModel.olderSessionHours)
            let rows: [HubSession] = try await withCheckedThrowingContinuation {
                pending = $0
                started.fulfill()
            }
            returned.fulfill()
            return rows
        }
        model.openOlderSession(old.sessionId, settle: true)
        await fulfillment(of: [started], timeout: 2)

        // The lookup of this nonexistent fixture path has no git or live-app effects.
        model.apply(HubRequest(["--repo", "/fixture/commit-navigation", "--commit", "abcdef0"]))
        let request = model.commitLinkRequest
        model.applyCommitLink(.found(.init(root: "/fixture/commit-navigation", sha: "abcdef0", title: "linked")), request: request)
        let committedRequest = model.commitLinkRequest
        try XCTUnwrap(pending).resume(returning: [old])
        await fulfillment(of: [returned], timeout: 2)
        for _ in 0..<5 { await Task.yield() }

        XCTAssertNil(model.selectedID, "the superseded startup lookup must not select its session")
        XCTAssertFalse(model.sessions.contains(where: { $0.id == old.id }))
        XCTAssertEqual(model.commitLinkRequest, committedRequest)
        XCTAssertEqual(model.mode, .worktrees)
        XCTAssertEqual(model.review?.scope, .commit(sha: "abcdef0", title: "linked"))
    }

    @MainActor
    func testCommitNavigationClearsASessionWaitingForTheRecentList() async throws {
        let model = isolatedModel()
        model.loadingWorktrees = true
        let old = HubSession(sessionId: "fixture-pending")
        let started = expectation(description: "recent session lookup starts")
        let loaded = expectation(description: "recent session list lands")
        var pending: CheckedContinuation<[HubSession], Error>?
        model.readSessions = { hours in
            XCTAssertEqual(hours, HubModel.recentHours)
            return try await withCheckedThrowingContinuation {
                pending = $0
                started.fulfill()
            }
        }
        model.writeSessionCache = { _, _ in loaded.fulfill() }
        model.apply(HubRequest(["--session", old.sessionId]))
        await fulfillment(of: [started], timeout: 2)

        model.apply(HubRequest(["--repo", "/fixture/commit-navigation", "--commit", "abcdef0"]))
        let request = model.commitLinkRequest
        try XCTUnwrap(pending).resume(returning: [old])
        await fulfillment(of: [loaded], timeout: 2)
        for _ in 0..<5 { await Task.yield() }

        XCTAssertNil(model.selectedID, "a later list may contain the session without navigating back to it")
        XCTAssertEqual(model.commitLinkRequest, request)
        model.applyCommitLink(.found(.init(root: "/fixture/commit-navigation", sha: "abcdef0", title: "linked")), request: request)
        XCTAssertEqual(model.mode, .worktrees)
        XCTAssertEqual(model.review?.scope, .commit(sha: "abcdef0", title: "linked"))
    }

    @MainActor
    func testLateHeaderSuccessOrFailureCannotPopulateTheNextSession() async throws {
        for fail in [false, true] {
            let a = HubSession(sessionId: "fixture-a"), b = HubSession(sessionId: "fixture-b")
            let model = isolatedModel()
            model.sessions = [a, b]
            model.panes = [.files]
            let started = expectation(description: "header A starts")
            var pending: CheckedContinuation<TranscriptEnvelope, Error>?
            model.readTranscript = { _, _ in try await withCheckedThrowingContinuation {
                pending = $0
                started.fulfill()
            } }
            model.select(a.id)
            await fulfillment(of: [started], timeout: 2)
            model.panes = [.transcript]
            model.select(b.id)
            let response = try SessionTranscriptClient.decode(Data(#"{"provider":"claude","sessionId":"fixture-a","filePath":"/fixture/a","byteSize":0,"truncated":false,"nextOffset":0,"turns":[],"totals":{"modelCalls":99}}"#.utf8))
            if fail { pending?.resume(throwing: NSError(domain: "fixture-A", code: 1)) }
            else { pending?.resume(returning: response) }
            for _ in 0..<5 { await Task.yield() }
            XCTAssertEqual(model.selectedID, b.id)
            XCTAssertNil(model.transcriptTotals)
            XCTAssertNil(model.transcriptError)
            XCTAssertFalse(model.loadingTranscript)
            let next = expectation(description: "header B can start")
            model.readTranscript = { row, _ in
                XCTAssertEqual(row.id, b.id)
                next.fulfill()
                return response
            }
            model.panes = [.files]
            await fulfillment(of: [next], timeout: 2)
        }
    }

    private func place(_ mode: HubMode, _ selection: String?) -> HubNavTarget {
        HubNavTarget(place: HubNavEntry(mode: mode, selection: selection))
    }

    // MARK: History (the engine's own rules are GenesisKit's NavigationHistoryTests)

    func testAPlaceKeepsItsSelectionAndCommitAndALinkPlaceOpensAsItsFlags() throws {
        let shown = HubNavTarget(place: HubNavEntry(mode: .worktrees, selection: "/src/app"), commit: "0751d8a971", repo: "/src/app")
        XCTAssertEqual(shown.place, HubNavEntry(mode: .worktrees, selection: "/src/app"))
        XCTAssertEqual(shown["commit"], "0751d8a971")
        let data = try JSONEncoder().encode(shown)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? [String: String],
                       ["mode": "worktrees", "selection": "/src/app", "commit": "0751d8a971", "repo": "/src/app"],
                       "a flat object, the target of tools hub nav")
        XCTAssertEqual(try JSONDecoder().decode(HubNavTarget.self, from: data), shown)

        let named = try JSONDecoder().decode(HubNavTarget.self, from: Data(##"{"pr":"#563","commit":"abcdef0","snapshot":"/tmp/x.png"}"##.utf8))
        XCTAssertNil(named.place, "an agent's place has no selection of the hub's own")
        XCTAssertEqual(named.arguments, ["--pr", "#563", "--commit", "abcdef0"], "unknown keys never become flags")
    }

    /// The wire to `tools hub nav` (src/hub/commands/nav.ts): what `list --json` prints, and `record`'s flags.
    func testTheStoreReadsTheListAndWritesFreeTextAsFlagEqualsValue() throws {
        let listed = Data(##"{"entries":[{"id":"x2","at":1792949067131,"actor":"agent","title":"PR #563","target":{"pr":"563"},"note":"why","from":"s-1"},{"id":"x1","at":1792949066674,"actor":"robot","title":"s","target":{"mode":"sessions","selection":"claude:a"}}],"keep":50,"path":"/x/navigation.db"}"##.utf8)
        let entries = try HubNavStore.decode(listed)
        XCTAssertEqual(entries.map(\.id), ["x2", "x1"])
        XCTAssertEqual(entries[0].actor, .agent)
        XCTAssertEqual(entries[0].note, "why")
        XCTAssertEqual(entries[0].agentSession, "s-1")
        XCTAssertEqual(entries[0].at.timeIntervalSince1970, 1_792_949_067.131, accuracy: 0.001)
        XCTAssertEqual(entries[1].actor, .user, "an unknown actor reads as the person's")
        XCTAssertEqual(entries[1].target.place, HubNavEntry(mode: .sessions, selection: "claude:a"))

        let args = try HubNavStore.recordArguments(
            NavigationEntry(id: "e", at: Date(timeIntervalSince1970: 2), target: place(.prs, "p"), title: "-x title",
                            actor: .agent, agentSession: "s", note: "--why"), keep: 20)
        XCTAssertEqual(Array(args.prefix(3)), ["hub", "nav", "record"])
        XCTAssertTrue(args.contains("--title=-x title"))
        XCTAssertTrue(args.contains("--note=--why"))
        XCTAssertTrue(args.contains("--at=2000"))
        XCTAssertTrue(args.contains("--keep=20"))
        XCTAssertTrue(args.contains("--from=s"))
        var annotated = NavigationEntry(target: place(.prs, "p"), title: "p")
        annotated.replacedIDs = ["old-id", "cli-1"]
        let replacement = try HubNavStore.recordArguments(annotated, keep: 20)
        XCTAssertEqual(Array(replacement.suffix(3)), ["--replacing", "old-id", "cli-1"])
        XCTAssertEqual(HubNavStore.limitArguments(20), ["hub", "nav", "configure", "--keep=20"])
    }

    func testARequestCarriesWhoAndWhyAndALinkWithoutAnActorIsALink() throws {
        let request = HubRequest(["--pr", "acme/app#563", "--commit", "0751d8a971", "--actor", "agent", "--note", "why",
                                  "--from", "session-1", "--nav", "entry-1"])
        let asked = try XCTUnwrap(HubNavRequest(request))
        XCTAssertEqual(asked.actor, .agent)
        XCTAssertEqual(asked.note, "why")
        XCTAssertEqual(asked.from, "session-1")
        XCTAssertEqual(asked.id, "entry-1")
        XCTAssertEqual(asked.title, "PR acme/app#563 · commit 0751d8a971")
        XCTAssertEqual(HubNavRequest(HubRequest(["--session", "abc"]))?.actor, .link)
        XCTAssertNil(HubNavRequest(HubRequest(["--palette", "gt pr"])), "an overlay is no place")
        XCTAssertEqual(HubLink.arguments(fromLink: "genesis-tools://hub?pr=1&actor=agent&note=a%20b&from=s&nav=n&menu=Go"),
                       ["--pr", "1", "--actor", "agent", "--note", "a b", "--from", "s", "--nav", "n"])
        // A link copied out of a task notification, whose XML escapes `&`: `amp;commit` is still the commit.
        XCTAssertEqual(HubLink.arguments(fromLink: "genesis-tools://hub?repo=acme%2Fapp&amp;commit=abc1234&amp;menu=Go"),
                       ["--repo", "acme/app", "--commit", "abc1234"])
    }

    /// A first launch opens the mode of the place it names; `--worktree` alone opened Sessions (2026-10-27).
    func testALaunchOpensTheModeOfThePlaceItNames() {
        XCTAssertEqual(HubRequest(["--worktree", "/work/app"]).launchMode, .worktrees)
        XCTAssertEqual(HubRequest(["--worktree", "cleanup"]).launchMode, .worktrees)
        XCTAssertEqual(HubRequest(["--repo", "acme/app", "--commit", "abc1234"]).launchMode, .worktrees)
        XCTAssertEqual(HubRequest(["--pr", "acme/app#7", "--commit", "abc1234"]).launchMode, .prs)
        XCTAssertEqual(HubRequest(["--session", "s", "--agent", "a"]).launchMode, .agents)
        XCTAssertEqual(HubRequest(["--decision", "d_1_s"]).launchMode, .inbox)
        XCTAssertEqual(HubRequest(["--session", "s"]).launchMode, .sessions)
        XCTAssertEqual(HubRequest(["--mode", "timeline", "--worktree", "/work/app"]).launchMode, .timeline, "--mode wins")
    }

    /// What a request names and the hub cannot open is said, never dropped without a word.
    func testARequestNamesWhatItCannotOpen() {
        XCTAssertEqual(HubRequest(["--mode", "pr"]).problems, ["mode=pr is no hub mode (sessions, worktrees, prs, inbox, timeline, agents)"])
        XCTAssertEqual(HubRequest(["--tab", "diff"]).problems, ["tab=diff is no hub tab (transcript, changes, files, decisions)"])
        XCTAssertEqual(HubRequest(["--reveal", "a.swift"]).problems, ["reveal=a.swift opens a file in a PR's review: the link names no PR (pr=)"])
        XCTAssertEqual(HubRequest(["--pr", "acme/app#7", "--reveal", "a.swift", "--mode", "prs", "--tab", "files"]).problems, [])
    }

    func testTheModelRecordsEachPickAndWalksBackAndForward() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.selectedID = "claude:one"
        drainMainQueue()
        XCTAssertFalse(model.history.canGoBack, "the launch's empty selection is not a place")
        model.selectedID = "claude:two"
        drainMainQueue()
        XCTAssertEqual(model.history.backEntry?.target, place(.sessions, "claude:one"))
        XCTAssertEqual(model.history.current?.actor, .user)

        MainActor.assumeIsolated { model.goBack() }
        drainMainQueue()
        XCTAssertEqual(model.selectedID, "claude:one")
        XCTAssertEqual(model.history.forwardEntry?.target, place(.sessions, "claude:two"))
        XCTAssertEqual(model.history.current?.target, place(.sessions, "claude:one"), "the restore itself is not recorded")
        XCTAssertEqual(model.history.entries.count, 2)

        MainActor.assumeIsolated { model.goForward() }
        drainMainQueue()
        XCTAssertEqual(model.selectedID, "claude:two")
        XCTAssertFalse(model.history.canGoForward)
    }

    /// Martin, 2026-10-25: what an agent opened replaced the place he was on, and he could not get back.
    @MainActor
    func testAnAgentsPlaceIsAddedWithItsNoteAndBackReturns() async throws {
        let a = HubSession(sessionId: "fixture-a"), b = HubSession(sessionId: "fixture-b"), c = HubSession(sessionId: "fixture-c")
        let model = isolatedModel(wanted: a.sessionId)
        let initial = expectation(description: "initial list")
        model.readSessions = { _ in [a, b, c] }
        model.writeSessionCache = { _, _ in initial.fulfill() }
        model.loadSessions()
        await fulfillment(of: [initial], timeout: 2)
        await drain()
        model.select(b.id)
        await drain()
        XCTAssertEqual(model.history.current?.target, place(.sessions, b.id))

        XCTAssertTrue(model.apply(HubRequest(["--session", "fixture-c", "--actor", "agent", "--note", "the failing run",
                                              "--from", "agent-session", "--nav", "cli-id"])))
        await drain()
        XCTAssertEqual(model.selectedID, c.id)
        let current = try XCTUnwrap(model.history.current)
        XCTAssertEqual(current.id, "cli-id", "the entry tools hub nav open stored, not a second one")
        XCTAssertEqual(current.target, place(.sessions, c.id))
        XCTAssertEqual(current.actor, .agent)
        XCTAssertEqual(current.note, "the failing run")
        XCTAssertEqual(current.agentSession, "agent-session")
        XCTAssertEqual(model.history.entries.map(\.target), [place(.sessions, a.id), place(.sessions, b.id), place(.sessions, c.id)],
                       "nothing was replaced")

        model.goBack()
        await drain()
        XCTAssertEqual(model.selectedID, b.id)
        // The same place again from an agent: its note, no new entry.
        XCTAssertTrue(model.apply(HubRequest(["--session", "fixture-b", "--actor", "agent", "--note", "look again"])))
        await drain()
        XCTAssertEqual(model.history.current?.note, "look again")
        XCTAssertEqual(model.history.entries.count, 3)
    }

    private func drain() async {
        for _ in 0..<3 {
            await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
        }
    }

    func testWhileAgentsOnlyAddToHistoryTheViewStays() throws {
        let preferences = MainActor.assumeIsolated { HubDefaults.preferences }
        MainActor.assumeIsolated { preferences.agentNavigation = .listOnly }
        defer { MainActor.assumeIsolated { preferences.agentNavigation = .navigate } }
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.selectedID = "claude:one"
        drainMainQueue()
        let shown = model.apply(HubRequest(["--pr", "acme/app#9", "--actor", "agent", "--note", "later", "--nav", "cli-id"]))
        drainMainQueue()
        XCTAssertFalse(shown)
        XCTAssertEqual(model.mode, .sessions)
        XCTAssertEqual(model.selectedID, "claude:one")
        XCTAssertEqual(model.history.current?.target, place(.sessions, "claude:one"))
        let added = try XCTUnwrap(model.history.entry("cli-id"))
        XCTAssertEqual(added.note, "later")
        XCTAssertEqual(added.target["pr"], "acme/app#9")
        XCTAssertNil(model.history.offset(of: "cli-id"), "in the list, not on the back or forward stack")
        // A link the person clicked (no actor, so `link`) is their own move: it navigates.
        XCTAssertTrue(model.apply(HubRequest(["--mode", "worktrees"])))
        XCTAssertEqual(model.mode, .worktrees)
        // A person's own request still navigates.
        XCTAssertTrue(model.apply(HubRequest(["--mode", "prs", "--actor", "user"])))
        XCTAssertEqual(model.mode, .prs)
    }

    @MainActor
    func testListOnlyKeepsRevealAndTabThroughAHop() async throws {
        let preferences = HubDefaults.preferences
        preferences.agentNavigation = .listOnly
        defer { preferences.agentNavigation = .navigate }
        let model = isolatedModel()
        let request = HubRequest(["--pr", "acme/app#9", "--reveal", "Sources/File.swift", "--tab", "changes",
                                  "--actor", "agent", "--nav", "cli-reveal"])
        XCTAssertFalse(model.apply(request))
        let entry = try XCTUnwrap(model.history.entry("cli-reveal"))
        XCTAssertEqual(entry.target["reveal"], "Sources/File.swift")
        XCTAssertEqual(entry.target["tab"], "changes")
        model.hop(to: entry.id)
        XCTAssertEqual(model.tab, .changes)
        XCTAssertEqual(model.prs.pendingReveal?.path, "Sources/File.swift")
        await drain()
        let session = try XCTUnwrap(HubNavRequest(HubRequest(["--session", "fixture", "--tab", "changes"])))
        XCTAssertEqual(HubRequest(session.target.arguments).tab, .changes)
    }

    @MainActor
    func testAnUnresolvedAgentRequestDoesNotMatchThePreviouslySelectedAgent() throws {
        let model = isolatedModel()
        model.mode = .agents
        model.agents.select(parent: "old-parent", child: "old-agent")
        let asked = try XCTUnwrap(HubNavRequest(HubRequest(["--session", "new-parent", "--agent", "new-agent"])))
        XCTAssertFalse(model.navRequestMatches(asked))
        let main = try XCTUnwrap(HubNavRequest(HubRequest(["--mode", "agents", "--session", "new-parent"])))
        XCTAssertFalse(model.navRequestMatches(main))
    }

    @MainActor
    func testBackToTheWholePRClearsTheLinkedCommitAndResetsTheScope() async throws {
        let json = #"{"prs":[{"repo":"app","number":9,"title":"fixture","state":"OPEN","draft":false,"headBranch":"feature","baseBranch":"main","url":"https://github.com/acme/app/pull/9","labels":[],"reviewers":[]}],"repos":[]}"#
        let list = try JSONDecoder().decode(HubPRList.self, from: Data(json.utf8))
        let pr = try XCTUnwrap(list.prs.first)
        let model = isolatedModel()
        model.mode = .prs
        model.prs.apply(list, key: "fixture", flash: false)
        model.pendingNav = HubNavRequest(HubRequest(["--pr", pr.url, "--commit", "abcdef0"]))
        model.prs.selectedID = pr.id
        await drain()
        let review = ReviewModel(repo: URL(fileURLWithPath: "/fixture/navigation"), options: DiffViewOptions())
        review.scope = .commit(sha: "abcdef0", title: "linked")
        model.prs.review = review
        var history = HubNavHistory()
        history.visit(place(.prs, pr.id), title: "whole PR")
        history.visit(HubNavTarget(place: HubNavEntry(mode: .prs, selection: pr.id), commit: "abcdef0"), title: "commit")
        model.replaceHistory(history)
        model.goBack()
        XCTAssertNil(model.navTarget(model.navEntry)["commit"])
        XCTAssertEqual(review.scope, PRsModel.scope(pr, detail: nil))
        XCTAssertNil(model.prs.pendingCommit)
        await drain()
    }

    @MainActor
    func testBackFromALinkedWorktreeCommitRestoresTheOrdinaryScope() async throws {
        for main in [false, true] {
            let model = isolatedModel()
            model.mode = .worktrees
            model.loadingWorktrees = true
            let worktree = HubWorktree(path: "/fixture/worktree-scope", repo: "app", commonDir: "/fixture/common", branch: "feature", isMain: main)
            model.worktrees = [worktree]
            model.selectWorktree(worktree)
            await drain()
            model.showCommit(repo: worktree.path, sha: "abcdef0123", title: "linked")
            await drain()
            XCTAssertEqual(model.review?.scope, .commit(sha: "abcdef0123", title: "linked"))
            XCTAssertEqual(model.history.backEntry?.target, place(.worktrees, worktree.path))
            model.goBack()
            await drain()
            XCTAssertEqual(model.review?.scope, main ? .uncommitted : .branch)
            XCTAssertNil(model.shownCommit)
            XCTAssertNil(model.history.current?.target["commit"])
        }
    }

    @MainActor
    func testBackCancelsAnUnfulfilledRequestAndRestoresTheAgentsListWithoutAChild() async throws {
        let model = isolatedModel()
        model.mode = .agents
        model.agents.select(parent: "parent", child: "child")
        await drain()
        var history = HubNavHistory()
        history.visit(place(.agents, HubModel.wholeList), title: "Agents")
        history.visit(place(.agents, AgentTree.key(parent: "parent", child: "child")), title: "child")
        model.replaceHistory(history)
        model.pendingNav = HubNavRequest(HubRequest(["--session", "missing", "--agent", "missing"]))
        model.goBack()
        XCTAssertNil(model.pendingNav, "Back supersedes an older external request")
        XCTAssertNil(model.agents.selectedID, "the list entry has no child selected")
        await drain()
        XCTAssertEqual(model.history.current?.target, place(.agents, HubModel.wholeList))
    }

    func testAHopShowsAnyPlaceAndBackReturns() throws {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        for id in ["claude:one", "claude:two", "claude:three"] {
            model.selectedID = id
            drainMainQueue()
        }
        let first = try XCTUnwrap(model.history.entries.first)
        MainActor.assumeIsolated { model.hop(to: first.id) }
        drainMainQueue()
        XCTAssertEqual(model.selectedID, "claude:one")
        XCTAssertEqual(model.history.forwardEntry?.target, place(.sessions, "claude:two"))
        XCTAssertEqual(model.history.entries.count, 3)
    }

    // Martin, 2026-10-06: Agents at parent X, child Y; a banner opens PR 123; back must land on X / Y again.
    func testBackFromAPrOpenedByABannerReturnsToTheAgentChild() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        let child = AgentTree.key(parent: "parent-x", child: "child-y")
        MainActor.assumeIsolated {
            model.setMode(.agents)
            model.agents.select(parent: "parent-x", child: "child-y")
        }
        drainMainQueue()
        MainActor.assumeIsolated {
            model.setMode(.prs)
            model.prs.selectedID = "github.com/acme/app#123"
        }
        drainMainQueue()
        XCTAssertEqual(model.history.backEntry?.target, place(.agents, child))

        MainActor.assumeIsolated { model.goBack() }
        drainMainQueue()
        XCTAssertEqual(model.mode, .agents)
        let selected = MainActor.assumeIsolated { model.agents.selectedID }
        XCTAssertEqual(selected, child)
        XCTAssertEqual(model.history.forwardEntry?.target, place(.prs, "github.com/acme/app#123"))
    }

    private func drainMainQueue() {
        let done = expectation(description: "main queue")
        DispatchQueue.main.async { DispatchQueue.main.async { done.fulfill() } }
        wait(for: [done], timeout: 2)
    }

    // MARK: Group order from a drag

    private func prefs(_ name: String) -> GroupPrefs {
        for suffix in ["pinned", "collapsed", "order"] {
            HubDefaults.store.removeObject(forKey: "groups.\(name).\(suffix)")
        }
        return GroupPrefs(key: name)
    }

    func testDroppingAHeaderPutsItBeforeOrAfterTheTarget() {
        let groups = prefs("test.drop")
        let names = ["api", "app", "docs", "web"]
        groups.drop("web", on: "api", after: false, among: names)
        XCTAssertEqual(groups.sorted(names), ["web", "api", "app", "docs"])

        groups.drop("web", on: "docs", after: true, among: names)
        XCTAssertEqual(groups.sorted(names), ["api", "app", "docs", "web"])

        groups.drop("api", on: "api", after: false, among: names)
        XCTAssertEqual(groups.sorted(names), ["api", "app", "docs", "web"], "a drop on itself changes nothing")
    }

    func testADropTakesTheTargetsSideOfThePinLine() {
        let groups = prefs("test.pin")
        let names = ["api", "app", "docs", "web"]
        groups.togglePin("docs")
        XCTAssertEqual(groups.sorted(names), ["docs", "api", "app", "web"])

        groups.drop("web", on: "docs", after: false, among: names)
        XCTAssertEqual(groups.pinned, ["web", "docs"], "dropped among the pinned groups, it is pinned")

        groups.drop("docs", on: "app", after: true, among: names)
        XCTAssertEqual(groups.pinned, ["web"], "dropped below the pinned groups, it is not")
        XCTAssertEqual(groups.sorted(names), ["web", "api", "app", "docs"])
    }

    func testGroupsNotShownKeepTheirStoredPlaceAndTheOrderIsSaved() {
        let groups = prefs("test.hidden")
        groups.order = ["zeta", "api", "app"]
        groups.drop("app", on: "api", after: false, among: ["api", "app"])
        XCTAssertEqual(groups.order, ["app", "api", "zeta"])

        let reloaded = GroupPrefs(key: "test.hidden")
        XCTAssertEqual(reloaded.order, ["app", "api", "zeta"])
    }
}
