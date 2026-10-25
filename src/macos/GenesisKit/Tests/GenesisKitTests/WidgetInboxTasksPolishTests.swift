import AppKit
import Combine
import SwiftUI
import XCTest
@testable import GenesisKitBase
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
            // As the CLI: `--scope all` (the recent rows' reread) returns every state.
            return try self.snapshot(args.contains("all") ? ledger : ledger.filter { ["open", "acknowledged"].contains($0.state) })
        })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        await settled(store)
        XCTAssertEqual(store.tasks.map(\.id), [first.id, second.id])

        store.perform(.complete, on: first)
        store.perform(.complete, on: second)
        XCTAssertEqual(store.shownState(first), "implemented", "the tick shows before the ledger answers")
        XCTAssertEqual(store.mutatingIDs, [first.id, second.id], "two tasks are saved side by side")
        for _ in 0 ..< 400 where released.count < 2 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(released.count, 2, "both updates reached the ledger")
        released.values.forEach { $0.resume() }
        released = [:]
        await settled(store)

        XCTAssertTrue(store.tasks.isEmpty, "completed tasks leave the Active list")
        XCTAssertEqual(Set(store.recent.map(\.id)), [first.id, second.id], "and stay on screen to undo")
        XCTAssertEqual(store.undo?.action, .reopen)
        let undo = try XCTUnwrap(store.undo)
        store.perform(undo.action, on: undo.task)
        for _ in 0 ..< 400 where released.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertFalse(released.isEmpty, "the undo reached the ledger")
        released.values.forEach { $0.resume() }
        await settled(store)
        XCTAssertFalse(store.recent.contains { $0.id == undo.task.id }, "an undone task returns to the list")
        XCTAssertTrue(store.tasks.contains { $0.id == undo.task.id })
        XCTAssertEqual(calls.filter { $0.first == "update" }.count, 3)
    }

    func testARecentRowFollowsLaterLedgerChangesAndLeavesWhenItIsGone() async throws {
        let done = "2026-01-01T10:00:01.000Z"
        var ledger = [task()]
        let store = WidgetTasksStore(request: { @MainActor args in
            if args.first == "update", let id = args.dropFirst().first {
                let before = ledger.first { $0.id == id }!
                ledger = ledger.map { $0.id == id ? { var t = $0; t.state = "implemented"; t.updatedTs = done; return t }($0) : $0 }
                return try self.updated(before, to: "implemented", action: "complete", at: done)
            }
            return try self.snapshot(args.contains("all") ? ledger : ledger.filter { ["open", "acknowledged"].contains($0.state) })
        })
        defer { store.stop() }
        func until(_ condition: () -> Bool) async throws {
            for _ in 0 ..< 300 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
            XCTAssertTrue(condition(), "condition never became true")
        }
        store.visibilityChanged(.expanded)
        await settled(store)
        store.perform(.complete, on: ledger[0])
        await settled(store)
        XCTAssertEqual(store.recent.map(\.state), ["implemented"], "a ticked task stays on screen to undo")
        XCTAssertNotNil(store.undo)

        // Another surface dismisses it: the row shows that version, and the undo of the old one goes.
        ledger[0].state = "dismissed"
        ledger[0].updatedTs = "2026-01-01T10:05:00.000Z"
        store.sourceChanged()
        try await until { store.recent.first?.state == "dismissed" }
        XCTAssertNil(store.undo, "an undo against the old version would be refused by the ledger")

        // Then it is deleted from the ledger: the row leaves.
        ledger = []
        store.sourceChanged()
        try await until { store.recent.isEmpty }
    }

    func testAnInProgressTaskTickedDoneGoesBackToInProgressByUndoAndByItsBox() async throws {
        let first = task(state: "acknowledged")
        let second = task("t_2_fixture", state: "acknowledged", title: "Feed the cat")
        var ledger = [first, second]
        var updates: [(action: String, state: String, updatedAt: String)] = []
        var clock = 0
        let targets = ["complete": "implemented", "reopen": "open", "acknowledge": "acknowledged"]
        let store = WidgetTasksStore(request: { @MainActor args in
            if args.first == "update", let id = args.dropFirst().first {
                let value = { (flag: String) in args[args.firstIndex(of: flag)! + 1] }
                let action = value("--action")
                updates.append((action, value("--state"), value("--updated-at")))
                let before = ledger.first { $0.id == id }!
                let target = targets[action]!
                clock += 1
                let at = "2026-01-01T10:00:0\(clock).000Z"
                ledger = ledger.map { $0.id == id ? { var t = $0; t.state = target; t.updatedTs = at; return t }($0) : $0 }
                return try self.updated(before, to: target, action: action, at: at)
            }
            // As the CLI: `--scope all` (the recent rows' reread) returns every state.
            return try self.snapshot(args.contains("all") ? ledger : ledger.filter { ["open", "acknowledged"].contains($0.state) })
        })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        await settled(store)

        store.perform(.complete, on: first)
        await settled(store)
        let undo = try XCTUnwrap(store.undo, "a task done from in progress offers Undo")
        XCTAssertEqual(undo.action, .reopen)
        XCTAssertEqual(undo.then, .acknowledge)
        store.perform(undo.action, on: undo.task, then: undo.then)
        for _ in 0 ..< 400 where ledger.first?.state != "acknowledged" { try await Task.sleep(for: .milliseconds(5)) }
        await settled(store)
        XCTAssertEqual(updates.map(\.action), ["complete", "reopen", "acknowledge"])
        guard updates.count == 3 else {
            XCTFail("the undo sent \(updates.count - 1) updates, not 2")
            return
        }
        XCTAssertEqual(updates[2].state, "open")
        XCTAssertEqual(updates[2].updatedAt, "2026-01-01T10:00:02.000Z",
                       "the second step goes against the version the first one returned")
        XCTAssertEqual(store.tasks.first { $0.id == first.id }?.state, "acknowledged", "back in progress, not open")

        // The "Just changed" row's box does the same.
        store.perform(.complete, on: second)
        await settled(store)
        let row = try XCTUnwrap(store.recent.first { $0.id == second.id })
        store.toggle(row)
        for _ in 0 ..< 400 where ledger.last?.state != "acknowledged" { try await Task.sleep(for: .milliseconds(5)) }
        await settled(store)
        XCTAssertEqual(updates.suffix(3).map(\.action), ["complete", "reopen", "acknowledge"])
        XCTAssertEqual(store.tasks.first { $0.id == second.id }?.state, "acknowledged")
    }

    func testARowAnotherSurfaceChangedIsNotUndoneAsThisStoresTick() async throws {
        var ledger = [task(state: "acknowledged")]
        var actions: [String] = []
        let targets = ["complete": "implemented", "reopen": "open", "acknowledge": "acknowledged"]
        let store = WidgetTasksStore(request: { @MainActor args in
            if args.first == "update", let id = args.dropFirst().first {
                let action = args[args.firstIndex(of: "--action")! + 1]
                actions.append(action)
                let before = ledger.first { $0.id == id }!
                let target = targets[action]!
                let at = "2026-01-01T10:00:0\(actions.count).000Z"
                ledger = ledger.map { $0.id == id ? { var t = $0; t.state = target; t.updatedTs = at; return t }($0) : $0 }
                return try self.updated(before, to: target, action: action, at: at)
            }
            return try self.snapshot(args.contains("all") ? ledger : ledger.filter { ["open", "acknowledged"].contains($0.state) })
        })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        await settled(store)
        store.perform(.complete, on: ledger[0])
        await settled(store)
        XCTAssertEqual(store.recent.map(\.state), ["implemented"])

        // Another surface dismisses it after this store's tick; the row shows that version.
        ledger[0].state = "dismissed"
        ledger[0].updatedTs = "2026-01-01T10:05:00.000Z"
        store.sourceChanged()
        for _ in 0 ..< 300 where store.recent.first?.state != "dismissed" { try await Task.sleep(for: .milliseconds(10)) }
        let row = try XCTUnwrap(store.recent.first { $0.state == "dismissed" })

        // Its box reopens the dismissed task like any finished row; it does not undo the tick back to in progress.
        store.toggle(row)
        for _ in 0 ..< 400 where ledger[0].state == "dismissed" { try await Task.sleep(for: .milliseconds(5)) }
        await settled(store)
        for _ in 0 ..< 60 where actions.count < 3 { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(actions, ["complete", "reopen"])
        XCTAssertEqual(ledger[0].state, "open")
    }

    func testAChangeAnsweringAfterTheViewChangedAddsNoRowToTheViewShownNow() async throws {
        let first = task()
        let second = task("t_2_fixture", title: "Feed the cat")
        var ledger = [first, second]
        var released: [String: CheckedContinuation<Void, Never>] = [:]
        let store = WidgetTasksStore(request: { @MainActor args in
            if args.first == "update", let id = args.dropFirst().first {
                await withCheckedContinuation { released[id] = $0 }
                let before = ledger.first { $0.id == id }!
                let at = "2026-01-01T10:00:01.000Z"
                ledger = ledger.map { $0.id == id ? { var t = $0; t.state = "implemented"; t.updatedTs = at; return t }($0) : $0 }
                return try self.updated(before, to: "implemented", action: "complete", at: at)
            }
            return try self.snapshot(args.contains("all") ? ledger : ledger.filter { ["open", "acknowledged"].contains($0.state) })
        })
        defer { store.stop() }
        store.visibilityChanged(.expanded)
        await settled(store)

        // Ticked in the Fixture project, answered after the user switched to another project.
        store.perform(.complete, on: first)
        for _ in 0 ..< 400 where released[first.id] == nil { try await Task.sleep(for: .milliseconds(5)) }
        _ = try XCTUnwrap(released[first.id], "the tick reached the ledger")
        store.project = "Elsewhere"
        released.removeValue(forKey: first.id)?.resume()
        await settled(store)
        XCTAssertFalse(store.recent.contains { $0.id == first.id }, "no row from another project's view")

        // Ticked, answered while the module is hidden.
        store.project = ""
        await settled(store)
        store.perform(.complete, on: second)
        for _ in 0 ..< 400 where released[second.id] == nil { try await Task.sleep(for: .milliseconds(5)) }
        _ = try XCTUnwrap(released[second.id], "the tick reached the ledger")
        store.visibilityChanged(nil)
        released.removeValue(forKey: second.id)?.resume()
        await settled(store)
        XCTAssertTrue(store.recent.isEmpty, "a hidden module gets no rows back")
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
        var excerpt = task()
        excerpt.truncated = true
        XCTAssertFalse(excerpt.editable, "an excerpt saved as the task's text would cut the rest of it")
        XCTAssertEqual(task(state: "implemented").toggleAction, .reopen)
        XCTAssertEqual(task(state: "acknowledged").toggleAction, .complete)
        XCTAssertEqual(WidgetTaskAction.returning(to: "acknowledged"), [.reopen, .acknowledge],
                       "no move goes from done straight to in progress")
        XCTAssertEqual(WidgetTaskAction.returning(to: "open"), [.reopen])
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

    func testAnEditTheLedgerRefusesLeavesTheEditorOpenAndASavedOneClosesIt() async throws {
        let original = task()
        var edited = original
        edited.title = "Water every plant"
        edited.revision = 2
        var refuse = true
        let store = WidgetTasksStore(request: { @MainActor args in
            if args.first == "edit" {
                if refuse { throw ToolsBridgeError.refused("The task changed since it was shown.") }
                return try self.saved(edited, action: "edit")
            }
            return try self.snapshot([refuse ? original : edited])
        })
        defer { store.stop() }
        var closed = 0
        store.edit(original, title: "Water every plant", details: "") { _ in closed += 1 }
        await settled(store)
        XCTAssertEqual(closed, 0, "a refused edit closed the editor, and the user's text went with it")
        XCTAssertNotNil(store.error)

        refuse = false
        var savedRevisions: [Int] = []
        store.edit(original, title: "Water every plant", details: "") { saved in
            closed += 1
            savedRevisions.append(saved.revision)
        }
        await settled(store)
        XCTAssertEqual(closed, 1, "a saved edit closes the editor")
        XCTAssertEqual(savedRevisions, [2], "and hands over the task as the ledger saved it")
        XCTAssertEqual(store.receipt, "Saved: Water every plant")
    }

    /// A store whose edit request waits until the test lets it answer, so the editor can be used meanwhile.
    private final class HeldEdit {
        var release: CheckedContinuation<Void, Never>?
    }

    private func storeHoldingEdits(_ held: HeldEdit, saved edited: WidgetTask) -> WidgetTasksStore {
        WidgetTasksStore(request: { @MainActor args in
            if args.first == "edit" {
                await withCheckedContinuation { held.release = $0 }
                return try self.saved(edited, action: "edit")
            }
            return try self.snapshot([edited])
        })
    }

    private func untilHeld(_ held: HeldEdit) async {
        for _ in 0..<400 where held.release == nil {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertNotNil(held.release, "the edit request never reached the ledger")
    }

    func testTextTypedWhileASaveIsInFlightSurvivesItsConfirmation() async throws {
        let original = task()
        var edited = original
        edited.title = "Water every plant"
        edited.revision = 2
        let held = HeldEdit()
        let store = storeHoldingEdits(held, saved: edited)
        defer { store.stop() }
        let session = WidgetTaskEditSession()
        session.begin(original)
        session.title = "Water every plant"
        session.save(in: store)
        await untilHeld(held)
        session.title = "Water every plant daily"
        held.release?.resume()
        await settled(store)

        XCTAssertTrue(session.isOpen, "the confirmation closed an editor that holds text nobody saved")
        XCTAssertEqual(session.title, "Water every plant daily")
        XCTAssertEqual(session.opened?.revision, 2, "the next Save carries the version just saved, not a stale one")
    }

    func testASaveNothingWasTypedDuringClosesTheEditor() async throws {
        let original = task()
        var edited = original
        edited.title = "Water every plant"
        edited.revision = 2
        let held = HeldEdit()
        let store = storeHoldingEdits(held, saved: edited)
        defer { store.stop() }
        let session = WidgetTaskEditSession()
        session.begin(original)
        session.title = "Water every plant"
        session.save(in: store)
        await untilHeld(held)
        held.release?.resume()
        await settled(store)

        XCTAssertFalse(session.isOpen)
    }

    func testAConfirmationNeverClosesAnEditorOpenedAfterTheSaveItAnswers() async throws {
        let original = task()
        var edited = original
        edited.title = "Water every plant"
        edited.revision = 2
        let held = HeldEdit()
        let store = storeHoldingEdits(held, saved: edited)
        defer { store.stop() }
        let session = WidgetTaskEditSession()
        session.begin(original)
        session.title = "Water every plant"
        session.save(in: store)
        await untilHeld(held)
        session.cancel()
        session.begin(original)
        session.title = "Water every plant"
        held.release?.resume()
        await settled(store)

        XCTAssertTrue(session.isOpen, "a Cancel and a reopen during the save made the old save close the new editor")
        XCTAssertEqual(session.opened, original, "and it must not swap the new editor's version either")
        XCTAssertEqual(session.title, "Water every plant")
    }

    func testChoosingAnotherSessionDropsTheProjectThePreviousSessionBrought() {
        let store = WidgetTasksStore(request: { _ in try self.snapshot([]) })
        defer { store.stop() }
        let live = WidgetTaskSessionChoice(id: "claude:live", title: "Live lead", project: "Alpha", cwd: "/fixture/alpha")
        let ledgerOnly = WidgetTaskSessionChoice(id: "codex:old", title: "Old thread", project: "", cwd: "")

        store.chooseSession(live)
        store.chooseSession(ledgerOnly)
        XCTAssertEqual(store.draft.session, "codex:old")
        XCTAssertEqual(store.draft.project, "", "the task would be filed under the previous session's project")
        XCTAssertEqual(store.draft.cwd, "")

        // A project picked by hand is the user's, and a session without one leaves it.
        store.draft.project = "Beta"
        store.chooseSession(ledgerOnly)
        XCTAssertEqual(store.draft.project, "Beta")
        store.chooseSession(live)
        XCTAssertEqual(store.draft.project, "Alpha", "a session's own project replaces it")
        XCTAssertEqual(store.draft.cwd, "/fixture/alpha")
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

    func testALineOfDashesOrEqualsUnderAParagraphMakesItAHeading() {
        XCTAssertEqual(KitMarkdown.parse("Title\n---\nBody"), [.heading(level: 2, text: "Title"), .paragraph("Body")])
        XCTAssertEqual(KitMarkdown.parse("Big\ntitle\n==="), [.heading(level: 1, text: "Big title")])
        XCTAssertEqual(KitMarkdown.parse("Before\n***\nAfter"), [.paragraph("Before"), .rule, .paragraph("After")],
                       "a star rule ends the paragraph instead of joining it")
        XCTAssertEqual(KitMarkdown.parse("Before\n- - -"), [.paragraph("Before"), .rule], "spaced dashes are a rule")
        XCTAssertEqual(KitMarkdown.parse("---"), [.rule])
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

    func testTheHoverListShowsEverySessionThatNeedsYouAndActiveOnesOnlyWhenAsked() {
        let target = WidgetTarget(hostId: "local", provider: "claude", sessionId: "s", sourceHome: "", cwd: "/fixture")
        func session(_ key: String, _ status: String, at: Double, project: String = "Fixture", visible: Bool = true)
            -> WidgetSession {
            WidgetSession(key: key, target: target, title: key, project: project, activityAt: at,
                          status: status, pinned: true, visible: visible, hiddenByFilter: false)
        }
        let sessions = [session("asks", "recent", at: 1, project: "Beta"), session("waits", "waiting", at: 2),
                        session("hidden-asks", "recent", at: 3, visible: false), session("works", "working", at: 9),
                        session("quiet", "finished", at: 8)]
        let inbox = ["asks": WidgetInboxSession(key: "asks", unread: 0, needsAnswer: 2),
                     "hidden-asks": WidgetInboxSession(key: "hidden-asks", unread: 0, needsAnswer: 1)]
        let needs = WidgetModel.previewRows(sessions: sessions, inbox: inbox, filter: "needs-you", sort: "attention")
        XCTAssertEqual(needs.map(\.key), ["hidden-asks", "waits", "asks"],
                       "every session that needs you, also one the rail does not show, newest first")
        let active = WidgetModel.previewRows(sessions: sessions, inbox: inbox, filter: "active", sort: "attention")
        XCTAssertEqual(active.map(\.key), ["hidden-asks", "waits", "asks", "works"], "working ones join after them")
        XCTAssertEqual(WidgetModel.previewRows(sessions: sessions, inbox: inbox, filter: "active", sort: "recent")
            .map(\.key), ["works", "hidden-asks", "waits", "asks"])
        XCTAssertEqual(WidgetModel.previewRows(sessions: sessions, inbox: inbox, filter: "needs-you", sort: "project")
            .first?.key, "asks", "Beta before Fixture")
    }

    func testAnAlertPlaysItsKindsSoundAndFlashesForTheConfiguredTime() throws {
        let decision = WidgetInboxItem(id: "decision:d_1_s", sourceId: "d_1_s", kind: "decision", key: "k", at: 1,
            needsAnswer: true)
        let answer = WidgetInboxItem(id: "answer:a", sourceId: "a", kind: "answer", key: "k", at: 2, needsAnswer: false)
        func prefs(_ json: String) throws -> WidgetPreferences {
            let base = #"{"excludedKeys":[],"projects":[],"sessions":[],"showChanges":true,"placement":"side","side":"right","quietSeconds":15,"voiceProvider":"xai","voiceLanguage":"","#
            return try JSONDecoder().decode(WidgetPreferences.self, from: Data((base + json.dropFirst()).utf8))
        }
        let split = try prefs(#"{"alertSound":"Ping","alertAnswerSound":"Pop","alertFlashSeconds":10}"#)
        XCTAssertEqual(WidgetAlerts.sound(for: [answer], preferences: split), "Pop")
        XCTAssertEqual(WidgetAlerts.sound(for: [answer, decision], preferences: split), "Ping",
                       "a burst with a question in it plays the decisions' sound")
        XCTAssertEqual(WidgetAlerts.sound(for: [answer], preferences: try prefs(#"{"alertSound":"Ping","alertAnswerSound":"same"}"#)),
                       "Ping", "\"same\" follows the decisions' sound")
        XCTAssertNil(WidgetAlerts.sound(for: [answer], preferences: nil), "no preferences: the default sound")
        XCTAssertEqual(WidgetAlerts.flashSeconds(split), 10)
        XCTAssertEqual(WidgetAlerts.flashSeconds(nil), 5, "flashing is on by default")
        XCTAssertEqual(WidgetAlerts.flashSeconds(try prefs(#"{"alertFlashSeconds":0}"#)), 0)
    }

    @MainActor
    func testFlashingOneSessionLeavesEveryOtherSessionsTriggerAlone() {
        let defaults = UserDefaults(suiteName: "widget.attention.\(UUID().uuidString)")!
        let model = WidgetModel(binaryPath: "/fixture/no-process", defaults: defaults)
        model.flashAttention("a", seconds: 5)
        let other = model.attentionTrigger("b")
        model.flashAttention("a", seconds: 5)
        XCTAssertEqual(model.attentionTrigger("a"), 2)
        XCTAssertEqual(model.attentionTrigger("b"), other, "an unchanged trigger never replays another session's flash")
        model.flashAttention("b", seconds: 0)
        XCTAssertEqual(model.attentionTrigger("b"), other, "0 seconds is off")
    }

    func testTheHeaderReadsTheLastCallsContextAndRowsTheirNewestEntry() {
        func turn(_ role: String, _ usage: TranscriptUsage?) -> TranscriptTurn {
            TranscriptTurn(id: UUID().uuidString, role: role, at: nil, text: "", tools: [], usage: usage)
        }
        XCTAssertEqual(WidgetModel.contextTokens([
            turn("assistant", TranscriptUsage(inputTokens: 10, cacheReadTokens: 90)),
            turn("assistant", TranscriptUsage(inputTokens: 5, cacheReadTokens: 120_000)), turn("user", nil),
        ]), 120_005, "the newest call that reports usage, input plus cache reads")
        XCTAssertNil(WidgetModel.contextTokens([turn("user", nil)]))

        let asked = WidgetInboxItem(id: "form:f", sourceId: "f", kind: "form", key: "k", at: 3_000, needsAnswer: true)
        let answered = WidgetInboxItem(id: "answer:a", sourceId: "a", kind: "answer", key: "k", at: 9_000,
            needsAnswer: false)
        let both = WidgetInboxSession(key: "k", unread: 1, needsAnswer: 1, unreadItem: answered, pendingItem: asked)
        XCTAssertEqual(WidgetSessionTimes.latest(both)?.verb, "asked", "a waiting question wins over a newer answer")
        let read = WidgetInboxSession(key: "k", unread: 1, needsAnswer: 0, unreadItem: answered)
        XCTAssertEqual(WidgetSessionTimes.latest(read)?.verb, "answered")
        XCTAssertNil(WidgetSessionTimes.latest(nil))
    }

    func testTheSessionInboxFilterSplitsInboxEntriesFromDecisions() {
        let cards = ["answer", "result", "form", "decision", "todo"].map { kind in
            WidgetCard(id: kind, kind: kind, sessionKey: "k", sourceId: kind, at: 1, title: kind, body: "",
                       status: "open", choices: [], attachments: [], refs: [], read: true)
        }
        XCTAssertEqual(LiveWidgetView.filtered(cards, by: "inbox").map(\.kind), ["answer", "result", "form"])
        XCTAssertEqual(LiveWidgetView.filtered(cards, by: "decisions").map(\.kind), ["decision", "todo"])
        XCTAssertEqual(LiveWidgetView.filtered(cards, by: "all").count, 5)
    }

    @MainActor
    func testASnapshotDecodedForAStoppedWatchIsDroppedAfterARestart() async throws {
        let decoder = WidgetSnapshotDecoder()
        decoder.reset()
        var delivered: [Int] = []
        decoder.decode(["{\"fixture\":\"old stream\"}"]) { _ in delivered.append(1) }
        // The watch restarts before the old stream's result reaches the main actor.
        decoder.reset()
        decoder.decode(["{\"fixture\":\"new stream\"}"]) { _ in delivered.append(2) }
        for _ in 0 ..< 400 where delivered.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(delivered, [2], "only the restarted stream's result is applied")
    }
}

/// The surface under an open media preview (Media/MediaPreview.swift `.mediaPreviewHost()`).
@MainActor
final class MediaPreviewHostTests: XCTestCase {
    private final class Seen {
        var enabled: [Bool] = []
        var preview: MediaPreviewState?
    }

    private struct Probe: View {
        let seen: Seen
        @Environment(\.isEnabled) private var enabled
        @Environment(\.mediaPreview) private var preview

        var body: some View {
            seen.enabled.append(enabled)
            seen.preview = preview
            return Button("Behind the preview") {}
        }
    }

    override func tearDown() async throws {
        MediaPreviewState.active?.dismiss()
        try await super.tearDown()
    }

    func testTheSurfaceUnderAnOpenPreviewIsOutOfTheKeyboardOrderUntilItCloses() throws {
        let seen = Seen()
        let host = NSHostingView(rootView: Probe(seen: seen).frame(width: 240, height: 160).mediaPreviewHost())
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 240, height: 160),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.contentView = host
        defer { window.close() }
        window.order(.below, relativeTo: 0)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(seen.enabled.last, true)

        let preview = try XCTUnwrap(seen.preview)
        // What a thumbnail hears when the preview closes, and whether the surface took input again by then.
        var returns: [(id: String, enabled: Bool?)] = []
        let listening = preview.focusReturns.sink { returns.append(($0, seen.enabled.last)) }
        defer { listening.cancel() }
        let items = ["opener", "next"].map { MediaPreviewItem(id: $0, path: "/fixture/media-preview-\($0).png") }
        preview.present(items, selectedID: "opener")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(seen.enabled.last, false, "a control behind the open preview stayed in the keyboard order")

        preview.step(1)
        preview.dismiss()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(seen.enabled.last, true, "the surface stayed disabled after the preview closed")
        XCTAssertEqual(returns.map(\.id), ["opener"], "the keyboard goes back to the thumbnail that opened the preview")
        XCTAssertEqual(returns.first?.enabled, true, "the focus came back while the opener could not take it")
    }

    func testAPreviewClosedByAnotherSurfaceGivesNoFocusBack() {
        let inbox = MediaPreviewState()
        let shelf = MediaPreviewState()
        var returned: [String] = []
        let listening = inbox.focusReturns.sink { returned.append($0) }
        defer { listening.cancel() }
        inbox.present([MediaPreviewItem(id: "a", path: "/fixture/a.png")])
        shelf.present([MediaPreviewItem(id: "b", path: "/fixture/b.png")])
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(returned, [], "the inbox thumbnail took the keyboard from the shelf preview that just opened")
        shelf.dismiss()
    }
}

/// What the composer and the number keys answer: an open, unanswered decision, never a folded one or one behind an
/// open media preview.
@MainActor
final class WidgetAnswerTargetTests: XCTestCase {
    private let key = "local:codex:fixture:"

    private func decision() -> WidgetCard {
        WidgetCard(id: "decision:d_1_fixture", kind: "decision", sessionKey: key, sourceId: "d_1_fixture", at: 1,
                   title: "Keep the compact layout?", body: "", status: "open", revision: 1, number: 1,
                   choices: [WidgetChoice(id: "keep", title: "Keep", recommended: true),
                             WidgetChoice(id: "drop", title: "Drop", recommended: false)],
                   attachments: [], refs: [], read: false)
    }

    private func snapshot(_ card: WidgetCard) throws -> String {
        let session: [String: Any] = [
            "key": key, "target": ["hostId": "local", "provider": "codex", "sessionId": "fixture", "sourceHome": "",
                                   "cwd": "/fixture"],
            "title": "Fixture", "project": "Fixture", "activityAt": 0, "status": "waiting", "pinned": true,
            "visible": true, "hiddenByFilter": false]
        let cards = try JSONSerialization.jsonObject(with: JSONEncoder().encode([card]))
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": key, "preferences": ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
                "placement": "both", "side": "right", "quietSeconds": 15, "voiceProvider": "openai", "voiceLanguage": "en"],
            "assets": [:], "drafts": [:], "outgoing": []], "sessions": [session], "cards": cards,
            "manifests": [:], "errors": [], "selectedKey": key,
            "notifications": ["unread": 0, "needsAnswer": 1, "complete": true, "truncated": false, "sessions": []]])
        return String(decoding: data, as: UTF8.self)
    }

    func testAFoldedDecisionIsNotAnsweredByTheComposer() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-answer-\(UUID().uuidString)")
        let journal = root.appendingPathComponent("native-submissions")
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.answer." + UUID().uuidString))
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: root.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults,
                                    notificationNamespace: "answer." + UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        let card = decision()
        model.receive([try snapshot(card)])
        if model.selectedKey != key { model.select(key) }
        model.openCard(card)
        XCTAssertEqual(model.answerCard?.id, card.id, "the open decision is what Return answers")

        // The user folds it and writes an ordinary follow-up.
        model.foldedCardIDs.insert(card.id)
        XCTAssertNil(model.answerCard)
        XCTAssertEqual(model.card?.id, card.id, "it stays selected, folded")
        model.setText("Carry on with the tests")
        model.send()
        let files = try FileManager.default.contentsOfDirectory(at: journal, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        XCTAssertEqual(files.count, 1)
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: try XCTUnwrap(files.first)))
            as? [String: Any])
        let payload = try XCTUnwrap(request["payload"] as? [String: Any])
        XCTAssertEqual(payload["kind"] as? String, "followup", "a follow-up, not an answer to the folded decision")
        XCTAssertEqual(payload["text"] as? String, "Carry on with the tests")

        model.openCard(card)
        XCTAssertEqual(model.answerCard?.id, card.id, "opening it again makes it the answer target")
    }

    func testANumberKeyAnswersOnlyAnOpenDecisionAndNeverOneBehindAPreview() {
        let card = decision()
        func key(_ characters: String, keyCode: UInt16, previewOpen: Bool = false,
                 answering: WidgetCard?) -> WidgetCoordinator.PanelKey {
            WidgetCoordinator.panelKey(keyCode: keyCode, characters: characters, context: .init(
                previewOpen: previewOpen, agents: true, editingText: false, answering: answering),
                keymap: Keymap(library: WidgetKeymap.library, store: nil, layout: TableKeyLayout.us))
        }
        XCTAssertEqual(key("1", keyCode: 0x12, answering: card), .choose("keep"))
        XCTAssertEqual(key("2", keyCode: 0x13, answering: card), .choose("drop"))
        XCTAssertEqual(key("1", keyCode: 0x12, answering: nil), .pass, "a folded decision is not answered")
        XCTAssertEqual(key("1", keyCode: 0x12, previewOpen: true, answering: card), .pass,
                       "a number pressed in the preview never answers the decision behind it")
        XCTAssertEqual(key("j", keyCode: 0x26, previewOpen: true, answering: card), .pass,
                       "nor does j change the session under it")
        XCTAssertEqual(key("j", keyCode: 0x26, answering: card), .previous)
        XCTAssertEqual(key("", keyCode: 53, answering: card), .collapse)
    }
}

/// The camera button when macOS refuses the screenshot.
@MainActor
final class WidgetCaptureRefusalTests: XCTestCase {
    func testARefusedScreenshotThatOpensNoDialogSaysWhy() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-capture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("native-submissions"),
                                                withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.capture." + UUID().uuidString))
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: root.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults,
                                    notificationNamespace: "capture." + UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        // This process still reads the grant as on (macOS caches it per process), so no dialog opens; the new
        // screenshot process is refused.
        var gateCalls = 0
        model.screenCaptureGate = { _ in
            gateCalls += 1
            return true
        }
        model.actionRunner = { _ in
            throw ToolsBridgeError.refused("[\(WidgetCaptureError.screenRecordingDenied)] Screen Recording is off")
        }
        model.capture()
        for _ in 0 ..< 400 where model.error == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(model.error, WidgetModel.screenRecordingRefused, "the camera button says why nothing happened")
        XCTAssertEqual(gateCalls, 2, "asked before the screenshot, and again after the refusal")
    }
}

/// The warm Agents pane after the panel collapsed (WidgetHostView `WarmPaneVisibility`).
@MainActor
final class WarmPaneVisibilityTests: XCTestCase {
    private final class Seen {
        var enabled: [Bool] = []
    }

    private struct Probe: View {
        let seen: Seen
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            seen.enabled.append(enabled)
            return TextField("Reply to agent…", text: .constant(""))
        }
    }

    private func render(shown: Bool, _ seen: Seen) {
        let host = NSHostingView(rootView: Probe(seen: seen).modifier(WarmPaneVisibility(shown: shown, alignment: .top))
            .frame(width: 240, height: 160))
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 240, height: 160),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.contentView = host
        defer { window.close() }
        window.order(.below, relativeTo: 0)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
    }

    func testAHiddenWarmPaneKeepsItsControlsOutOfTheKeyboardOrder() {
        let hidden = Seen()
        render(shown: false, hidden)
        XCTAssertEqual(hidden.enabled.last, false, "the hidden composer can take no keystrokes")
        let shown = Seen()
        render(shown: true, shown)
        XCTAssertEqual(shown.enabled.last, true)
    }
}

/// One session with one open decision, as the widget's snapshot carries it.
@MainActor
private enum StagingFixture {
    static let key = "local:codex:fixture-staged:"

    /// `stagedOnly`: the decision is not among the session's listed items (past its eight), only in the staged list.
    static func snapshot(draftOption: String?, decisionClick: String = "stage", stagedOnly: Bool = false) throws -> String {
        var item: [String: Any] = ["id": "decision:d1", "sourceId": "d1", "kind": "decision", "key": key, "at": 1,
                                   "needsAnswer": true, "title": "Keep it?", "number": 7, "options": ["keep", "drop"],
                                   "revision": 1]
        var card: [String: Any] = ["id": "decision:d1", "kind": "decision", "sourceId": "d1", "sessionKey": key, "at": 1,
                                   "title": "Keep it?", "body": "", "status": draftOption == nil ? "open" : "drafted",
                                   "revision": 1, "number": 7,
                                   "choices": [["id": "a", "title": "keep", "recommended": true],
                                               ["id": "b", "title": "drop", "recommended": false]],
                                   "attachments": [], "refs": [], "read": true]
        if let draftOption { item["draftOption"] = draftOption; card["draftOption"] = draftOption }
        let session: [String: Any] = ["key": key, "target": ["hostId": "local", "provider": "codex",
            "sessionId": "fixture-staged", "sourceHome": "", "cwd": "/fixture"], "title": "Staged fixture",
            "project": "Fixture", "activityAt": 0, "status": "waiting", "pinned": true, "visible": true, "hiddenByFilter": false]
        var notifications: [String: Any] = ["unread": 0, "needsAnswer": 1, "complete": true, "truncated": false,
            "sessions": [["key": key, "unread": 0, "needsAnswer": 1, "pendingItem": item,
                          "items": stagedOnly ? [] : [item]]]]
        if stagedOnly { notifications["staged"] = [item] }
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": key, "preferences": ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
                "placement": "both", "side": "right", "quietSeconds": 15, "voiceProvider": "openai", "voiceLanguage": "en",
                "decisionClick": decisionClick],
            "assets": [:], "drafts": [:], "outgoing": []], "sessions": [session], "cards": [card],
            "manifests": [:], "errors": [], "selectedKey": key, "notifications": notifications])
        return String(decoding: data, as: UTF8.self)
    }

    static func model() -> WidgetModel {
        let defaults = UserDefaults(suiteName: "widget.staging." + UUID().uuidString)!
        return WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "staging." + UUID().uuidString, observeExternalChanges: false))
    }
}

/// Staged decisions (Martin, 2026-10-23): a click stages the pick, closing with staged ones asks first, and the
/// answer to that question sends, keeps or discards them.
@MainActor
final class WidgetStagingTests: XCTestCase {
    private let key = StagingFixture.key

    private func snapshot(draftOption: String?, decisionClick: String = "stage") throws -> String {
        try StagingFixture.snapshot(draftOption: draftOption, decisionClick: decisionClick)
    }

    private func names(_ actions: [WidgetJSON]) -> [String] {
        actions.compactMap { value in
            guard case .object(let fields) = value, case .string(let name) = fields["action"] else { return nil }
            return name
        }
    }

    func testAPickStagesAndClosingAsksThenSendsOneBatch() async throws {
        let defaults = UserDefaults(suiteName: "widget.staging." + UUID().uuidString)!
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "staging." + UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        var actions: [WidgetJSON] = []
        model.actionRunner = { value in
            actions.append(value)
            return ["sent": 1, "failed": 0]
        }
        model.receive([try snapshot(draftOption: nil)])
        model.select(key)
        let card = try XCTUnwrap(model.cards.first)

        model.choose(card, option: "a")
        XCTAssertEqual(model.stagedOption("d1", stored: nil), "a", "the pick shows at once, before the hub answers")
        try await Task.sleep(for: .milliseconds(200))
        let ledger = try XCTUnwrap(actions.last)
        guard case .object(let fields) = ledger else { return XCTFail("not an object") }
        XCTAssertEqual(fields["action"], .string("ledger"))
        XCTAssertEqual(fields["state"], .string("drafted"))
        XCTAssertEqual(fields["draftOption"], .string("a"))
        XCTAssertFalse(names(actions).contains("submit"), "a staged pick sends nothing")

        model.receive([try snapshot(draftOption: "a")])
        XCTAssertEqual(model.stagedItems.map(\.sourceId), ["d1"])
        XCTAssertTrue(model.pendingStage.isEmpty, "the snapshot now shows the pick")

        model.expanded = .right
        model.requestCollapse()
        XCTAssertTrue(model.stagedLeavePrompt, "closing with a staged decision asks first")
        XCTAssertEqual(model.expanded, .right, "and keeps the panel open while it asks")

        model.resolveStagedLeave("send")
        XCTAssertNil(model.expanded)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(names(actions).last, "send-staged")
        XCTAssertEqual(WidgetModel.stagedSummary(model.stagedItems), "1 decision will be sent to 1 session")
    }

    func testASendNoSessionTookSaysWhyAndSendAgainDeliversIt() async throws {
        let defaults = UserDefaults(suiteName: "widget.staging." + UUID().uuidString)!
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "staging." + UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        var actions: [WidgetJSON] = []
        let reason = "2 Claude terminals run this session (pid 41, pid 42), active within 10 minutes of each other; none was picked."
        model.actionRunner = { value in
            actions.append(value)
            guard case .object(let fields) = value, fields["action"] == .string("send-staged") else {
                return ["sent": 1, "queued": 0, "failed": 0, "sessions": [["session": "fixture-staged",
                    "numbers": [7], "result": ["delivered": true, "detail": "codex worker w1"]]]]
            }
            return ["sent": 0, "queued": 1, "failed": 0, "sessions": [["session": "fixture-staged", "numbers": [7],
                "result": ["delivered": false, "detail": .string(reason)]]]]
        }
        model.receive([try snapshot(draftOption: "a")])
        model.select(key)

        model.sendStaged(["d1"])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.notice, "Not delivered to Staged fixture: \(reason) The answers wait for its next prompt.")
        let again = try XCTUnwrap(model.noticeAction, "a send nobody took offers Send again")
        XCTAssertEqual(again.title, "Send again")

        again.run()
        try await Task.sleep(for: .milliseconds(200))
        guard case .object(let resend) = try XCTUnwrap(actions.last) else { return XCTFail("not an object") }
        XCTAssertEqual(resend["action"], .string("resend-answers"))
        XCTAssertEqual(resend["ids"], .array(["d1"]))
        XCTAssertEqual(model.notice, "1 decision delivered.")
        XCTAssertNil(model.noticeAction, "a delivered send leaves no button")
    }

    /// The decision writes and sends among `actions`, without the selection and read marks around them.
    private func decisionActions(_ actions: [WidgetJSON]) -> [String] {
        names(actions).filter { ["ledger", "send-staged"].contains($0) }
    }

    func testKeepingStagedDecisionsDoesNotAskAgainForTheSameOnes() throws {
        let defaults = UserDefaults(suiteName: "widget.staging." + UUID().uuidString)!
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "staging." + UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        model.receive([try snapshot(draftOption: "b")])
        model.expanded = .right
        model.requestCollapse()
        XCTAssertTrue(model.stagedLeavePrompt)
        model.resolveStagedLeave("keep")
        XCTAssertNil(model.expanded)
        model.expanded = .right
        model.requestCollapse()
        XCTAssertFalse(model.stagedLeavePrompt, "the same staged decisions were kept a moment ago")
        XCTAssertNil(model.expanded)
    }

    func testTheSendSettingAnswersAtOnce() async throws {
        let defaults = UserDefaults(suiteName: "widget.staging." + UUID().uuidString)!
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: FileManager.default.temporaryDirectory.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "staging." + UUID().uuidString, observeExternalChanges: false))
        defer { model.stop() }
        var actions: [WidgetJSON] = []
        model.actionRunner = { value in actions.append(value); return ["ok": true] }
        model.receive([try snapshot(draftOption: nil, decisionClick: "send")])
        model.select(key)
        model.choose(try XCTUnwrap(model.cards.first), option: "b")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(names(actions).contains("ledger"), "the send setting does not stage")
        XCTAssertNil(model.pendingStage["d1"])
    }

    func testTheSendSettingAnswersAtOnceFromTheInboxOfEverySession() async throws {
        let model = StagingFixture.model()
        defer { model.stop() }
        var actions: [WidgetJSON] = []
        model.actionRunner = { value in actions.append(value); return ["sent": 1, "queued": 0, "failed": 0] }
        model.receive([try snapshot(draftOption: nil, decisionClick: "send")])
        let item = try XCTUnwrap(model.inboxOverviewItems.first)
        model.choose(item, option: "b")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(decisionActions(actions), ["ledger", "send-staged"], "the pick is written, then sent")
        guard case .object(let send) = try XCTUnwrap(actions.last) else { return XCTFail("not an object") }
        XCTAssertEqual(send["ids"], .array(["d1"]))
    }

    func testAStagedDecisionPastTheListedEightIsStillSent() async throws {
        let model = StagingFixture.model()
        defer { model.stop() }
        var actions: [WidgetJSON] = []
        model.actionRunner = { value in actions.append(value); return ["sent": 1, "queued": 0, "failed": 0] }
        model.receive([try snapshot(draftOption: "a", stagedOnly: true)])
        XCTAssertTrue(model.inboxOverviewItems.isEmpty, "the session lists other items")
        XCTAssertEqual(model.stagedItems.map(\.sourceId), ["d1"])
        model.sendStaged(["d1"])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(decisionActions(actions), ["send-staged"])
    }

    func testASendWaitsForTheLedgerWriteBeforeIt() async throws {
        let model = StagingFixture.model()
        defer { model.stop() }
        var events: [String] = []
        model.actionRunner = { value in
            guard case .object(let fields) = value, case .string(let name) = fields["action"],
                  ["ledger", "send-staged"].contains(name) else { return ["ok": true] }
            events.append(name + " start")
            if name == "ledger" { try await Task.sleep(for: .milliseconds(100)) }
            events.append(name + " end")
            return ["sent": 1, "queued": 0, "failed": 0]
        }
        model.receive([try snapshot(draftOption: "b")])
        model.select(key)
        model.choose(try XCTUnwrap(model.cards.first), option: "a")
        model.sendStaged(["d1"])
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(events, ["ledger start", "ledger end", "send-staged start", "send-staged end"])
    }

    func testSaveDraftClearsTheComposerOnlyOnceTheNoteIsSaved() async throws {
        let model = StagingFixture.model()
        defer { model.stop() }
        var refuse = true
        model.actionRunner = { value in
            if refuse, case .object(let fields) = value, fields["action"] == .string("ledger") {
                throw ToolsBridgeError.refused("revision changed")
            }
            return ["ok": true]
        }
        model.receive([try snapshot(draftOption: nil)])
        model.select(key)
        let card = try XCTUnwrap(model.cards.first)
        model.setText("only if it is cheap")
        model.saveDraft(card)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.draft.text, "only if it is cheap", "a refused save keeps the note in the composer")
        XCTAssertNil(model.draftSavedAt[card.id])

        refuse = false
        model.saveDraft(card)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(model.draft.text, "")
        XCTAssertNotNil(model.draftSavedAt[card.id])
    }
}

/// The widget panel is key while it is expanded (`EdgePanelController` makes it key on expand), so a click reaches
/// its controls at once. A hidden test window is never key, and becoming key would take the user's keyboard; without
/// this AppKit drops the first click on any SwiftUI control in it (a plain `Button` did not fire either).
private final class FirstClickHost: NSHostingView<AnyView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The reply box is one click target (Martin asked for it on 2026-10-23): a click beside the one-line field, in the
/// box's padding, starts typing. Real mouse events at a probed frame, in a hidden window.
@MainActor
final class WidgetComposerClickTests: XCTestCase {
    func testAClickInTheBoxBesideTheFieldStartsTyping() throws {
        _ = NSApplication.shared
        let model = StagingFixture.model()
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        model.receive([try StagingFixture.snapshot(draftOption: nil)])
        model.select(StagingFixture.key)
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false }
        let size = NSSize(width: 520, height: 700)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = FirstClickHost(rootView: AnyView(LiveWidgetView(model: model, edge: .right, embedded: true)
            .frame(width: size.width, height: size.height)))
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer { window.orderOut(nil); window.close() }
        pump(1.0)
        let box = try XCTUnwrap(FrameProbe.frames["widget.composer"], "the reply box has a frame")
        let field = try XCTUnwrap(FrameProbe.frames["widget.composer.field"], "the reply field has a frame")
        XCTAssertFalse(window.firstResponder is NSTextView, "nothing is being typed before the click")
        // The box's left padding at the field's height: inside the box, outside the field and every button.
        let point = NSPoint(x: box.minX + 4, y: size.height - field.midY)
        XCTAssertLessThan(box.minX + 4, field.minX, "the click lands beside the field, not on it")
        click(window, at: point)
        XCTAssertTrue(window.firstResponder is NSTextView, "a click in the box's padding focuses the reply field")
    }

    private func pump(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let next = NSApp.nextEvent(matching: .any, until: deadline, inMode: .default, dequeue: true) {
                NSApp.sendEvent(next)
            }
        }
    }

    private func click(_ window: NSWindow, at location: NSPoint) {
        func event(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        NSApp.postEvent(event(.leftMouseDown), atStart: false)
        NSApp.postEvent(event(.leftMouseUp), atStart: false)
        pump(0.5)
    }
}

/// A rail bubble takes clicks whether or not its attention ring shows (Martin, 2026-10-23: "clicking the circle with the
/// count on the right does nothing when first click opened it - neither the hover shows correctly"). Its count sits
/// under `.allowsHitTesting(false)` and its only background was a fill at opacity 0 once the ring faded, which SwiftUI
/// does not hit-test, so opening the session (which ends the attention) left a bubble no click or hover could reach.
@MainActor
final class WidgetBubbleHitTests: XCTestCase {
    final class Taps: ObservableObject { @Published var count = 0 }
    struct Bubble: View {
        @ObservedObject var taps: Taps
        var body: some View {
            Button { taps.count += 1 } label: {
                Text("4").allowsHitTesting(false)
                    .frame(width: 38, height: 34)
                    .modifier(WidgetBubbleChrome(trigger: 0, attention: .borderFlash(color: .orange, cornerRadius: 17),
                                                 reduceMotion: true))
            }
            .buttonStyle(.plain)
            .frameProbe("bubble")
            .frame(width: 120, height: 120)
        }
    }

    func testABubbleWithoutItsRingStillTakesAClick() throws {
        _ = NSApplication.shared
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false }
        let taps = Taps()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 120, height: 120), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = FirstClickHost(rootView: AnyView(Bubble(taps: taps)))
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer { window.orderOut(nil); window.close() }
        pump(0.6)
        let frame = try XCTUnwrap(FrameProbe.frames["bubble"])
        // Off the count's glyph: the bubble's edge, where only the chrome is.
        let point = NSPoint(x: frame.midX - 12, y: 120 - frame.midY)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            NSApp.postEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
        }
        pump(0.5)
        XCTAssertEqual(taps.count, 1, "a click on a bubble with no ring opens its session")
    }

    /// Two rows on a glass panel with a gap between them, as the widget's hover list draws them.
    struct GlassRows: View {
        @ObservedObject var taps: Taps
        var body: some View {
            VStack(spacing: 24) {
                RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.025)).frame(height: 40)
                RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.025)).frame(height: 40)
            }
            .padding(16)
            .frame(width: 200, height: 160, alignment: .top)
            .nativeGlassSurface(in: RoundedRectangle(cornerRadius: 16), opaqueColor: Color(white: 0.09))
            .environment(\.nativeSettingsTheme, .glass)
            .onTapGesture { taps.count += 1 }
        }
    }

    /// SwiftUI does not hit-test Liquid Glass itself, so a gap between rows on a glass panel was outside it: hover there
    /// read as "the pointer left", and the widget's hover list closed under a scrolling pointer (Martin, 2026-10-24:
    /// "it looks like the space between the session items is transparent for the focus"). The solid theme never had it.
    func testTheGapBetweenRowsOnAGlassPanelIsPartOfThePanel() {
        _ = NSApplication.shared
        let taps = Taps()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 160), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = FirstClickHost(rootView: AnyView(GlassRows(taps: taps)))
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer { window.orderOut(nil); window.close() }
        pump(0.6)
        // The gap: rows at 16...56 and 80...120 from the top, so 68 from the top is between them.
        let point = NSPoint(x: 100, y: 160 - 68)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            NSApp.postEvent(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: 1)!, atStart: false)
        }
        pump(0.5)
        XCTAssertEqual(taps.count, 1, "a click between two rows of a glass panel lands on the panel")
    }

    private func pump(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let next = NSApp.nextEvent(matching: .any, until: deadline, inMode: .default, dequeue: true) { NSApp.sendEvent(next) }
        }
    }
}

/// A click on another GenesisTools window keeps the panel open: the vault key window belongs to the app process, the
/// panel to the widget process (Martin, 2026-10-23: "allow with touch id does literally hide the widget").
@MainActor
final class WidgetOwnWindowClickTests: XCTestCase {
    func testAPointOverOneOfOurWindowsCountsAsOurs() async throws {
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        let frame = NSRect(x: screen.frame.minX + 40, y: screen.frame.minY + 40, width: 60, height: 60)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0.02
        window.ignoresMouseEvents = true
        window.level = .popUpMenu
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.close() }
        try await Task.sleep(for: .milliseconds(300))
        let point = NSPoint(x: frame.midX, y: frame.midY)
        XCTAssertTrue(WidgetCoordinator.ownWindowOwnsPoint(point), "our window at the point")
        window.orderOut(nil)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertFalse(WidgetCoordinator.ownWindowOwnsPoint(point), "another app's window, or none, once ours is gone")
    }
}

/// Switching sessions shows cards at once (Martin, 2026-10-24: "why is it loading every time? can't it just be cached
/// and be prepared at all times"). A snapshot carries the sessions that need you beside the selected one (`warmKeys`),
/// and every session seen once stays cached until a snapshot names it again.
@MainActor
final class WidgetSessionSwitchTests: XCTestCase {
    private func card(_ session: String, _ number: Int) -> WidgetCard {
        WidgetCard(id: "decision:d_\(number)_\(session)", kind: "decision", sessionKey: key(session),
                   sourceId: "d_\(number)_\(session)", at: Double(number), title: "Decision \(number) in \(session)",
                   body: "", status: "open", revision: 1, number: number, choices: [], attachments: [], refs: [],
                   read: false)
    }

    private func key(_ session: String) -> String { "local:codex:\(session):" }

    private func snapshot(selected: String, warm: [String], cards: [WidgetCard],
                          activity: [WidgetActivityEvent] = []) throws -> String {
        let sessions: [[String: Any]] = ["alpha", "beta", "gamma"].map { name in
            ["key": key(name), "target": ["hostId": "local", "provider": "codex", "sessionId": name, "sourceHome": "",
                                          "cwd": "/fixture"],
             "title": name, "project": "Fixture", "activityAt": 0, "status": "waiting", "pinned": true,
             "visible": true, "hiddenByFilter": false]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "state": ["version": 1, "revision": 0, "selectedKey": key(selected),
                      "preferences": ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
                                      "placement": "both", "side": "right", "quietSeconds": 15,
                                      "voiceProvider": "openai", "voiceLanguage": "en"],
                      "assets": [:], "drafts": [:], "outgoing": []],
            "sessions": sessions,
            "cards": try JSONSerialization.jsonObject(with: JSONEncoder().encode(cards)),
            "activity": try JSONSerialization.jsonObject(with: JSONEncoder().encode(activity)),
            "manifests": [:], "errors": [], "selectedKey": key(selected), "warmKeys": warm.map(key),
            "notifications": ["unread": 0, "needsAnswer": 2, "complete": true, "truncated": false, "sessions": []]])
        return String(decoding: data, as: UTF8.self)
    }

    private func model() throws -> (WidgetModel, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("widget-switch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("native-submissions"),
                                                withIntermediateDirectories: true)
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.switch." + UUID().uuidString))
        let model = WidgetModel(binaryPath: "/fixture/no-process", stateRoot: root.path, defaults: defaults,
                                appearance: NativeSettingsAppearance(defaults: defaults,
                                    notificationNamespace: "switch." + UUID().uuidString, observeExternalChanges: false))
        return (model, root)
    }

    func testAWarmOrSeenSessionOpensWithItsCardsAndAnUnseenOneLoads() throws {
        let (model, root) = try model()
        defer { model.stop(); try? FileManager.default.removeItem(at: root) }
        let asked = WidgetActivityEvent(id: "e1", sourceId: "d_1_alpha", at: 1, title: "Asked", body: "")
        model.receive([try snapshot(selected: "alpha", warm: ["beta"],
                                    cards: [card("alpha", 1), card("beta", 2)], activity: [asked])])
        if model.selectedKey != key("alpha") { model.select(key("alpha")) }
        XCTAssertEqual(model.cards.map(\.id), ["decision:d_1_alpha"])

        model.select(key("beta"))
        XCTAssertFalse(model.inboxLoading, "the warm session's cards came with the last snapshot")
        XCTAssertEqual(model.cards.map(\.id), ["decision:d_2_beta"])
        XCTAssertEqual(model.sessionActivity, [], "the previous session's activity is not shown as this one's")

        model.select(key("gamma"))
        XCTAssertTrue(model.inboxLoading, "a session no snapshot carried yet still says it loads")
        XCTAssertEqual(model.cards, [])

        // The snapshot that names beta brings a new decision: it just appears.
        model.receive([try snapshot(selected: "beta", warm: [], cards: [card("beta", 2), card("beta", 3)])])
        model.select(key("alpha"))
        XCTAssertFalse(model.inboxLoading, "a session seen once opens from the cache")
        XCTAssertEqual(model.cards.map(\.id), ["decision:d_1_alpha"])
        XCTAssertEqual(model.sessionActivity, [asked], "with the activity last seen for it")
        model.select(key("beta"))
        XCTAssertEqual(model.cards.map(\.id), ["decision:d_2_beta", "decision:d_3_beta"])
    }

    func testTheCacheKeepsTheSessionsRefreshedLast() throws {
        var cache = WidgetSessionCache()
        for index in 0..<(WidgetSessionCache.limit + 2) {
            let name = "s\(index)"
            let json = try snapshot(selected: name, warm: [], cards: [card(name, index)])
            cache.remember(try JSONDecoder().decode(WidgetSnapshot.self, from: Data(json.utf8)))
        }
        XCTAssertEqual(cache.count, WidgetSessionCache.limit)
        XCTAssertNil(cache[key("s0")], "the session refreshed longest ago goes first")
        XCTAssertEqual(cache[key("s\(WidgetSessionCache.limit + 1)")]?.cards.count, 1)
    }
}
