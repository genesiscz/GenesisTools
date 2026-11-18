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
                                       WorkRowValue(ref: "w_tracker01", state: "open", type: "task", title: "Pull from the tracker", slot: "t3"),
                                   ]),
            ],
            triage: [
                WorkTriageValue(ref: "w_spot0001", group: "spotted", type: "bug", state: "spotted",
                                title: "The widget counts lag a write", where: "src/hub/lib/widget/tasks.ts:120",
                                why: "the cache key misses a pairing change", severity: "high"),
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

    func testTheModelLoadsTheFirstProjectReloadsOnAChangeAndRunsAWrite() async throws {
        let source = FakeWorkSource(fixture())
        let model = WorkScreenModel(source: source)
        model.activate()
        await settle { model.snapshot != nil }
        XCTAssertEqual(model.project, "App")
        XCTAssertEqual(model.snapshot?.spotted.count, 2)
        XCTAssertEqual(model.snapshot?.reopened.count, 1)

        let before = source.reads
        source.tick()
        await settle { source.reads > before }
        XCTAssertGreaterThan(source.reads, before, "a change of the store reloads the screen")

        await model.perform(.drop(ref: "w_spot0002", why: "not worth it"))
        XCTAssertEqual(source.performed, [.drop(ref: "w_spot0002", why: "not worth it")])
        XCTAssertEqual(model.notice, WorkActionOutcome(ok: true, message: "Dropped: w_spot0002"))
        XCTAssertTrue(model.pending.isEmpty)
        model.deactivate()
    }

    func testTheItemsPaneShowsHandoffsSpottedByTypeAndReopened() throws {
        let view = WorkItemsView(snapshot: fixture(), pending: [], expandAll: true) { _ in }
            .frame(width: 760)
        let text = try render(view, name: "work-items")
        for expected in ["Handoffs and epics", "Build the work items", "2 of 3 open", "The hub's Work screen",
                         "Spotted", "1 bug", "The widget counts lag a write", "1 idea",
                         "Reopened, nobody working", "Parity test misses"] {
            XCTAssertTrue(text.contains(expected), "missing \(expected) in:\n\(text)")
        }
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
        for expected in ["spotted", "finished", "inbox", "banner", "off", "tools work config set projects.App"] {
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
