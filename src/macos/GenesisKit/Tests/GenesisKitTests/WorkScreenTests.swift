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
    var writeResult: WorkActionOutcome?
    var notifyCall: [String?] = []
    var reads = 0
    var holdNextRead = false
    var resumeRead: CheckedContinuation<Void, Never>?
    var holdWrite = false
    var resumeWrite: CheckedContinuation<Void, Never>?
    var subscriptions = 0
    var serviceDown = false
    var readsToFail = 0
    var projectNames = ["App", "Other"]
    private var continuation: AsyncStream<WorkSourceEvent>.Continuation?

    init(_ snapshot: WorkSnapshotValue) { snapshotValue = snapshot }

    func projects() async throws -> [String] { projectNames }
    func detail(ref: String) async throws -> WorkItemDetail { throw WorkSourceError("No fixture item \(ref)") }
    func snapshot(project: String) async throws -> WorkSnapshotValue {
        reads += 1
        if readsToFail > 0 {
            readsToFail -= 1
            throw WorkSourceError("Fixture read failed")
        }
        let confirmed = snapshotValue
        if holdNextRead {
            holdNextRead = false
            await withCheckedContinuation { resumeRead = $0 }
            resumeRead = nil
        }
        return confirmed
    }
    func notify(project: String) async throws -> [WorkNotifyRow] { notifyRows }
    func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String, level: String?) async throws -> WorkActionOutcome {
        notifyCall = [project, scope.rawValue, type, action, level]
        return WorkActionOutcome(ok: true, message: "Updated")
    }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        performed.append(action)
        if holdWrite { await withCheckedContinuation { resumeWrite = $0 }; resumeWrite = nil }
        if let writeResult { return writeResult }
        return WorkActionOutcome(ok: true, message: "\(action.done): \(action.ref)")
    }
    func changes() -> AsyncStream<WorkSourceEvent> {
        subscriptions += 1
        return AsyncStream {
            continuation = $0
            if serviceDown { $0.finish() }
        }
    }
    func tick() { continuation?.yield(.serviceChange) }
    func end() { continuation?.finish() }
}

@MainActor
final class WorkScreenTests: XCTestCase {
    func testLiveSourceKeepsFileChangesAfterTheSubscribedSocketCloses() async throws {
        let peer = FakeRPCPeer()
        try peer.start()
        var peerStopped = false
        defer { if !peerStopped { peer.stop() } }
        let rpc = GenesisToolsRPC(path: peer.path)
        let directory = URL(fileURLWithPath: peer.path + "-store", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wal = directory.appendingPathComponent("work.db-wal")
        let source = LiveWorkSource(rpc: rpc, walPath: wal.path)
        let stream = source.changes()
        let subscribed = expectation(description: "Work received a service change")
        let disconnected = expectation(description: "Work observed the socket closing")
        let fileChanged = expectation(description: "Work received a WAL change after disconnect")
        let listener = Task {
            for await event in stream {
                switch event {
                case .serviceChange: subscribed.fulfill()
                case .serviceDisconnected: disconnected.fulfill()
                case .localChange: fileChanged.fulfill(); return
                }
            }
        }
        defer { listener.cancel(); rpc.close() }
        try await Task.detached {
            for method in ["hello", "subscribe"] {
                let request = try peer.line { $0["method"] as? String == method }
                let id = try XCTUnwrap(request["id"])
                peer.send(["jsonrpc": "2.0", "id": id, "result": [:]])
            }
            peer.send(["jsonrpc": "2.0", "method": "work.changed",
                       "params": ["payload": ["method": "edit", "items": ["w_fixture01"]],
                                  "at": "2026-11-19T06:00:00Z"]])
        }.value
        await fulfillment(of: [subscribed], timeout: 3)
        peer.stop()
        peerStopped = true
        await fulfillment(of: [disconnected], timeout: 3)
        try Data("fixture WAL".utf8).write(to: wal)
        await fulfillment(of: [fileChanged], timeout: 3)
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

    private func settle(file: StaticString = #filePath, line: UInt = #line, _ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition() && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), "Work model did not settle", file: file, line: line)
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
        XCTAssertEqual(model.notice, WorkActionOutcome(ok: true, message: "Dropped: Group spotted items by file"))
        XCTAssertTrue(model.pending.isEmpty)
        model.deactivate()
    }

    func testAFailedChangeReloadRetriesWithoutAnotherWrite() async {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source, reloadInterval: 0.2, settle: 0.05)
        await awaitSnapshot(model) { model.activate() }
        defer { model.deactivate() }
        let before = source.reads
        source.readsToFail = 1
        source.tick()
        await settle { model.failure != nil }
        XCTAssertEqual(source.reads, before + 1)
        await settle { source.reads >= before + 2 && model.failure == nil }
        XCTAssertEqual(source.reads, before + 2)
        XCTAssertNil(model.failure)
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

    func testAnEqualLiveReadPublishesNothingAndKeepsTheSnapshot() async throws {
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
        try XCTUnwrap(source.resumeRead).resume()
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

    func testSlowTickAndWriteAcknowledgmentWhileTheRefreshIsStillRunning() async {
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
        // The write starts while the tick's read is held. Its preview and its pending flag outlive that read.
        source.holdWrite = true
        let acknowledged = expectation(description: "Write acknowledged during the held refresh")
        let write = Task {
            let saved = await model.write(.accept(ref: "w_spot0002"))
            XCTAssertTrue(saved)
            acknowledged.fulfill()
        }
        await settle { source.resumeWrite != nil }
        XCTAssertTrue(model.pending.contains("w_spot0002"))
        source.resumeRead?.resume()
        await settle { model.live == .live }
        XCTAssertTrue(model.pending.contains("w_spot0002"))
        XCTAssertEqual(model.snapshot?.triage.first { $0.ref == "w_spot0002" }?.state, "open")
        source.holdNextRead = true
        source.snapshotValue = source.snapshotValue.previewing(["w_spot0002": "open"])
        source.resumeWrite?.resume()
        // The service's answer ends the write. Its own readback is still held and the acknowledged state stays shown.
        await settle { source.resumeRead != nil }
        await fulfillment(of: [acknowledged], timeout: 1)
        XCTAssertNotNil(source.resumeRead)
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.snapshot?.triage.first { $0.ref == "w_spot0002" }?.state, "open")
        source.resumeRead?.resume()
        await write.value
        await model.finishCurrentRead()
        XCTAssertTrue(model.pending.isEmpty)
        XCTAssertEqual(model.snapshot?.triage.first { $0.ref == "w_spot0002" }?.state, "open")
    }

    func testWorkNoticeHistoryEvictsBothCopiesOfTheOldestOutcome() async {
        let model = WorkScreenModel(source: FakeWorkSource(fixture()))
        model.project = "App"
        for index in 0..<9 {
            _ = await model.write(.accept(ref: "w_fixture\(index)"))
        }
        XCTAssertEqual(model.notices.count, 8)
        XCTAssertEqual(model.notices.first?.ref, "w_fixture1")
        XCTAssertEqual(model.noticeStack.notices.count, 8)
        model.clearNotice()
        XCTAssertEqual(model.notices.last?.ref, "w_fixture7")
        XCTAssertEqual(model.noticeStack.notices.count, 7)
    }

    func testTheItemsPaneShowsHandoffsSpottedByTypeAndReopened() throws {
        let view = WorkItemsView(snapshot: fixture(), pending: [], expandAll: true) { _ in false }
            .frame(width: 760)
        let text = try render(view, name: "work-items")
        for expected in ["Handoffs and epics", "Build the work items", "2 of 3 open", "The hub's Work screen",
                         "Spotted", "1 bug", "The widget counts lag a write", "1 idea",
                         "Reopened, nobody working", "Parity test misses", "Issue desk", "TASK-42", "Remote drift",
                         "BUG-17", "Local drift", "mirror", "COPY-18", "Held", "PLAN-12", "Synced"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected) in:\n\(text)")
        }
        for verb in ["Accept", "Finish", "Drop", "Reopen"] { XCTAssertTrue(text.contains(verb), text) }
        XCTAssertFalse(text.contains("w_spot0001"), text)
        XCTAssertFalse(text.contains("h_build001"), text)
    }

    func testARefusedWriteKeepsItsOwnNoticeAndDoesNotReportSuccessToTheReasonForm() async throws {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source)
        model.activate()
        defer { model.deactivate() }
        await settle { model.snapshot != nil }
        source.writeResult = WorkActionOutcome(ok: false, message: "Fixture backend refused the write")
        let refused = await model.write(.drop(ref: "w_spot0001", why: "Superseded by a new design"))
        XCTAssertFalse(refused)
        let first = try XCTUnwrap(model.notices.first)
        XCTAssertEqual(first.failure?.log, source.writeResult?.message)
        XCTAssertFalse(first.outcome.message.contains("Fixture backend"))
        source.writeResult = nil
        let saved = await model.write(.accept(ref: "w_spot0002"))
        XCTAssertTrue(saved)
        XCTAssertEqual(model.notices.map(\.ref), ["w_spot0001", "w_spot0002"])
        model.clearNotice(first.id)
        XCTAssertEqual(model.notices.map(\.ref), ["w_spot0002"])
    }

    func testReopenDistinguishesTheStateChangeFromDelivery() throws {
        for (outcome, expected) in [("delivered", "received"), ("queued", "queued"), ("nobody-alive", "No worker"), ("unknown", "could not be confirmed")] {
            let receipt = try JSONDecoder().decode(LiveWorkSource.ReopenData.self, from: Data("{\"receipt\":{\"outcome\":\"\(outcome)\"}}".utf8))
            XCTAssertTrue(receipt.message.hasPrefix("Reopened"))
            XCTAssertTrue(receipt.message.contains(expected))
        }
    }

    func testReasonDraftClearsOnlyAfterAcceptanceOfTheTextStillInTheEditor() async {
        var draft = "  Evidence from the test\n"
        let binding = Binding(get: { draft }, set: { draft = $0 })
        let refused = await WorkReasonButton.saveDraft(binding) { value in
            XCTAssertEqual(value, "Evidence from the test")
            return false
        }
        XCTAssertFalse(refused)
        XCTAssertEqual(draft, "  Evidence from the test\n")
        let first = await WorkReasonButton.saveDraft(binding) { _ in draft = "New evidence"; return true }
        XCTAssertTrue(first)
        XCTAssertEqual(draft, "New evidence")
        let second = await WorkReasonButton.saveDraft(binding) { _ in true }
        XCTAssertTrue(second)
        XCTAssertTrue(draft.isEmpty)
    }

    func testFoldingAHandoffKeepsItsOwnPairingVisible() throws {
        let text = try render(WorkItemsView(snapshot: fixture(), pending: []) { _ in false }.frame(width: 600),
                              name: "work-items-folded")
        XCTAssertTrue(text.contains("PLAN-12"), text)
        XCTAssertFalse(text.contains("TASK-42"), text)
    }

    func testFinishedTasksAndAnEmptyHandoffHaveDifferentSummaries() throws {
        var container = fixture().containers[0]
        container.open = 0
        container.members = container.members.map { row in var row = row; row.state = "done"; return row }
        XCTAssertEqual(container.progressLabel, "3 tasks done")
        container.members[0].state = "dropped"
        XCTAssertEqual(container.progressLabel, "3 tasks closed")
        container.total = 0
        container.members = []
        XCTAssertEqual(container.progressLabel, "No tasks")
    }

    func testLongHandoffListsFoldOnlyWhenTriageWouldBeBuriedAndThePreferenceAllowsIt() throws {
        var crowded = fixture()
        crowded.containers = (1...47).map { index in
            WorkContainerValue(ref: "h_group\(index)", type: "handoff", state: "open",
                               title: "Group \(index)", open: 0, total: 0, members: [])
        }
        XCTAssertTrue(HubWorkSections.startsFolded(crowded, preference: true))
        XCTAssertFalse(HubWorkSections.startsFolded(crowded, preference: false))
        let text = try render(WorkItemsView(snapshot: crowded, pending: [], foldedSections: .constant([WorkItemsView.containersTitle])) { _ in false }
            .frame(width: 600), name: "work-items-triage-first")
        XCTAssertFalse(text.contains("Group 47"), text)
        XCTAssertTrue(text.contains("The widget counts lag a write"), text)
        crowded.triage = []
        XCTAssertFalse(HubWorkSections.startsFolded(crowded, preference: true))
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
        let text = try render(WorkItemsView(snapshot: empty, pending: []) { _ in false }.frame(width: 600), name: "work-items-empty")
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
