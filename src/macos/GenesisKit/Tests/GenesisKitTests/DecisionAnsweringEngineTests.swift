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
    var actions: [DecisionAction] = []
    /// Answers for the next actions, oldest first; without one a write lands.
    var answers: [DecisionLogAnswer] = []
    /// Set: the next write waits here until `release()`.
    var holdNext = false
    private var waiting: CheckedContinuation<Void, Never>?
    /// Milliseconds since 1970 of the next row change; the engine of a test runs at 1,000 s.
    var clockMs: Double = 0

    func run(_ action: DecisionAction) async -> DecisionLogAnswer {
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
        case .dismiss(let ref):
            rows[ref.id, default: Row()].dismissed = true
        case .send:
            break
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

    func testANoteKeepsThePickOfTheWriteBeforeIt() {
        let note = DecisionAction.stage(ref, option: nil, note: "why")
        let pick = DecisionAction.stage(ref, option: "b", note: nil)
        XCTAssertEqual(note.keepingPick(from: pick), .stage(ref, option: "b", note: "why"))
        XCTAssertEqual(note.keepingPick(from: nil), note, "nothing earlier: the note alone")
        let repick = DecisionAction.stage(ref, option: "c", note: nil)
        XCTAssertEqual(repick.keepingPick(from: pick), repick, "a newer pick wins")
        XCTAssertEqual(DecisionAction.dismiss(ref).keepingPick(from: pick), .dismiss(ref), "a dismiss never gets letters")
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
