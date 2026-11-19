import Combine
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

@MainActor
private final class FakeWorkSource: WorkSource {
    var snapshotValue: WorkSnapshotValue
    var notifyRows: [WorkNotifyRow] = []
    var performed: [WorkScreenAction] = []
    var reads = 0
    private var continuation: AsyncStream<Void>.Continuation?

    init(_ snapshot: WorkSnapshotValue) { snapshotValue = snapshot }

    func projects() async throws -> [String] { ["App", "Other"] }
    func detail(ref: String) async throws -> WorkItemDetail { throw WorkSourceError("No fixture item \(ref)") }
    func snapshot(project: String) async throws -> WorkSnapshotValue { reads += 1; return snapshotValue }
    func notify(project: String) async throws -> [WorkNotifyRow] { notifyRows }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        performed.append(action)
        return WorkActionOutcome(ok: true, message: "\(action.done): \(action.ref)")
    }
    func changes() -> AsyncStream<Void> { AsyncStream { continuation = $0 } }
    func tick() { continuation?.yield(()) }
}

@MainActor
final class WorkScreenTests: XCTestCase {
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

        await awaitSnapshot(model) {
            for _ in 0..<20 { source.tick() }
        }
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(source.reads - first, 1, "twenty changes in 0.1 s are one reload")
        XCTAssertEqual(model.changeReloads, 1)

        model.setVisible(false)
        let hidden = source.reads
        for _ in 0..<5 { source.tick() }
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(source.reads, hidden, "nothing reloads while nobody can see the screen")

        await awaitSnapshot(model) { model.setVisible(true) }
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(source.reads - hidden, 1, "the first look reads what changed meanwhile, once")

        model.setVisible(false)
        model.setVisible(true)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(source.reads - hidden, 1, "a look after no change reads nothing")
        model.deactivate()
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
        let text = try render(WorkItemsView(snapshot: crowded, pending: [], foldedSections: .constant([WorkItemsView.containersTitle])) { _ in }
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
        let text = try render(WorkItemsView(snapshot: empty, pending: []) { _ in }.frame(width: 600), name: "work-items-empty")
        XCTAssertTrue(text.contains("No open handoff or epic in Quiet"), text)
        XCTAssertTrue(text.contains("Nothing spotted waits for a look"), text)
    }

    func testTheNotifyGridShowsEachLevelAndItsLayer() throws {
        let cell = { (action: String, level: String, from: String) in
            WorkNotifyCell(action: action, level: level, from: from,
                           layers: [.init(layer: "default", level: "list"), .init(layer: "config.project", level: from == "default" ? nil : level)])
        }
        let rows = [
            WorkNotifyRow(type: "bug", cells: [cell("spotted", "inbox", "config.project"), cell("finished", "list", "default"),
                                                cell("reopened", "banner", "config.global")]),
            WorkNotifyRow(type: "task", cells: [cell("spotted", "list", "default"), cell("finished", "off", "config.project"),
                                                 cell("reopened", "list", "default")]),
        ]
        let text = try render(WorkNotifyGridView(project: "App", rows: rows).frame(width: 640), name: "work-notify-grid")
        for expected in ["spotted", "finished", "inbox", "banner", "off", "tools work config set", "projects.App"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected) in:\n\(text)")
        }
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
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
