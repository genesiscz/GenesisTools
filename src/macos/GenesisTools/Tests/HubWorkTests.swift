import Combine
import GenesisKit
import SwiftUI
import XCTest
@testable import GenesisToolsHub

/// A store the Work mode reads in place of the actions service.
@MainActor
private final class FakeWorkSource: WorkSource {
    var performed: [WorkScreenAction] = []
    var projectNames = ["App", "Quiet"]
    var requestedItems: [String] = []

    func detail(ref: String) async throws -> WorkItemDetail {
        requestedItems.append(ref)
        guard ref == "h_build001:t2" else { throw WorkSourceError("No fixture item \(ref)") }
        return try JSONDecoder().decode(WorkItemDetail.self, from: Data(#"""
            {"item":{"id":"h_build001:t2","type":"task","title":"Verify the release","state":"active",
                     "project":"App","body":"Inspect the release archive.","acceptance":"The archive contains the receipt."}}
            """#.utf8))
    }

    func projects() async throws -> [String] { projectNames }
    func snapshot(project: String) async throws -> WorkSnapshotValue {
        guard project == "App" else { return WorkSnapshotValue(project: project, containers: [], triage: []) }
        return WorkSnapshotValue(
            project: "App",
            containers: [
                WorkContainerValue(ref: "h_build001", type: "handoff", state: "active", title: "Build the work items",
                                   open: 1, total: 2, members: [
                                       WorkRowValue(ref: "h_build001:t1", state: "done", type: "task", title: "The store", slot: "t1"),
                                       WorkRowValue(ref: "h_build001:t2", state: "active", type: "task", worker: "claude a1",
                                                    title: "The hub's Work screen", slot: "t2"),
                                   ]),
            ],
            triage: [
                WorkTriageValue(ref: "w_spot0001", group: "spotted", type: "bug", state: "spotted",
                                title: "The widget counts lag a write", severity: "high"),
            ]
        )
    }
    func notify(project: String) async throws -> [WorkNotifyRow] { [] }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        performed.append(action)
        return WorkActionOutcome(ok: true, message: "\(action.done): \(action.ref)")
    }
    func changes() -> AsyncStream<Void> { AsyncStream { _ in } }
}

@MainActor
final class HubWorkTests: XCTestCase {
    private func isolatedDefaults(suite: String = "HubWorkTests.\(UUID().uuidString)") -> UserDefaults {
        addTeardownBlock { UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite) }
        return UserDefaults(suiteName: suite)!
    }

    /// Wait for this entry's project list, even on a return visit with an existing snapshot.
    private func enter(_ model: HubWorkModel, sessions: [HubSession] = [], beforeProjectsLoad: () -> Void = {}) async {
        let loaded = expectation(description: "Read the Work projects")
        let watch = model.screen.$projectsLoaded.dropFirst().first(where: { $0 }).sink { _ in loaded.fulfill() }
        model.activate(sessions: sessions)
        beforeProjectsLoad()
        await fulfillment(of: [loaded], timeout: 3)
        watch.cancel()
    }

    func testOpeningProjectDefaultsToTheMostRecentlyActiveSession() async {
        let model = HubWorkModel(source: FakeWorkSource(), defaults: isolatedDefaults())
        defer { model.deactivate() }
        await enter(model, sessions: [
            HubSession(sessionId: "older", project: "App", mtime: 300, lastCacheAt: 100),
            HubSession(sessionId: "active", project: "quiet", mtime: 200),
        ])
        XCTAssertEqual(model.screen.project, "Quiet")
    }

    func testOpeningProjectUsesTheCachedWorkingDirectory() async {
        let model = HubWorkModel(source: FakeWorkSource(), defaults: isolatedDefaults())
        defer { model.deactivate() }
        await enter(model, sessions: [HubSession(sessionId: "active", cwd: "/repos/Quiet/.worktrees/feature", mtime: 200)])
        XCTAssertEqual(model.screen.project, "Quiet")
    }

    func testLastOpenedRemembersTheChosenProjectAcrossHubInstances() async {
        let suite = "HubWorkTests.\(UUID().uuidString)"
        let defaults = isolatedDefaults(suite: suite)
        let first = HubWorkModel(source: FakeWorkSource(), defaults: defaults)
        await enter(first)
        first.openProject("Quiet")
        first.deactivate()
        defaults.set(HubWorkOpeningProject.lastOpened.rawValue, forKey: HubWorkOpeningProject.key)
        let reopened = HubWorkModel(source: FakeWorkSource(), defaults: UserDefaults(suiteName: suite)!)
        defer { reopened.deactivate() }
        await enter(reopened, sessions: [HubSession(sessionId: "active", project: "App", mtime: 200)])
        XCTAssertEqual(reopened.screen.project, "Quiet")
    }

    func testFirstInListReopensTheFirstProjectAfterAManualPick() async {
        let defaults = isolatedDefaults()
        defaults.set(HubWorkOpeningProject.firstInList.rawValue, forKey: HubWorkOpeningProject.key)
        let model = HubWorkModel(source: FakeWorkSource(), defaults: defaults)
        defer { model.deactivate() }
        let sessions = [HubSession(sessionId: "active", project: "Quiet", mtime: 200)]
        await enter(model, sessions: sessions)
        model.openProject("Quiet")
        model.deactivate()
        await enter(model, sessions: sessions)
        XCTAssertEqual(model.screen.project, "App")
    }

    func testUnavailableOpeningProjectFallsBackToTheFirstOrNilForAnEmptyList() async {
        let defaults = isolatedDefaults()
        let source = FakeWorkSource()
        let model = HubWorkModel(source: source, defaults: defaults)
        defer { model.deactivate() }
        await enter(model, sessions: [
            HubSession(sessionId: "older", project: "Quiet", mtime: 100),
            HubSession(sessionId: "newest", project: "Missing", mtime: 200),
        ])
        XCTAssertEqual(model.screen.project, "App")
        model.openProject("Quiet")
        model.deactivate()
        defaults.set(HubWorkOpeningProject.lastOpened.rawValue, forKey: HubWorkOpeningProject.key)
        source.projectNames = ["App"]
        await enter(model)
        XCTAssertEqual(model.screen.project, "App")
        model.deactivate()
        source.projectNames = []
        await enter(model)
        XCTAssertNil(model.screen.project)
    }

    func testAnExplicitProjectOpenedDuringEntryWins() async {
        let model = HubWorkModel(source: FakeWorkSource(), defaults: isolatedDefaults())
        defer { model.deactivate() }
        await enter(model, sessions: [HubSession(sessionId: "active", project: "App", mtime: 200)]) {
            model.openProject("Quiet")
        }
        XCTAssertEqual(model.screen.project, "Quiet")
    }

    func testTheWorkModeIsAModeOfTheHub() {
        XCTAssertTrue(HubMode.allCases.contains(.work))
        XCTAssertEqual(HubMode.work.title, "Work")
    }

    func testWidgetLinkSelectsTheWorkItemAndShowsItsAcceptance() async throws {
        HubDefaults.isolate()
        let ref = "h_build001:t2"
        let args = try XCTUnwrap(HubRequest.arguments(fromLink: "genesis-tools://hub?work=h_build001%3At2"))
        let request = HubRequest(args)
        XCTAssertEqual(args, ["--work", ref])
        XCTAssertEqual(request.launchMode, .work, "a cold launch must start in Work")
        let source = FakeWorkSource()
        let hub = HubModel(wantedSession: nil, tab: .transcript, workSource: source)
        defer { hub.work.deactivate() }
        await enter(hub.work)
        hub.work.openProject("Quiet")
        hub.work.screen.pane = .notify
        XCTAssertTrue(hub.apply(request), "a widget click must navigate a running hub")
        let loaded = expectation(description: "Work settled on the requested item")
        hub.work.onLoaded = { loaded.fulfill() }
        await fulfillment(of: [loaded], timeout: 3)
        let view = HStack(spacing: 0) {
            WorkProjectsList(screen: hub.work.screen, filter: "", openProject: hub.work.openProject).frame(width: 200)
            WorkMain(screen: hub.work.screen)
        }
        .frame(width: 1000, height: 460).background(Color.black).environment(\.colorScheme, .dark)
        let rep = try HubInboxUXTests.render(view: AnyView(view), name: "hub-work-linked", folderKey: "HUB_WORK_SHOTS")
        let text = try HubInboxUXTests.drawnText(rep)
        XCTAssertEqual(source.requestedItems, [ref])
        XCTAssertEqual(hub.mode, .work)
        XCTAssertEqual(hub.work.screen.project, "App")
        XCTAssertEqual(hub.work.screen.pane, .items)
        XCTAssertTrue(text.contains("The archive contains the receipt"), text)
        XCTAssertEqual(HubPlace(entry: hub.navEntry, tab: .transcript).arguments, ["--work", ref])
        XCTAssertTrue(hub.apply(HubRequest(["--mode", "work"])))
        XCTAssertEqual(HubPlace(entry: hub.navEntry, tab: .transcript).arguments, ["--mode", "work"])
    }

    /// A launch with `--mode work` settles on the Work screen's first load (the snapshot waits for it).
    func testOnLoadedFiresOnceOnTheFirstLoad() async {
        let model = HubWorkModel(source: FakeWorkSource(), defaults: isolatedDefaults())
        var calls = 0
        let loaded = expectation(description: "First Work load")
        model.onLoaded = {
            calls += 1
            loaded.fulfill()
        }
        model.activate()
        await fulfillment(of: [loaded], timeout: 3)
        XCTAssertEqual(calls, 1)
        let reloaded = expectation(description: "Reloaded Work snapshot")
        let watch = model.screen.$snapshot.dropFirst().compactMap { $0 }.first().sink { _ in reloaded.fulfill() }
        model.screen.reload()
        await fulfillment(of: [reloaded], timeout: 3)
        watch.cancel()
        XCTAssertEqual(calls, 1, "once only")
        model.deactivate()
    }

    /// The hub window's visibility reaches the Work screen, so a covered or hidden hub reloads nothing.
    func testTheWorkScreenFollowsTheHubWindowsVisibility() {
        let model = HubWorkModel(source: FakeWorkSource(), defaults: isolatedDefaults())
        XCTAssertTrue(model.screen.visible)
        HubVisibility.shared.set(false)
        XCTAssertFalse(model.screen.visible)
        HubVisibility.shared.set(true)
        XCTAssertTrue(model.screen.visible)
    }

    /// The whole Work main pane in a real window (the menu button's window reader is an AppKit view, which an image
    /// renderer cannot draw): the header names the project and its counts, the rows and their buttons draw. A handoff
    /// starts folded with its open count (the real project has 35 of them), so its tasks are not on screen yet.
    func testTheWorkPaneDrawsTheProjectInARealWindow() async throws {
        let model = HubWorkModel(source: FakeWorkSource(), defaults: isolatedDefaults())
        let loaded = expectation(description: "Work snapshot ready for rendering")
        let watch = model.screen.$snapshot.compactMap { $0 }.first().sink { _ in loaded.fulfill() }
        model.activate()
        await fulfillment(of: [loaded], timeout: 3)
        watch.cancel()
        XCTAssertEqual(model.screen.project, "App")
        XCTAssertEqual(model.navSelection, "App")

        let view = HStack(spacing: 0) {
            WorkProjectsList(screen: model.screen, filter: "", openProject: model.openProject).frame(width: 200)
            WorkMain(screen: model.screen)
        }
        .frame(width: 1000, height: 460)
        .background(Color.black)
        .environment(\.colorScheme, .dark)
        let rep = try HubInboxUXTests.render(view: AnyView(view), name: "hub-work", folderKey: "HUB_WORK_SHOTS")
        let text = try HubInboxUXTests.drawnText(rep)
        for expected in ["Work", "App", "Quiet", "Items", "Notifications", "Build the work items", "1 of 2 open",
                         "Spotted", "The widget counts lag a write", "1 container"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected) in:\n\(text)")
        }
        model.deactivate()
    }
}
