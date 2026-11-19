import AppKit
import Combine
import GenesisKit
import GenesisKitTestHooks
import Vision
import SwiftUI
import XCTest
@testable import GenesisToolsHub

/// A store the Work mode reads in place of the actions service.
@MainActor
private final class FakeWorkSource: WorkSource {
    var performed: [WorkScreenAction] = []
    var projectNames = ["App", "Quiet"]
    var requestedItems: [String] = []
    var snapshotReads = 0
    var holdNextSnapshot = false
    private(set) var heldSnapshot: CheckedContinuation<Void, Never>?
    private var changeFeed: AsyncStream<Void>.Continuation?

    func tick() { changeFeed?.yield(()) }
    func stopChanges() { changeFeed?.finish() }
    func releaseSnapshot() {
        let held = heldSnapshot
        heldSnapshot = nil
        held?.resume()
    }

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
        snapshotReads += 1
        if holdNextSnapshot {
            holdNextSnapshot = false
            await withCheckedContinuation { heldSnapshot = $0 }
        }
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
    func changes() -> AsyncStream<Void> { AsyncStream { changeFeed = $0 } }
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
        let text = try workFixtureText(try XCTUnwrap(rep.cgImage))
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

    func testTheHeaderStaysStillAcrossThreeSlowBackgroundReloadsAndOffersReconnect() async throws {
        let source = FakeWorkSource()
        let screen = WorkScreenModel(source: source, reloadInterval: 0.01, settle: 0.01, retryDelays: [])
        screen.activate()
        defer { source.releaseSnapshot(); screen.deactivate() }
        try await waitFor("the first Work snapshot") { screen.snapshot != nil && !screen.isFirstLoad }

        let header = WorkHeaderWindow(AnyView(WorkHeader(screen: screen)))
        defer { header.close() }
        try await Task.sleep(for: .milliseconds(60))
        let resting = try header.capture("work-header-after")
        let restingText = try headerText(resting)
        for word in ["Work", "App", "Items", "Notifications", "1 container"] {
            XCTAssertTrue(restingText.contains(word), restingText)
        }
        XCTAssertFalse(restingText.contains("Not live"), restingText)

        // The frozen production layout is the positive control: inserting its real spinner must move tabs.
        let before = WorkHeaderWindow(AnyView(WorkHeaderBeforeLive(screen: screen, loading: false)))
        defer { before.close() }
        let beforeLoading = WorkHeaderWindow(AnyView(WorkHeaderBeforeLive(screen: screen, loading: true)))
        defer { beforeLoading.close() }
        try await Task.sleep(for: .milliseconds(60))
        let beforeImage = try before.capture("work-header-before")
        let beforeLoadingImage = try beforeLoading.capture("work-header-before-loading")
        XCTAssertGreaterThan(try trailingControlInk(beforeImage), 0, "the original reload control must be visible")
        XCTAssertEqual(try trailingControlInk(resting), 0, "live Work must have no reload button")
        let oldMovement = try changedHeaderPixels(beforeImage, beforeLoadingImage, ignoringTrailingPoints: 120)
        XCTAssertGreaterThan(oldMovement, 0, "the baseline must expose the production header's moving tabs")

        var comparisons: [[String: Any]] = []
        for reload in 1...3 {
            let previousReads = source.snapshotReads
            source.holdNextSnapshot = true
            source.tick()
            try await waitFor("background read \(reload) to suspend") { source.heldSnapshot != nil }
            XCTAssertEqual(source.snapshotReads, previousReads + 1)
            XCTAssertFalse(screen.isLoading, "a store tick must not show foreground loading")
            try await Task.sleep(for: .milliseconds(40))
            let waiting = try header.capture("work-header-reload-\(reload)-waiting")
            let waitingPixels = try changedHeaderPixels(resting, waiting)
            XCTAssertEqual(waitingPixels, 0, "header changed as background read \(reload) started")

            try await waitFor("background read \(reload) to exceed the one-second live threshold") {
                screen.live == .catchingUp
            }
            try await Task.sleep(for: .milliseconds(40))
            let slow = try header.capture("work-header-reload-\(reload)-slow")
            let slowPixels = try changedHeaderPixels(resting, slow)
            XCTAssertEqual(slowPixels, 0, "header changed while background read \(reload) caught up")
            XCTAssertFalse(screen.isLoading)

            source.releaseSnapshot()
            try await waitFor("background read \(reload) to settle") { screen.live == .live }
            try await Task.sleep(for: .milliseconds(40))
            let settled = try header.capture("work-header-reload-\(reload)-settled")
            let settledPixels = try changedHeaderPixels(resting, settled)
            XCTAssertEqual(settledPixels, 0, "header changed after equal background read \(reload)")
            comparisons.append(["reload": reload, "waitingChangedPixels": waitingPixels,
                                "catchingUpChangedPixels": slowPixels, "settledChangedPixels": settledPixels])
        }

        source.stopChanges()
        try await waitFor("a stopped live stream") {
            if case .stopped = screen.live { return true }
            return false
        }
        try await Task.sleep(for: .milliseconds(60))
        let stopped = try header.capture("work-header-stopped")
        let stoppedText = try headerText(stopped)
        XCTAssertTrue(stoppedText.contains("Not live"), stoppedText)
        let stoppedLeft = try changedHeaderPixels(resting, stopped, ignoringTrailingPoints: 120)
        XCTAssertEqual(stoppedLeft, 0, "the recovery pill must not move the title, counts or tabs")
        XCTAssertGreaterThan(try changedHeaderPixels(resting, stopped), 0, "the recovery pill must actually draw")

        let readsBeforeReconnect = source.snapshotReads
        screen.reconnect()
        try await waitFor("reconnect to read the work once") { source.snapshotReads == readsBeforeReconnect + 1 }
        try await waitFor("reconnect to restore live updates") { screen.live == .live && !screen.isLoading }
        try await Task.sleep(for: .milliseconds(60))
        let reconnected = try header.capture("work-header-reconnected")
        XCTAssertEqual(try changedHeaderPixels(resting, reconnected), 0)
        try WorkHeaderWindow.writeEvidence([
            "widthPoints": 1300, "heightPoints": 52,
            "pixelsWide": resting.pixelsWide, "pixelsHigh": resting.pixelsHigh,
            "baselineCommit": "49ff462117",
            "baselineSourceSHA256": "be228c83a5b6892cf3b96d707ea97053c6854ab01cc12a5a31dfcf7f0df24d2f",
            "baselineTabMovementPixels": oldMovement,
            "stoppedTitleAndTabsChangedPixels": stoppedLeft,
            "backgroundReloads": comparisons,
        ])
    }

    func testTheExistingHubReloadCommandReadsWorkAgain() async throws {
        HubDefaults.isolate()
        let source = FakeWorkSource()
        let hub = HubModel(wantedSession: nil, tab: .transcript, workSource: source)
        defer { hub.work.deactivate() }
        XCTAssertTrue(hub.apply(HubRequest(["--mode", "work"])))
        try await waitFor("the Work mode's first read") { hub.work.screen.snapshot != nil && !hub.work.screen.isLoading }
        let command = try XCTUnwrap(HubMenuCommands.view.first { $0.id == "hub.view.reload" })
        XCTAssertNotEqual(command.enabled?(hub), false)
        let menuItem = try XCTUnwrap(HubMenuCommands.items([command], hub: hub).last)
        XCTAssertEqual(menuItem.keyEquivalent, "r")
        XCTAssertTrue(menuItem.keyEquivalentModifierMask.contains(.command))
        let previousReads = source.snapshotReads
        command.run(hub)
        try await waitFor("Command-R to read Work again") { source.snapshotReads == previousReads + 1 }
    }

    private func waitFor(_ state: String, timeout: TimeInterval = 3, until ready: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !ready(), Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        guard ready() else {
            XCTFail("Timed out waiting for \(state)")
            throw WorkHeaderCaptureError.timedOut
        }
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
        let text = try workFixtureText(try XCTUnwrap(rep.cgImage))
        for expected in ["Work", "App", "Quiet", "Items", "Notifications", "Build the work items", "1 of 2 open",
                         "Spotted", "The widget counts lag a write", "1 container"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected) in:\n\(text)")
        }
        model.deactivate()
    }
}

private enum WorkHeaderCaptureError: Error { case timedOut }

/// Captures successive frames of the actual production header in one offscreen window, without activating it.
@MainActor
private final class WorkHeaderWindow {
    private let host: NSHostingView<AnyView>
    private let window: NSWindow

    init(_ header: AnyView) {
        _ = NSApplication.shared
        host = NSHostingView(rootView: AnyView(header
            .frame(width: 1300, height: 52, alignment: .top)
            .background(Color.black)
            .environment(\.colorScheme, .dark)))
        window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 1300, height: 52),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        window.order(.below, relativeTo: 0)
    }

    func close() { window.close() }

    func capture(_ name: String) throws -> NSBitmapImageRep {
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        if let folder = Self.shotsFolder {
            try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: folder).appendingPathComponent(name + ".png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
            print("shot \(url.path)")
        }
        return rep
    }

    private static var shotsFolder: String? {
        ProcessInfo.processInfo.environment["HUB_WORK_SHOTS"] ?? ProcessInfo.processInfo.environment["WIDGET_SHOTS"]
    }

    static func writeEvidence(_ evidence: [String: Any]) throws {
        guard let folder = shotsFolder else { return }
        let url = URL(fileURLWithPath: folder).appendingPathComponent("work-header-pixels.json")
        try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]).write(to: url)
        print("header pixel evidence \(url.path)")
    }
}

/// Compare canonical RGBA pixels, rather than encoded PNG data or an assumed view width.
private func workFixtureText(_ image: CGImage) throws -> String {
    let request = GenesisKitFixtureTextRequest()
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
}

/// Vision misses small words when it scales an entire 25:1 strip. Use overlapping native-resolution tiles.
@MainActor
private func headerText(_ rep: NSBitmapImageRep) throws -> String {
    let image = try XCTUnwrap(rep.cgImage)
    var words: [String] = []
    for x in stride(from: 0, to: image.width, by: 420) {
        let width = min(640, image.width - x)
        let tile = try XCTUnwrap(image.cropping(to: CGRect(x: x, y: 0, width: width, height: image.height)))
        let canvas = try XCTUnwrap(CGContext(data: nil, width: width, height: 256, bitsPerComponent: 8,
                                            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        canvas.setFillColor(NSColor.black.cgColor)
        canvas.fill(CGRect(x: 0, y: 0, width: width, height: 256))
        canvas.draw(tile, in: CGRect(x: 0, y: 76, width: width, height: tile.height))
        let text = try workFixtureText(try XCTUnwrap(canvas.makeImage()))
        words.append(text)
    }
    return words.joined(separator: " ")
}

/// The trailing 55 points contain only the old reload glyph (or the recovery pill when stopped).
private func trailingControlInk(_ rep: NSBitmapImageRep) throws -> Int {
    let pixels = try headerRGBA(rep)
    let width = rep.pixelsWide, height = rep.pixelsHigh
    let start = width - width * 55 / 1300
    var count = 0
    for y in 0..<height {
        for x in start..<width {
            let offset = 4 * (y * width + x)
            if max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 100 { count += 1 }
        }
    }
    return count
}

private func headerRGBA(_ rep: NSBitmapImageRep) throws -> [UInt8] {
    let width = rep.pixelsWide, height = rep.pixelsHigh
    let image = try XCTUnwrap(rep.cgImage)
    let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                         bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    let data = try XCTUnwrap(context.data)
    return Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: width * height * 4))
}

private func changedHeaderPixels(_ first: NSBitmapImageRep, _ second: NSBitmapImageRep,
                                 ignoringTrailingPoints: CGFloat = 0) throws -> Int {
    XCTAssertEqual(first.pixelsWide, second.pixelsWide)
    XCTAssertEqual(first.pixelsHigh, second.pixelsHigh)
    let width = first.pixelsWide
    let height = first.pixelsHigh
    let lhs = try headerRGBA(first)
    let rhs = try headerRGBA(second)
    let right = width - Int(ignoringTrailingPoints * CGFloat(width) / 1300)
    var changed = 0
    for y in 0..<height {
        for x in 0..<right {
            let offset = (y * width + x) * 4
            if lhs[offset..<(offset + 4)] != rhs[offset..<(offset + 4)] { changed += 1 }
        }
    }
    return changed
}

/// Frozen production header from 49ff462117, before P1. It retains the exact spinner insertion and reload control;
/// the full original source and its SHA256 are retained beside the scratch header captures. Loading is supplied
/// explicitly because the new model correctly never sets it for a background reload.
private struct WorkHeaderBeforeLive: View {
    @ObservedObject var screen: WorkScreenModel
    let loading: Bool

    var body: some View {
        TitlebarHeader {
            HStack(spacing: 10) {
                Group {
                    Image(systemName: "checklist").foregroundColor(ReviewPalette.renamed)
                    Text("Work").font(.system(size: 14, weight: .semibold))
                    Text(verbatim: (screen.itemRef == nil ? screen.project : screen.itemDetail?.item.project) ?? "")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                    if let summary {
                        Text(verbatim: summary).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
                    }
                }
                .titlebarLabel()
                Spacer()
                GenSegmentedTabs("Work pane", items: WorkScreenModel.Pane.allCases.map { .init($0, $0.title) },
                                 selection: $screen.pane, minSegmentWidth: 96)
                    .frame(width: 220)
                if loading {
                    ProgressView().controlSize(.small).accessibilityLabel("Loading")
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Read this project's work again") { screen.reload() }
            }
        }
    }

    private var summary: String? {
        guard screen.itemRef == nil, let snapshot = screen.snapshot else { return nil }
        return [Plural.count(snapshot.containers.count, "container"),
                Plural.count(snapshot.spotted.count, "spotted item"),
                Plural.count(snapshot.reopened.count, "reopened item")].joined(separator: " · ")
    }
}
