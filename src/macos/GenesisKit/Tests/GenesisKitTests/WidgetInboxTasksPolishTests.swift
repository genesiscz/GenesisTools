import AppKit
import Combine
import SwiftUI
import XCTest
@testable import GenesisKit

/// The Tasks module's tick, create and edit paths, and the inbox pieces of the 2026-10-10 polish.
@MainActor
final class WidgetTasksPolishTests: XCTestCase {
    private func task(_ id: String = "t_1_fixture", state: String = "open", revision: Int = 1,
                      title: String = "Water the plants") -> WidgetTask {
        WidgetTask(id: id, number: 1, title: title, summary: title, truncated: false, revision: revision, state: state,
                   updatedTs: "2026-01-01T10:00:00.000Z", blocking: false, owner: nil, sessionId: "fixture",
                   provider: "codex", sessionTitle: "Fixture session",
                   sourceContext: WidgetSourceContext(sessionId: "fixture", agent: "codex", project: "Fixture"))
    }

    private func snapshot(_ tasks: [WidgetTask]) throws -> Data {
        try JSONEncoder().encode(WidgetTaskSnapshot(tasks: tasks, total: tasks.count,
            activeCount: tasks.filter { ["open", "acknowledged"].contains($0.state) }.count, truncated: false,
            sourcePath: "/fixture/tasks/decisions.jsonl", sourceStamp: "fixture", projects: ["Fixture"],
            sessions: [.init(id: "codex:fixture", title: "Fixture session")]))
    }

    private func saved(_ task: WidgetTask, action: String) throws -> Data {
        try JSONEncoder().encode(WidgetTaskSaved(task: task, receipt: .init(
            id: task.id, action: action, state: task.state, revision: task.revision, at: task.updatedTs, saved: true)))
    }

    private func updated(_ before: WidgetTask, to state: String, action: String, at: String) throws -> Data {
        var after = before
        after.state = state
        after.updatedTs = at
        return try JSONEncoder().encode(WidgetTaskUpdate(task: after, receipt: .init(
            id: before.id, action: action, from: before.state, state: state, revision: before.revision, at: at,
            saved: true)))
    }

    private func settled(_ store: WidgetTasksStore, timeout: TimeInterval = 3) async {
        let deadline = Date().addingTimeInterval(timeout)
        while (store.isMutating || store.isLoading || store.isCreating) && Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(store.isMutating || store.isLoading || store.isCreating, "store did not settle in time")
    }

    func testATickShowsAtOnceRunsBesideAnotherAndStaysVisibleWithUndo() async throws {
        let first = task()
        let second = task("t_2_fixture", title: "Feed the cat")
        var ledger = [first, second]
        var released: [String: CheckedContinuation<Void, Never>] = [:]
        var calls: [[String]] = []
        let store = WidgetTasksStore(request: { @MainActor args in
            calls.append(args)
            if args.first == "update", let id = args.dropFirst().first {
                await withCheckedContinuation { released[id] = $0 }
                let before = ledger.first { $0.id == id }!
                let target = args[args.firstIndex(of: "--action")! + 1] == "complete" ? "implemented" : "open"
                let at = "2026-01-01T10:00:0\(target == "open" ? 2 : 1).000Z"
                ledger = ledger.map { $0.id == id ? { var t = $0; t.state = target; t.updatedTs = at; return t }($0) : $0 }
                return try self.updated(before, to: target, action: args[args.firstIndex(of: "--action")! + 1], at: at)
            }
            return try self.snapshot(ledger.filter { ["open", "acknowledged"].contains($0.state) })
        })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        await settled(store)
        XCTAssertEqual(store.tasks.map(\.id), [first.id, second.id])

        store.perform(.complete, on: first)
        store.perform(.complete, on: second)
        XCTAssertEqual(store.shownState(first), "implemented", "the tick shows before the ledger answers")
        XCTAssertEqual(store.mutatingIDs, [first.id, second.id], "two tasks are saved side by side")
        while released.count < 2 { try await Task.sleep(for: .milliseconds(5)) }
        released.values.forEach { $0.resume() }
        released = [:]
        await settled(store)

        XCTAssertTrue(store.tasks.isEmpty, "completed tasks leave the Active list")
        XCTAssertEqual(Set(store.recent.map(\.id)), [first.id, second.id], "and stay on screen to undo")
        XCTAssertEqual(store.undo?.action, .reopen)
        let undo = try XCTUnwrap(store.undo)
        store.perform(undo.action, on: undo.task)
        while released.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        released.values.forEach { $0.resume() }
        await settled(store)
        XCTAssertFalse(store.recent.contains { $0.id == undo.task.id }, "an undone task returns to the list")
        XCTAssertTrue(store.tasks.contains { $0.id == undo.task.id })
        XCTAssertEqual(calls.filter { $0.first == "update" }.count, 3)
    }

    func testCreateSendsTheDraftClearsItsTextAndWidensFiltersThatWouldHideTheTask() async throws {
        var created = task("t_3_fixture", title: "Review the draft")
        created.summary = "Read it twice."
        var calls: [[String]] = []
        let store = WidgetTasksStore(request: { @MainActor args in
            calls.append(args)
            if args.first == "create" { return try self.saved(created, action: "create") }
            return try self.snapshot(args.contains("completed") ? [] : [created])
        })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        store.scope = "completed"
        await settled(store)
        store.draft.title = "  Review the draft "
        store.draft.details = "Read it twice."
        store.draft.session = "codex:fixture"
        store.draft.sessionTitle = "Fixture session"
        store.draft.project = "Fixture"
        store.create()
        await settled(store)
        XCTAssertEqual(calls.first { $0.first == "create" }, ["create", "--json", "--title", "Review the draft",
            "--details", "Read it twice.", "--session", "codex:fixture", "--session-title", "Fixture session",
            "--project", "Fixture"])
        XCTAssertEqual(store.draft.title, "")
        XCTAssertEqual(store.draft.details, "")
        XCTAssertEqual(store.draft.session, "codex:fixture", "the session stays for the next task")
        XCTAssertEqual(store.scope, "active", "a new task never lands in a view that hides it")
        XCTAssertEqual(store.tasks.map(\.id), [created.id])
        XCTAssertEqual(store.receipt, "Added: Review the draft")

        store.draft.title = "   "
        store.create()
        XCTAssertFalse(store.isCreating, "a blank title is never sent")
    }

    func testEditCarriesTheShownVersionAndOnlyOpenTasksAreEditable() async throws {
        let original = task()
        var edited = original
        edited.title = "Water every plant"
        edited.revision = 2
        var calls: [[String]] = []
        let store = WidgetTasksStore(request: { @MainActor args in
            calls.append(args)
            if args.first == "edit" { return try self.saved(edited, action: "edit") }
            return try self.snapshot([edited])
        })
        defer { store.stop() }
        store.edit(original, title: "Water every plant", details: "")
        await settled(store)
        XCTAssertEqual(calls.first { $0.first == "edit" }, ["edit", original.id, "--json", "--title", "Water every plant",
            "--revision", "1", "--state", "open", "--updated-at", original.updatedTs, "--session", "fixture",
            "--provider", "codex"])
        XCTAssertEqual(store.receipt, "Saved: Water every plant")
        XCTAssertFalse(task(state: "acknowledged").editable)
        XCTAssertEqual(task(state: "implemented").toggleAction, .reopen)
        XCTAssertEqual(task(state: "acknowledged").toggleAction, .complete)
        XCTAssertNil(WidgetTaskAction.returning(to: "acknowledged"))
    }

    func testSessionChoicesPutLiveLeadSessionsFirstAndSkipSubagents() async throws {
        let target = WidgetTarget(hostId: "local", provider: "claude", sessionId: "live", sourceHome: "", cwd: "/fixture")
        let live = WidgetSession(key: "live", target: target, title: "Live lead", project: "Fixture", activityAt: 20,
                                 status: "working", pinned: true, visible: true, hiddenByFilter: false)
        var worker = live
        worker.key = "worker"
        worker.target.sessionId = "worker"
        worker.agentId = "agent-1"
        let store = WidgetTasksStore(request: { _ in try self.snapshot([self.task()]) }, sessions: { [worker, live] })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        await settled(store)
        XCTAssertEqual(store.sessionChoices().map(\.id), ["claude:live", "codex:fixture"])
        XCTAssertEqual(store.sessionChoices().first?.cwd, "/fixture")
    }
}

final class WidgetInboxPolishTests: XCTestCase {
    func testBlockMarkdownKeepsHeadingsListsCodeQuotesAndTables() {
        let blocks = KitMarkdown.parse("""
        # Summary
        The fix **works**.

        - first
          - nested
        1. step one
        - [x] done

        ```swift
        let a = 1
        # not a heading
        ```
        > quoted
        | a | b |
        |---|---|
        ---
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Summary"),
            .paragraph("The fix **works**."),
            .item(marker: "•", depth: 0, text: "first"),
            .item(marker: "•", depth: 1, text: "nested"),
            .item(marker: "1.", depth: 0, text: "step one"),
            .item(marker: "☑", depth: 0, text: "done"),
            .code(language: "swift", text: "let a = 1\n# not a heading"),
            .quote("quoted"),
            .table("| a | b |\n|---|---|"),
            .rule,
        ])
        XCTAssertEqual(KitMarkdown.parse("```\nunclosed"), [.code(language: "", text: "unclosed")])
        XCTAssertEqual(KitMarkdown.blocks("#notaheading"), [.paragraph("#notaheading")])
    }

    func testChoiceTextDropsTheLetterTheBadgeAlreadyShows() {
        let choice = { (id: String, title: String) in WidgetChoice(id: id, title: title, recommended: false) }
        XCTAssertEqual(LiveWidgetView.choiceText(choice("a", "a) Record the names")), "Record the names")
        XCTAssertEqual(LiveWidgetView.choiceText(choice("b", "(B) Raise the cap")), "Raise the cap")
        XCTAssertEqual(LiveWidgetView.choiceText(choice("c", "c. Commit")), "Commit")
        XCTAssertEqual(LiveWidgetView.choiceText(choice("a", "Abstain")), "Abstain", "a word that starts with the letter stays")
        XCTAssertEqual(LiveWidgetView.choiceText(choice("b", "a) mismatched letter")), "a) mismatched letter")
    }

    func testCollapsedRowPreviewIsTheFirstLineOfProse() {
        XCTAssertEqual(LiveWidgetView.previewLine("# Title\n\nBody"), "Title")
        XCTAssertEqual(LiveWidgetView.previewLine("\n---\n- **Done** with `x`"), "Done with x")
        XCTAssertNil(LiveWidgetView.previewLine("\n\n"))
    }

    func testOverflowEdgesFollowTheContentFrame() {
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: 0, y: 0, width: 10, height: 100), viewportHeight: 200),
                       ScrollOverflow(above: false, below: false))
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: 0, y: 0, width: 10, height: 500), viewportHeight: 200),
                       ScrollOverflow(above: false, below: true))
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: 0, y: -120, width: 10, height: 500), viewportHeight: 200),
                       ScrollOverflow(above: true, below: true))
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: 0, y: -300, width: 10, height: 500), viewportHeight: 200),
                       ScrollOverflow(above: true, below: false))
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: 0, y: 0, width: 10, height: 500), viewportHeight: 0),
                       ScrollOverflow(above: false, below: false), "an unmeasured viewport claims nothing")
        // A horizontal strip: `above` is the leading edge, `below` the trailing one.
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: 0, y: 0, width: 900, height: 20), viewportWidth: 400),
                       ScrollOverflow(above: false, below: true))
        XCTAssertEqual(ScrollOverflow(content: CGRect(x: -500, y: 0, width: 900, height: 20), viewportWidth: 400),
                       ScrollOverflow(above: true, below: false))
    }

    @MainActor
    func testRailViewportFadesOnlyTheEdgesWithMoreContent() {
        let viewport = OverlayScrollViewport<AnyView>.Viewport(
            content: AnyView(VStack(spacing: 0) { ForEach(0..<40) { Text("Row \($0)").frame(height: 20) } }), width: 44)
        viewport.frame = CGRect(x: 0, y: 0, width: 44, height: 200)
        viewport.layoutSubtreeIfNeeded()
        viewport.updateFade()
        XCTAssertEqual(viewport.overflow, ScrollOverflow(above: false, below: true))
        viewport.contentView.scroll(to: CGPoint(x: 0, y: 300))
        viewport.reflectScrolledClipView(viewport.contentView)
        XCTAssertEqual(viewport.overflow, ScrollOverflow(above: true, below: true))
        viewport.contentView.scroll(to: CGPoint(x: 0, y: viewport.host.frame.height - 200))
        viewport.reflectScrolledClipView(viewport.contentView)
        XCTAssertEqual(viewport.overflow, ScrollOverflow(above: true, below: false))
    }

    @MainActor
    func testActiveSessionsCountLeadSessionsThatWorkOrWait() {
        let target = WidgetTarget(hostId: "local", provider: "codex", sessionId: "s", sourceHome: "", cwd: "/fixture")
        func session(_ key: String, _ status: String, agent: String? = nil, visible: Bool = true) -> WidgetSession {
            var value = WidgetSession(key: key, target: target, title: key, project: "Fixture", activityAt: 1,
                                      status: status, pinned: true, visible: visible, hiddenByFilter: false)
            value.agentId = agent
            return value
        }
        var roster = WidgetSessionRoster()
        roster.update([session("a", "working"), session("b", "waiting"), session("c", "recent"),
                       session("d", "working", agent: "worker"), session("e", "working", visible: false)]
            + (0..<950).map { session("old-\($0)", "finished") })
        XCTAssertEqual(roster.active, 2, "952 sessions, 2 of them active: the preview shows 2, not 952")
    }
}
