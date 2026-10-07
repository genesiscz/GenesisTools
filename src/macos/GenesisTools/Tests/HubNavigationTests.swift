import XCTest
@testable import GenesisTools

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

    private func place(_ mode: HubMode, _ selection: String?) -> HubNavEntry {
        HubNavEntry(mode: mode, selection: selection)
    }

    // MARK: History

    func testBackAndForwardWalkThePlacesInOrder() {
        var history = HubNavHistory()
        history.visit(place(.sessions, "a"))
        history.visit(place(.prs, "pr1"))
        history.visit(place(.sessions, "b"))
        XCTAssertTrue(history.canGoBack)
        XCTAssertFalse(history.canGoForward)

        XCTAssertEqual(history.goBack(), place(.prs, "pr1"))
        XCTAssertEqual(history.goBack(), place(.sessions, "a"))
        XCTAssertNil(history.goBack(), "nothing before the first place")
        XCTAssertEqual(history.current, place(.sessions, "a"))

        XCTAssertEqual(history.goForward(), place(.prs, "pr1"))
        XCTAssertEqual(history.goForward(), place(.sessions, "b"))
        XCTAssertNil(history.goForward())
    }

    func testANewPlaceAfterGoingBackDropsTheForwardOnes() {
        var history = HubNavHistory()
        history.visit(place(.sessions, "a"))
        history.visit(place(.sessions, "b"))
        _ = history.goBack()
        history.visit(place(.worktrees, "/repo"))
        XCTAssertFalse(history.canGoForward)
        XCTAssertEqual(history.back, [place(.sessions, "a")])
    }

    func testTheSamePlaceTwiceIsOneEntry() {
        var history = HubNavHistory()
        history.visit(place(.sessions, "a"))
        history.visit(place(.sessions, "a"))
        XCTAssertFalse(history.canGoBack)
    }

    func testAPlaceWithNothingPickedIsReplacedByWhatFollows() {
        var history = HubNavHistory()
        history.visit(place(.sessions, nil))
        history.visit(place(.prs, nil))
        XCTAssertFalse(history.canGoBack, "the launch's empty Sessions mode is no place to go back to")

        history.visit(place(.prs, "pr1"))
        history.visit(place(.worktrees, nil))
        history.visit(place(.sessions, "a"))
        XCTAssertEqual(history.back, [place(.prs, "pr1")], "a mode left while its list loaded is not a stop")

        // Out to a loading mode and straight back is the place before it, not a second copy of it.
        history.visit(place(.worktrees, nil))
        history.visit(place(.sessions, "a"))
        XCTAssertEqual(history.back, [place(.prs, "pr1")])
        XCTAssertEqual(history.current, place(.sessions, "a"))

        _ = history.goBack()
        XCTAssertEqual(history.forward, [place(.sessions, "a")])
    }

    func testTheHistoryKeepsOnlyTheNewestPlaces() {
        var history = HubNavHistory()
        for index in 0...(HubNavHistory.limit + 20) {
            history.visit(place(.sessions, "s\(index)"))
        }
        XCTAssertEqual(history.back.count, HubNavHistory.limit)
        XCTAssertEqual(history.back.first, place(.sessions, "s20"))
    }

    func testTheModelRecordsEachPickAndWalksBackAndForward() {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        model.selectedID = "claude:one"
        drainMainQueue()
        XCTAssertFalse(model.history.canGoBack, "the launch's empty selection is not a place")
        model.selectedID = "claude:two"
        drainMainQueue()
        XCTAssertEqual(model.history.back, [place(.sessions, "claude:one")])

        MainActor.assumeIsolated { model.goBack() }
        drainMainQueue()
        XCTAssertEqual(model.selectedID, "claude:one")
        XCTAssertEqual(model.history.forward, [place(.sessions, "claude:two")])
        XCTAssertEqual(model.history.current, place(.sessions, "claude:one"), "the restore itself is not recorded")

        MainActor.assumeIsolated { model.goForward() }
        drainMainQueue()
        XCTAssertEqual(model.selectedID, "claude:two")
        XCTAssertFalse(model.history.canGoForward)
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
        XCTAssertEqual(model.history.back.last, place(.agents, child))

        MainActor.assumeIsolated { model.goBack() }
        drainMainQueue()
        XCTAssertEqual(model.mode, .agents)
        let selected = MainActor.assumeIsolated { model.agents.selectedID }
        XCTAssertEqual(selected, child)
        XCTAssertEqual(model.history.forward, [place(.prs, "github.com/acme/app#123")])
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
