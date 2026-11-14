import Foundation
import XCTest

@testable import GenesisKit

/// A decision log in memory: it keeps each decision's pick and note as the hub's store would, answers each action as
/// the test says, and can hold a write open until the test lets it land.
@MainActor
private final class FakeDecisionLog: DecisionLog {
    struct Row: Equatable {
        var option = ""
        var note = ""
        var updatedAt: Double = 0
        var dismissed = false
    }

    var rows: [String: Row] = [:]
    var actions: [DecisionLogAction] = []
    /// Answers for the next actions, oldest first; without one a write lands.
    var answers: [DecisionLogAnswer] = []
    /// Set: the next write waits here until `release()`.
    var holdNext = false
    private var waiting: CheckedContinuation<Void, Never>?
    /// Milliseconds since 1970 of the next row change; the engine of a test runs at 1,000 s.
    var clockMs: Double = 0

    func run(_ action: DecisionLogAction) async -> DecisionLogAnswer {
        actions.append(action)
        if holdNext {
            holdNext = false
            await withCheckedContinuation { waiting = $0 }
        }
        let answer = answers.isEmpty ? .done(.object([:])) : answers.removeFirst()
        guard case .done = answer else { return answer }
        clockMs += 1
        switch action {
        case .stage(let ref, let option, let note):
            var row = rows[ref.id, default: Row()]
            if let option { row.option = option }
            if let note { row.note = note }
            row.updatedAt = clockMs
            rows[ref.id] = row
        case .unstage(let refs):
            for ref in refs { rows[ref.id] = Row(updatedAt: clockMs) }
        case .dismiss(let ref), .move(let ref, _):
            rows[ref.id, default: Row()].dismissed = true
        }
        return answer
    }

    func release() {
        waiting?.resume()
        waiting = nil
    }

    /// The snapshot a surface would read now.
    func snapshot() -> [String: DecisionAnswering.Engine.Row] {
        rows.mapValues { DecisionAnswering.Engine.Row(option: $0.option, note: $0.note, updatedAt: $0.updatedAt) }
    }

    /// Another client (the phone) answers the decision.
    func otherClientStages(_ id: String, option: String) {
        clockMs += 1
        rows[id, default: Row()].option = option
        rows[id, default: Row()].updatedAt = clockMs
    }
}

/// The decision staging engine against a fake decision log (C19, 2026-11-14): the hub's Inbox and the widget stage
/// through it, so these cases are the staging rules of both.
@MainActor
final class DecisionAnsweringEngineTests: XCTestCase {
    private let ref = DecisionAddress(id: "d_4_s1", sessionId: "s1", number: 4, revision: 1)
    private var seconds: TimeInterval = 1_000

    private func engine(_ log: FakeDecisionLog, clock: ManualClock = ManualClock()) -> DecisionAnswering.Engine {
        DecisionAnswering.Engine(log: log, clock: clock, now: { [unowned self] in self.seconds })
    }

    /// Lets the engine's write tasks run on the main actor.
    private func settle() async {
        for _ in 0 ..< 20 { await Task.yield() }
    }

    func testAPickThenANoteBothLandAndASnapshotConfirmsThem() async {
        let log = FakeDecisionLog()
        let engine = engine(log)
        var drained = 0
        engine.drained = { _ in drained += 1 }
        engine.stage(ref, option: "a", note: nil)
        XCTAssertEqual(engine.letters(ref.id, stored: nil), "a", "the pick shows at once")
        XCTAssertTrue(engine.writing.contains(ref.id))
        await settle()
        engine.stage(ref, option: nil, note: "because")
        XCTAssertEqual(engine.letters(ref.id, stored: nil), "a", "a note keeps the pick staged before it")
        XCTAssertEqual(engine.note(ref.id, stored: nil), "because")
        await settle()
        XCTAssertEqual(log.actions, [.stage(ref, option: "a", note: nil), .stage(ref, option: nil, note: "because")])
        XCTAssertEqual(drained, 2)
        XCTAssertTrue(engine.writing.isEmpty)
        XCTAssertNotNil(engine.pending[ref.id], "landed is not confirmed: the pick shows until a snapshot has it")
        engine.reconcile(log.snapshot())
        XCTAssertNil(engine.pending[ref.id], "the snapshot that contains the pick and the note confirms them")
        XCTAssertEqual(engine.letters(ref.id, stored: "a"), "a")
    }

    func testAFailedWriteDropsThePickAndTheSendThatWaitedForIt() async {
        let log = FakeDecisionLog()
        log.answers = [.refused("DECISION 4 changed", detail: "revision 2")]
        let engine = engine(log)
        var sent = false
        engine.stage(ref, option: "b", note: nil, then: { sent = true })
        await settle()
        XCTAssertEqual(engine.errors[ref.id], .init(text: "DECISION 4 changed", detail: "revision 2"))
        XCTAssertNil(engine.pending[ref.id], "a refused pick does not stay on screen")
        XCTAssertEqual(engine.letters(ref.id, stored: "a"), "a", "the stored pick shows again")
        XCTAssertFalse(sent, "a send at once must not send what was stored before")
        engine.stage(ref, option: "c", note: nil)
        XCTAssertNil(engine.errors[ref.id], "the next write clears the error")
        await settle()
        XCTAssertEqual(log.rows[ref.id]?.option, "c")
    }

    func testAWriteTheLogNeverAnsweredKeepsThePickUntilTheUserTriesAgain() async {
        let log = FakeDecisionLog()
        log.answers = [.unanswered(seconds: 30)]
        let engine = engine(log)
        engine.stage(ref, option: "a", note: nil)
        await settle()
        XCTAssertEqual(engine.pending[ref.id]?.unsaved, true)
        seconds += DecisionAnswering.Engine.unansweredLifetime + 1
        engine.reconcile([:])
        XCTAssertEqual(engine.letters(ref.id, stored: nil), "a", "an unanswered pick is never dropped by time")
    }

    func testAPickQueuedBehindARunningWriteKeepsItsLettersAndRunsNext() async {
        let log = FakeDecisionLog()
        log.holdNext = true
        let engine = engine(log)
        var sent = 0
        engine.stage(ref, option: "a", note: nil)
        await settle()
        engine.stage(ref, option: "ac", note: nil)
        engine.stage(ref, option: nil, note: "both", then: { sent += 1 })
        XCTAssertEqual(engine.letters(ref.id, stored: nil), "ac", "the newest pick shows while the first write runs")
        XCTAssertEqual(log.actions.count, 1, "one write at a time for a decision")
        log.release()
        await settle()
        XCTAssertEqual(log.actions, [.stage(ref, option: "a", note: nil), .stage(ref, option: "ac", note: "both")],
                       "the queued note replaced the queued pick and kept its letters")
        XCTAssertEqual(sent, 1, "the send waited for every write of its decision")
        engine.reconcile(log.snapshot())
        XCTAssertNil(engine.pending[ref.id])
        XCTAssertEqual(log.rows[ref.id], .init(option: "ac", note: "both", updatedAt: log.clockMs))
    }

    /// The widget's rules the engine took over (C19 second half): a write queued behind a refused one keeps its own
    /// work, a newer change is told from an older one past a snapshot's confirmation, a refused clear shows the stored
    /// pick again, and a dismiss queued behind a stage is never replaced by a later stage.
    func testARefusedWriteKeepsTheWorkOfTheWriteQueuedBehindIt() async {
        let log = FakeDecisionLog()
        log.holdNext = true
        log.answers = [.refused("DECISION 4 changed", detail: nil)]
        let engine = engine(log)
        var sent: [String] = []
        let first = engine.stage(ref, option: "a", note: nil, then: { sent.append("a") })
        await settle()
        let second = engine.stage(ref, option: "b", note: nil, then: { sent.append("b") })
        XCTAssertNotEqual(first, second)
        engine.reconcile([ref.id: .init(option: "b", note: nil)])
        XCTAssertNil(engine.pending[ref.id], "the snapshot confirmed the newer pick while its write waits")
        XCTAssertEqual(engine.version(ref.id), second, "the version outlives the confirmation while a write runs")
        log.release()
        await settle()
        XCTAssertEqual(sent, ["b"], "the refused write dropped its own send, not the one queued behind it")
        XCTAssertNil(engine.version(ref.id), "no write and no pending pick: nothing to tell apart any more")

        let other = DecisionAddress(id: "d_5_s1", sessionId: "s1", number: 5)
        log.answers = [.refused("no such decision", detail: nil)]
        engine.unstage([other])
        XCTAssertEqual(engine.letters(other.id, stored: "c"), "")
        await settle()
        XCTAssertEqual(engine.letters(other.id, stored: "c"), "c", "a refused clear shows the stored pick again")

        log.holdNext = true
        engine.stage(ref, option: "a", note: nil)
        await settle()
        engine.hold("card", .move(ref, state: "dismissed"))
        engine.commit("card")
        engine.stage(ref, option: "c", note: nil)
        engine.hold(ref.id, .move(ref, state: "implemented"))
        engine.commit(ref.id)
        engine.stage(ref, option: "d", note: nil)
        engine.stage(ref, option: "e", note: nil)
        log.release()
        await settle()
        XCTAssertEqual(log.actions.suffix(5), [.stage(ref, option: "a", note: nil), .move(ref, state: "dismissed"),
                                                .stage(ref, option: "c", note: nil), .move(ref, state: "implemented"),
                                                .stage(ref, option: "e", note: nil)],
                       "a move keeps its place in the queue; a stage replaces only the stage waiting right before it")
    }

    func testAStageKeepsWhatTheWriteBeforeItStagedAndItLeavesOut() {
        let note = DecisionLogAction.stage(ref, option: nil, note: "why")
        let pick = DecisionLogAction.stage(ref, option: "b", note: nil)
        XCTAssertEqual(note.keepingStaged(from: pick), .stage(ref, option: "b", note: "why"))
        XCTAssertEqual(note.keepingStaged(from: nil), note, "nothing earlier: the note alone")
        let repick = DecisionLogAction.stage(ref, option: "c", note: nil)
        XCTAssertEqual(repick.keepingStaged(from: pick), repick, "a newer pick wins")
        XCTAssertEqual(repick.keepingStaged(from: note), .stage(ref, option: "c", note: "why"),
                       "a pick after a note keeps the note")
        XCTAssertEqual(DecisionLogAction.stage(ref, option: "c", note: "").keepingStaged(from: note),
                       .stage(ref, option: "c", note: ""), "an explicit empty note is a clear and wins")
        XCTAssertEqual(DecisionLogAction.dismiss(ref).keepingStaged(from: pick), .dismiss(ref), "a dismiss never gets letters")
    }

    func testANoteQueuedBeforeAPickIsStillWritten() async {
        let log = FakeDecisionLog()
        log.holdNext = true
        let engine = engine(log)
        engine.stage(ref, option: "a", note: nil)
        await settle()
        engine.stage(ref, option: nil, note: "why")
        engine.stage(ref, option: "c", note: nil)
        log.release()
        await settle()
        XCTAssertEqual(log.actions, [.stage(ref, option: "a", note: nil), .stage(ref, option: "c", note: "why")],
                       "the pick replaced the queued note write and carried the note")
    }

    func testABatchUnstageWaitsForTheRunningWriteOfEveryDecisionItClears() async {
        let log = FakeDecisionLog()
        let engine = engine(log)
        let other = DecisionAddress(id: "d_5_s1", sessionId: "s1", number: 5)
        log.holdNext = true
        engine.stage(other, option: "a", note: nil)
        await settle()
        engine.stage(other, option: "b", note: nil)
        engine.unstage([ref, other])
        await settle()
        XCTAssertEqual(log.actions, [.stage(other, option: "a", note: nil)],
                       "the clear is not written while another decision's stage runs")
        log.release()
        await settle()
        XCTAssertEqual(log.actions, [.stage(other, option: "a", note: nil), .stage(other, option: "b", note: nil),
                                      .unstage([ref, other])], "the clear runs last, once, so no stage brings a pick back")
        XCTAssertFalse(engine.isWriting(ref.id))
        XCTAssertFalse(engine.isWriting(other.id))
    }

    func testADismissHeldForItsUndoWritesNothingUntilItsTimeAndUndoDropsIt() async {
        let log = FakeDecisionLog()
        let clock = ManualClock()
        let engine = engine(log, clock: clock)
        engine.hold(ref.id, .dismiss(ref), seconds: 5)
        XCTAssertTrue(engine.held.contains(ref.id))
        await clock.advance(by: .seconds(4))
        XCTAssertTrue(log.actions.isEmpty, "nothing reaches the log during the Undo window")
        engine.undo(ref.id)
        await clock.advance(by: .seconds(5))
        XCTAssertTrue(log.actions.isEmpty, "Undo drops the change; the log never saw it")
        XCTAssertFalse(engine.held.contains(ref.id))

        engine.hold(ref.id, .dismiss(ref), seconds: 5)
        engine.hold(ref.id, .dismiss(ref), seconds: 5)
        await clock.advance(by: .seconds(5))
        await settle()
        XCTAssertEqual(log.actions, [.dismiss(ref)], "the end of the window writes it, once")
        XCTAssertEqual(log.rows[ref.id]?.dismissed, true)

        let other = DecisionAddress(id: "d_5_s1", sessionId: "s1", number: 5, revision: 1)
        engine.hold(other.id, .dismiss(other))
        XCTAssertEqual(engine.heldActions(), [other.id: .dismiss(other)])
        engine.commit(other.id)
        await settle()
        XCTAssertEqual(log.actions.last, .dismiss(other), "a hold without a time is written when the surface says so")
    }

    func testAConcurrentAnswerFromAnotherClientOvertakesAPickThatLanded() async {
        let log = FakeDecisionLog()
        let engine = engine(log)
        engine.stage(ref, option: "a", note: nil)
        await settle()
        log.clockMs = (seconds + 1) * 1000
        log.otherClientStages(ref.id, option: "b")
        engine.reconcile(log.snapshot())
        XCTAssertNil(engine.pending[ref.id], "the phone's newer answer is the truth")
        XCTAssertEqual(engine.letters(ref.id, stored: log.rows[ref.id]?.option), "b")
    }

    func testAPickNoSnapshotShowsExpiresAfterItsLifetime() async {
        let log = FakeDecisionLog()
        let engine = engine(log)
        engine.stage(ref, option: "a", note: nil)
        await settle()
        let stale = [ref.id: DecisionAnswering.Engine.Row(option: "", note: nil)]
        engine.reconcile(stale)
        XCTAssertEqual(engine.letters(ref.id, stored: ""), "a", "a snapshot from before the write cannot drop the pick")
        seconds += DecisionAnswering.Engine.pendingLifetime + 1
        engine.reconcile(stale)
        XCTAssertNil(engine.pending[ref.id], "after its lifetime the snapshot is the truth again")
    }

    func testUnstageClearsEveryDecisionAtOnce() async {
        let log = FakeDecisionLog()
        let engine = engine(log)
        let other = DecisionAddress(id: "d_5_s1", sessionId: "s1", number: 5)
        engine.unstage([ref, other])
        XCTAssertEqual(engine.letters(ref.id, stored: "a"), "")
        XCTAssertEqual(engine.letters(other.id, stored: "b"), "")
        await settle()
        XCTAssertEqual(log.actions, [.unstage([ref, other])])
        engine.reconcile(log.snapshot())
        XCTAssertTrue(engine.pending.isEmpty)
    }

    /// The click rule of both surfaces: a click stages its letter (a second click clears it) or sends it at once, and
    /// ⇧ or a decision that takes a set toggles the letter and never sends.
    func testAClickPlansThePickAndWhetherItSends() {
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "", letter: "a", shift: false, stages: true) == ("a", false))
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "a", letter: "a", shift: false, stages: true) == ("", false),
                      "a second click clears the pick")
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "ac", letter: "b", shift: false, stages: false) == ("b", true),
                      "a click that sends sends its own letter")
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "a", letter: "c", shift: true, stages: false) == ("ac", false),
                      "⇧ adds the letter and stages")
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "", letter: "a", shift: false, stages: false, multiple: true)
                      == ("a", false))
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "a", letter: "c", shift: false, stages: false, multiple: true)
                      == ("ac", false))
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "ac", letter: "a", shift: false, stages: true, multiple: true)
                      == ("c", false))
        XCTAssertTrue(DecisionAnswering.clickPlan(letters: "a", letter: "b", shift: false, stages: true) == ("b", false),
                      "one option staging: the pick is replaced")
        XCTAssertEqual(DecisionAnswering.nextPick("a", "b", adding: false), "b", "a plain click picks that letter alone")
        XCTAssertEqual(DecisionAnswering.nextPick("ac", "a", adding: true), "c", "⇧-click on a picked letter removes it")
    }
}
