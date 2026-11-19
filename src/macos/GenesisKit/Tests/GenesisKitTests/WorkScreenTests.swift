import Combine
import SwiftUI
import Vision
import GenesisKitTestHooks
import XCTest
@testable import GenesisKit

@MainActor
private final class FakeWorkSource: WorkSource {
    var snapshotValue: WorkSnapshotValue
    var notifyRows: [WorkNotifyRow] = []
    var performed: [WorkScreenAction] = []
    var notifyCall: [String?] = []
    var reads = 0
    var holdNextRead = false
    var resumeRead: CheckedContinuation<Void, Never>?
    var subscriptions = 0
    var serviceDown = false
    var projectNames = ["App", "Other"]
    private var continuation: AsyncStream<Void>.Continuation?

    init(_ snapshot: WorkSnapshotValue) { snapshotValue = snapshot }

    func projects() async throws -> [String] { projectNames }
    func detail(ref: String) async throws -> WorkItemDetail { throw WorkSourceError("No fixture item \(ref)") }
    func snapshot(project: String) async throws -> WorkSnapshotValue {
        reads += 1
        if holdNextRead {
            holdNextRead = false
            await withCheckedContinuation { resumeRead = $0 }
            resumeRead = nil
        }
        return snapshotValue
    }
    func notify(project: String) async throws -> [WorkNotifyRow] { notifyRows }
    func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String, level: String?) async throws -> WorkActionOutcome {
        notifyCall = [project, scope.rawValue, type, action, level]
        return WorkActionOutcome(ok: true, message: "Updated")
    }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        performed.append(action)
        return WorkActionOutcome(ok: true, message: "\(action.done): \(action.ref)")
    }
    func changes() -> AsyncStream<Void> {
        subscriptions += 1
        return AsyncStream {
            continuation = $0
            if serviceDown { $0.finish() }
        }
    }
    func tick() { continuation?.yield(()) }
    func end() { continuation?.finish() }
}

@MainActor
final class WorkScreenTests: XCTestCase {
    func testLiveSourceEndsWhenTheSubscribedSocketCloses() async throws {
        let peer = FakeRPCPeer()
        try peer.start()
        let rpc = GenesisToolsRPC(path: peer.path)
        let source = LiveWorkSource(rpc: rpc, walPath: peer.path + "/work.db-wal")
        let stream = source.changes()
        let ended = expectation(description: "Work observed the socket closing")
        let listener = Task { for await _ in stream {}; ended.fulfill() }
        defer { listener.cancel(); rpc.close() }
        try await Task.detached {
            defer { peer.stop() }
            for method in ["hello", "subscribe"] {
                let request = try peer.line { $0["method"] as? String == method }
                let id = try XCTUnwrap(request["id"])
                peer.send(["jsonrpc": "2.0", "id": id, "result": [:]])
            }
        }.value
        await fulfillment(of: [ended], timeout: 3)
    }

    func testNotifyUsesTheTypedSourceAndEncodesInheritanceAsNull() async throws {
        let fake = FakeWorkSource(fixture())
        let source: WorkSource = fake
        let result = try await source.setNotify(project: "Orchard", scope: .project, type: "bug", action: "spotted", level: "inbox")
        XCTAssertTrue(result.ok)
        XCTAssertEqual(fake.notifyCall, ["Orchard", "project", "bug", "spotted", "inbox"])
        let bytes = Data(#"{"scope":"project","project":"Orchard","notify":{"type":"*","action":"finished","level":null}}"#.utf8)
        let params = try JSONDecoder().decode(WorkConfigSetParams.self, from: bytes)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(params)) as? [String: Any]
        let notify = try XCTUnwrap(encoded?["notify"] as? [String: Any])
        XCTAssertTrue(notify["level"] is NSNull)
    }
    private func fixture() -> WorkSnapshotValue {
        WorkSnapshotValue(
            project: "App",
            containers: [
                WorkContainerValue(ref: "h_build001", type: "handoff", state: "active", title: "Build the work items", open: 2,
                                   total: 3, members: [
                                       WorkRowValue(ref: "h_build001:t1", state: "done", type: "task", worker: "claude ae3ac312",
                                                    title: "The store and the journal", slot: "t1"),
                                       WorkRowValue(ref: "h_build001:t2", state: "active", type: "task", worker: "claude ae3ac312",
                                                    title: "The hub's Work screen", slot: "t2"),
                                       WorkRowValue(ref: "w_tracker01", state: "open", type: "task", title: "Pull from the tracker", slot: "t3",
                                                    pairings: [.init(connector: "tracker", displayName: "Issue desk", remoteKey: "TASK-42",
                                                                     state: .drift, driftDirection: .remote)]),
                                   ], pairings: [.init(connector: "tracker", displayName: "Issue desk", remoteKey: "PLAN-12", state: .synced)]),
            ],
            triage: [
                WorkTriageValue(ref: "w_spot0001", group: "spotted", type: "bug", state: "spotted",
                                title: "The widget counts lag a write", where: "src/hub/lib/widget/tasks.ts:120",
                                why: "the cache key misses a pairing change", severity: "high",
                                pairings: [.init(connector: "tracker", displayName: "Issue desk", remoteKey: "BUG-17",
                                                 state: .drift, driftDirection: .local),
                                           .init(connector: "mirror", remoteKey: "COPY-18", state: .held)]),
                WorkTriageValue(ref: "w_spot0002", group: "spotted", type: "idea", state: "spotted",
                                title: "Group spotted items by file"),
                WorkTriageValue(ref: "w_reop0001", group: "reopened-no-worker", type: "task", state: "reopened",
                                title: "Parity test misses the dismissed scope"),
            ]
        )
    }

    private func settle(_ until: () -> Bool) async {
        let deadline = Date().addingTimeInterval(3)
        while !until() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func awaitSnapshot(_ model: WorkScreenModel, trigger: () -> Void) async {
        let received = expectation(description: "Work snapshot published")
        let watch = model.$snapshot.dropFirst().compactMap { $0 }.first().sink { _ in received.fulfill() }
        trigger()
        await fulfillment(of: [received], timeout: 3)
        watch.cancel()
    }

    func testTheModelLoadsTheFirstProjectReloadsOnAChangeAndRunsAWrite() async throws {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, reloadInterval: 0.2, settle: 0.05)
        await awaitSnapshot(model) { model.activate() }
        XCTAssertEqual(model.project, "App")
        XCTAssertEqual(model.snapshot?.spotted.count, 2)
        XCTAssertEqual(model.snapshot?.reopened.count, 1)

        let before = source.reads
        source.snapshotValue.triage.removeAll { $0.group == "reopened-no-worker" }
        await awaitSnapshot(model) { source.tick() }
        XCTAssertGreaterThan(source.reads, before, "a change of the store reloads the screen")

        await model.perform(.drop(ref: "w_spot0002", why: "not worth it"))
        XCTAssertEqual(source.performed, [.drop(ref: "w_spot0002", why: "not worth it")])
        XCTAssertEqual(model.notice, WorkActionOutcome(ok: true, message: "Dropped: w_spot0002"))
        XCTAssertTrue(model.pending.isEmpty)
        model.deactivate()
    }

    /// Every session writes the store, and a reload costs the service about 1.3 s of CPU: a burst is one reload, a
    /// hidden screen reloads nothing, and the first look after that reloads once.
    func testABurstOfChangesIsOneReloadAndAHiddenScreenWaits() async throws {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, reloadInterval: 0.4, settle: 0.1)
        await awaitSnapshot(model) { model.activate() }
        let first = source.reads
        source.projectNames.append("Third")
        source.snapshotValue.triage.removeAll { $0.group == "reopened-no-worker" }

        await awaitSnapshot(model) {
            for _ in 0..<20 { source.tick() }
        }
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(source.reads - first, 1, "twenty changes in 0.1 s are one reload")
        XCTAssertEqual(model.changeReloads, 1)
        XCTAssertEqual(model.projects, ["App", "Other", "Third"])
        XCTAssertEqual(model.project, "App")

        model.setVisible(false)
        let hidden = source.reads
        source.projectNames.removeLast()
        source.snapshotValue = fixture()
        for _ in 0..<5 { source.tick() }
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(source.reads, hidden, "nothing reloads while nobody can see the screen")

        XCTAssertEqual(model.projects, ["App", "Other", "Third"])
        await awaitSnapshot(model) { model.setVisible(true) }
        XCTAssertEqual(model.projects, ["App", "Other"])
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(source.reads - hidden, 1, "the first look reads what changed meanwhile, once")

        model.setVisible(false)
        model.setVisible(true)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(source.reads - hidden, 2, "the stream was stopped while hidden, so each return reads once")
        model.deactivate()
    }

    func testAnEqualLiveReadPublishesNothingAndKeepsTheSnapshot() async {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, reloadInterval: 0, settle: 0)
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        var publications = 0
        let observer = model.objectWillChange.sink { publications += 1 }
        defer { observer.cancel() }
        source.holdNextRead = true
        source.tick()
        await settle { source.resumeRead != nil }
        XCTAssertFalse(model.isFirstLoad)
        XCTAssertFalse(model.isLoading)
        let start = CFAbsoluteTimeGetCurrent()
        source.resumeRead?.resume()
        await model.finishCurrentRead()
        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
        print(String(format: "Work unchanged fixture read applied in %.3f ms, including task resumption", elapsed))
        XCTAssertEqual(publications, 0)
    }

    func testEndedStreamReconnectsAndReadsOnce() async {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, reloadInterval: 0, settle: 0, retryDelays: [])
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        let reads = source.reads
        source.end()
        let stopped = WorkLiveState.stopped(reason: "The GenesisTools service stopped.")
        await settle { model.live == stopped }
        XCTAssertEqual(model.live, stopped)
        model.reconnect()
        XCTAssertEqual(model.live, .live)
        await settle { source.reads > reads }
        XCTAssertEqual(source.subscriptions, 2)
        XCTAssertEqual(source.reads, reads + 1)
    }

    func testRetriesStopAfterThreeFailuresAndManualReconnectRestartsTheStream() async {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, retryDelays: [0, 0, 0])
        source.serviceDown = true
        model.activate()
        defer { model.deactivate() }
        let stopped = WorkLiveState.stopped(reason: "The GenesisTools service stopped.")
        await settle { source.subscriptions >= 4 && model.live == stopped }
        XCTAssertEqual(source.subscriptions, 4)
        source.serviceDown = false
        model.reconnect()
        XCTAssertEqual(source.subscriptions, 5)
        XCTAssertEqual(model.live, .live)
    }

    func testSlowTickAndPendingWriteWaitForTheirOwnRead() async {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, reloadInterval: 0, settle: 0, catchUpDelay: 0.01)
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        source.holdNextRead = true
        source.tick()
        await settle { model.live == .catchingUp }
        XCTAssertEqual(model.live, .catchingUp)
        XCTAssertFalse(model.isLoading)
        source.resumeRead?.resume()
        await settle { model.live == .live }
        source.holdNextRead = true
        let write = Task { await model.perform(.accept(ref: "w_spot0002")) }
        await settle { source.resumeRead != nil }
        XCTAssertTrue(model.pending.contains("w_spot0002"))
        XCTAssertEqual(model.snapshot?.triage.first { $0.ref == "w_spot0002" }?.state, "open")
        source.resumeRead?.resume()
        await write.value
        XCTAssertTrue(model.pending.isEmpty)
    }

    func testTheItemsPaneShowsHandoffsSpottedByTypeAndReopened() throws {
        let view = WorkItemsView(snapshot: fixture(), pending: [], expandAll: true) { _ in }
            .frame(width: 760)
        let text = try render(view, name: "work-items")
        for expected in ["Handoffs and epics", "Build the work items", "2 of 3 open", "The hub's Work screen",
                         "Spotted", "1 bug", "The widget counts lag a write", "1 idea",
                         "Reopened, nobody working", "Parity test misses", "Issue desk", "TASK-42", "Remote drift",
                         "BUG-17", "Local drift", "mirror", "COPY-18", "Held", "PLAN-12", "Synced"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected) in:\n\(text)")
        }
    }

    func testFoldingAHandoffKeepsItsOwnPairingVisible() throws {
        let text = try render(WorkItemsView(snapshot: fixture(), pending: []) { _ in }.frame(width: 600),
                              name: "work-items-folded")
        XCTAssertTrue(text.contains("PLAN-12"), text)
        XCTAssertFalse(text.contains("TASK-42"), text)
    }

    func testTheGeneratedMemberKeepsItsPairingWhenReencodedForTheScreen() throws {
        let bytes = Data("""
        {"ref":"w_member01","title":"Fix the counter","state":"open","type":"task","project":"App",
         "pairings":[{"connector":"tracker","displayName":"Issue desk","enabled":true,"remoteKey":"TASK-42",
                      "state":"drift","driftDirection":"remote","note":"changed outside, owned here: state"}]}
        """.utf8)
        let generated = try JSONDecoder().decode(WorkTreeResultOption0ValueDataContainersItemMembersItem.self, from: bytes)
        let member = try JSONDecoder().decode(WorkRowValue.self, from: JSONEncoder().encode(generated))
        XCTAssertEqual(member.pairings, [.init(connector: "tracker", displayName: "Issue desk", remoteKey: "TASK-42",
                                              state: .drift, driftDirection: .remote, note: "changed outside, owned here: state")])
    }

    func testAnEmptyProjectSaysSoInEachSection() throws {
        let empty = WorkSnapshotValue(project: "Quiet", containers: [], triage: [])
        let text = try render(WorkItemsView(snapshot: empty, pending: []) { _ in }.frame(width: 600), name: "work-items-empty")
        XCTAssertTrue(text.contains("No open handoff or epic in Quiet"), text)
        XCTAssertTrue(text.contains("Nothing spotted waits for a look"), text)
    }

    private func render<V: View>(_ view: V, name: String) throws -> String {
        let renderer = ImageRenderer(content: view.padding(16).background(Color.black).environment(\.colorScheme, .dark))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        if let folder = ProcessInfo.processInfo.environment["WORK_SNAPSHOT_DIR"] {
            let url = URL(fileURLWithPath: folder).appendingPathComponent("\(name).png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        let request = GenesisKitFixtureTextRequest()
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
