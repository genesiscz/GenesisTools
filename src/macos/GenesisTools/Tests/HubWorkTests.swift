import GenesisKit
import SwiftUI
import XCTest
@testable import GenesisToolsHub

/// A store the Work mode reads in place of the actions service.
@MainActor
private final class FakeWorkSource: WorkSource {
    var performed: [WorkScreenAction] = []

    func projects() async throws -> [String] { ["App", "Quiet"] }
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
    func testTheWorkModeIsAModeOfTheHub() {
        XCTAssertTrue(HubMode.allCases.contains(.work))
        XCTAssertEqual(HubMode.work.title, "Work")
    }

    /// The whole Work main pane in a real window (the menu button's window reader is an AppKit view, which an image
    /// renderer cannot draw): the header names the project and its counts, the rows and their buttons draw. A handoff
    /// starts folded with its open count (the real project has 35 of them), so its tasks are not on screen yet.
    func testTheWorkPaneDrawsTheProjectInARealWindow() async throws {
        let model = HubWorkModel(source: FakeWorkSource())
        model.activate()
        let deadline = Date().addingTimeInterval(3)
        while model.screen.snapshot == nil && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.screen.project, "App")
        XCTAssertEqual(model.navSelection, "App")

        let view = HStack(spacing: 0) {
            WorkProjectsList(screen: model.screen, filter: "").frame(width: 200)
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
