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
}
