import Foundation
import XCTest

@testable import GenesisKit

/// A clock that moves only when a test moves it, so the popup's timers run without real waiting. `advance` resumes each
/// timer that ends in the step at its own deadline, oldest first, and lets the popup's task finish before the next one.
final class ManualClock: Clock, @unchecked Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration
        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        let deadline: Instant
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current = Instant(offset: .zero)
    private var sleepers: [UUID: Sleeper] = [:]

    var now: Instant { lock.withLock { current } }
    var minimumResolution: Duration { .zero }

    func sleep(until deadline: Instant, tolerance: Duration?) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let early: Result<Void, Error>? = lock.withLock {
                    if Task.isCancelled { return .failure(CancellationError()) }
                    if deadline <= current { return .success(()) }
                    sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
                    return nil
                }
                if let early { continuation.resume(with: early) }
            }
        } onCancel: {
            let sleeper = lock.withLock { sleepers.removeValue(forKey: id) }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    @MainActor
    func advance(by duration: Duration) async {
        await settle()
        let target = now.advanced(by: duration)
        while true {
            let due: Sleeper? = lock.withLock {
                guard let next = sleepers.filter({ $0.value.deadline <= target })
                    .min(by: { $0.value.deadline < $1.value.deadline }) else { return nil }
                sleepers[next.key] = nil
                current = max(current, next.value.deadline)
                return next.value
            }
            guard let due else { break }
            due.continuation.resume()
            await settle()
        }
        lock.withLock { current = target }
        await settle()
    }

    /// Lets the tasks the main actor has queued run, so a timer the popup just started is waiting before time moves.
    @MainActor
    private func settle() async {
        for _ in 0 ..< 20 { await Task.yield() }
    }
}

/// The widget around the popup, as far as the popup sees it: the facts it reads, and the effects it returns applied the
/// way `WidgetModel.applyAlertPopup` applies them. No `WidgetModel`, no binary and no snapshot.
@MainActor
private final class PopupHost: WidgetAlertPopupHost {
    let clock = ManualClock()
    let popup: WidgetAlertPopup
    var hoveredSurface: WidgetSurfaceID?
    var expanded: EdgePanelPlacement?
    var stopping = false
    var dialogOpen = false
    var dragging = false
    var pointerInside: Set<String> = []
    var moduleSelections: [String: String] = [:]
    var inbox = WidgetInboxSummary.empty
    var inboxGeneration = 0
    var inboxOverviewItems: [WidgetInboxItem] = []
    var sendingDecisionIDs: Set<String> = []
    var stagedForLeave: [WidgetInboxItem] = []
    var stagedItems: [WidgetInboxItem] = []
    var preferences = WidgetPreferences.hubDefaults
    /// The staged sends and the staged reminders the popup asked for.
    var stagedSends: [[String]] = []
    var reminders = 0

    init() {
        popup = WidgetAlertPopup(clock: clock)
        popup.host = self
    }

    func applyAlertPopup(_ effect: WidgetAlertPopup.Effect) {
        for choice in effect.modules { moduleSelections[choice.surface.key] = choice.id }
        switch effect.preview {
        case .show(let surface): hoveredSurface = surface
        case .hide: hoveredSurface = nil
        case nil: break
        }
        switch effect.staged {
        case .send(let items): stagedSends.append(items.map(\.sourceId))
        case .remind: reminders += 1
        case nil: break
        }
    }

    var item: WidgetInboxItem? { popup.item }
    var queue: [WidgetInboxItem] { popup.queue }
    var outcome: WidgetPeekOutcome? { popup.outcome }

    func show(_ item: WidgetInboxItem, on surface: WidgetSurfaceID, module: String? = nil, seconds: Double = 7,
              many: WidgetAlerts.PopupMany = .newest) {
        applyAlertPopup(popup.alertArrived(item, on: surface, module: module, seconds: seconds, many: many))
    }

    func showWaiting(_ item: WidgetInboxItem) { applyAlertPopup(popup.showWaiting(item)) }
    func dismiss(all: Bool = false) { applyAlertPopup(popup.dismiss(all: all)) }
    func end(advance: Bool = true) { applyAlertPopup(popup.end(advance: advance)) }
    func sent(_ ids: Set<String>) { applyAlertPopup(popup.sent(ids)) }

    func sendEnded(_ outcome: WidgetPeekOutcome, sent ids: Set<String>, delivered: Bool) {
        applyAlertPopup(popup.sendEnded(outcome, sent: ids, delivered: delivered))
    }

    /// The pointer as `WidgetModel.hover` reports it: the fact first, then the popup's event.
    func hover(_ surface: WidgetSurfaceID, inside: Bool) {
        if inside { pointerInside.insert(surface.key) } else { pointerInside.remove(surface.key) }
        if let effect = popup.pointer(surface, inside: inside) { applyAlertPopup(effect) }
    }

    /// A new inbox snapshot, as `WidgetModel.updateInbox` hands it over.
    func receive(_ summary: WidgetInboxSummary) {
        inboxGeneration += 1
        inbox = summary
        applyAlertPopup(popup.inboxChanged())
    }

    /// The panel folds, as `WidgetModel.collapse` does it.
    func collapse() {
        expanded = nil
        hoveredSurface = nil
        applyAlertPopup(popup.reset())
    }

    /// The user picks a module, as `WidgetModel.openModule` does it.
    func openModule(_ id: String, on surface: WidgetSurfaceID) {
        applyAlertPopup(popup.moduleOpened(on: surface))
        moduleSelections[surface.key] = id
        hoveredSurface = nil
        expanded = surface.edge
    }

    func advance(milliseconds: Int) async {
        await clock.advance(by: .milliseconds(milliseconds))
    }
}

/// The alert popup on its own interface: events and a clock in, the shown item, the queue and the outcome out
/// (C28, 2026-11-14). The wiring through `WidgetModel` and the coordinator is tested in EdgePanelGeometryTests and
/// WidgetInboxTasksPolishTests.
@MainActor
final class WidgetAlertPopupTests: XCTestCase {
    private let side = WidgetSurfaceID(edge: .right)

    private func decision(_ number: Int, pick: String? = nil) -> WidgetInboxItem {
        WidgetInboxItem(id: "decision:d_\(number)_s", sourceId: "d_\(number)_s", kind: "decision",
            key: "local:claude:s:", at: Double(number) * 1_000, needsAnswer: true, title: "Ship \(number)?",
            number: number, revision: 1, draftOption: pick)
    }

    private func decision(_ id: String, at: Double = 1) -> WidgetInboxItem {
        WidgetInboxItem(id: "decision:" + id, sourceId: id, kind: "decision", key: "k", at: at, needsAnswer: true)
    }

    private func summary(pending: [String]?, complete: Bool = true, answered: [WidgetInboxItem]? = nil)
        -> WidgetInboxSummary {
        var result = WidgetInboxSummary(unread: 0, needsAnswer: 0, complete: complete, truncated: true, sessions: [])
        result.pendingDecisionIDs = pending
        result.answeredElsewhere = answered
        return result
    }

    /// A popup shows the agents module and gives the user's own module back when it ends, unless the user picked a
    /// module during the popup. The popup only returns the choices; the host writes them.
    func testThePopupGivesTheModuleBackUnlessTheUserPickedAnother() async {
        let host = PopupHost()
        let top = WidgetSurfaceID(edge: .top)
        let alert = decision(5)

        host.moduleSelections[side.key] = "capture"
        host.show(alert, on: side, module: "agents", seconds: 0.1)
        XCTAssertEqual(host.item, alert)
        XCTAssertEqual(host.hoveredSurface, side, "the popup opens its surface's preview")
        XCTAssertEqual(host.moduleSelections[side.key], "agents", "the popup shows the agents module")
        await host.advance(milliseconds: 100)
        XCTAssertNil(host.item)
        XCTAssertNil(host.hoveredSurface, "the end of the popup closes the preview")
        XCTAssertEqual(host.moduleSelections[side.key], "capture", "the end of the popup gives the user's module back")

        host.show(alert, on: side, module: "agents", seconds: 60)
        host.show(alert, on: side, module: "agents", seconds: 60)
        host.collapse()
        XCTAssertEqual(host.moduleSelections[side.key], "capture", "a reset ends a repeated popup the same way")

        host.moduleSelections[side.key] = nil
        host.show(alert, on: side, module: "agents", seconds: 60)
        host.collapse()
        XCTAssertNil(host.moduleSelections[side.key], "no module chosen before the popup: none after it")

        host.moduleSelections[side.key] = "capture"
        host.show(alert, on: side, module: "agents", seconds: 60)
        host.openModule("tasks", on: side)
        XCTAssertNil(host.item, "a module pick ends the popup")
        host.collapse()
        XCTAssertEqual(host.moduleSelections[side.key], "tasks", "a module the user picked during the popup stays")

        host.moduleSelections[side.key] = "capture"
        host.show(alert, on: side, module: "agents", seconds: 60)
        host.openModule("tasks", on: top)
        XCTAssertEqual(host.moduleSelections[side.key], "capture", "a pick on another surface gives the popup's back")
        XCTAssertEqual(host.moduleSelections[top.key], "tasks")
        host.collapse()

        host.moduleSelections[side.key] = "capture"
        host.show(alert, on: side, module: "agents", seconds: 0.1)
        host.expanded = .right
        await host.advance(milliseconds: 100)
        XCTAssertNil(host.item)
        XCTAssertEqual(host.moduleSelections[side.key], "agents", "an open panel keeps the popup's module under the user")
        host.collapse()
        XCTAssertEqual(host.moduleSelections[side.key], "capture", "closing that panel gives the user's module back")
    }

    /// The one rule for a new popup: never in a panel, a window, a drag, under the pointer, or in another preview.
    func testAPopupIsRefusedWhileTheUserIsInTheWidget() {
        let host = PopupHost()
        let top = WidgetSurfaceID(edge: .top)
        XCTAssertTrue(host.popup.canShow(on: side))
        host.pointerInside = [side.key]
        XCTAssertFalse(host.popup.canShow(on: side), "the pointer is on a panel")
        host.moduleSelections[side.key] = "capture"
        host.show(decision(1), on: side, module: "agents")
        XCTAssertNil(host.item)
        XCTAssertEqual(host.moduleSelections[side.key], "capture", "a refused popup keeps the selected module")
        host.pointerInside = []
        host.hoveredSurface = top
        XCTAssertFalse(host.popup.canShow(on: side), "another surface's preview is open")
        host.hoveredSurface = nil
        host.expanded = .right
        XCTAssertFalse(host.popup.canShow(on: side), "a panel is open")
        host.expanded = nil
        host.dragging = true
        XCTAssertFalse(host.popup.canShow(on: side), "a drag")
        host.dragging = false
        host.dialogOpen = true
        XCTAssertFalse(host.popup.canShow(on: side), "a window")
        host.dialogOpen = false
        host.stopping = true
        XCTAssertFalse(host.popup.canShow(on: side), "the widget stops")
    }

    /// A pick staged in a decision's popup stays shown once the snapshot lists it as staged, and an unstage clears it.
    func testAPickStagedInThePopupStaysShownAfterTheSnapshotListsIt() {
        let host = PopupHost()
        host.show(decision(1), on: side, seconds: 60, many: .list)
        host.show(decision(2), on: side, seconds: 60, many: .list)
        host.popup.stagingChanged([decision(1, pick: "a"), decision(2, pick: "b")])
        XCTAssertEqual(host.item?.draftOption, "a", "the popup shows the staged pick")
        XCTAssertEqual(host.queue.first?.draftOption, "b", "a listed alert shows its staged pick too")
        host.popup.stagingChanged([decision(2, pick: "b")])
        XCTAssertNil(host.item?.draftOption, "an unstaged decision reads as waiting again")

        host.sent(["d_1_s"])
        XCTAssertEqual(host.item?.sourceId, "d_2_s", "a sent decision leaves the popup for the next alert")
        XCTAssertEqual(host.queue, [])
        host.sent(["d_2_s"])
        XCTAssertNil(host.item, "the popup closes once its last decision was sent")
    }

    /// A send from the popup shows its result in the popup before it moves on; one no receiver took stays, with
    /// Send again, until it is closed (ux audit F5).
    func testASendFromThePopupShowsItsOutcomeThere() {
        let host = PopupHost()
        let item = decision(1)
        host.show(item, on: side, seconds: 60, many: .list)
        host.sendEnded(WidgetPeekOutcome(text: "Not delivered to s.", tone: .warning, sendAgain: [item]),
                       sent: ["d_1_s"], delivered: false)
        XCTAssertEqual(host.item?.sourceId, "d_1_s", "a send no receiver took stays in the popup")
        XCTAssertEqual(host.outcome?.tone, .warning)
        XCTAssertEqual(host.outcome?.sendAgain.map(\.sourceId), ["d_1_s"])
        host.dismiss(all: true)
        XCTAssertNil(host.outcome, "the outcome leaves with its alert")
    }

    func testQueuedDecisionsUseOnlyNewerCompleteAuthoritativeSnapshots() {
        let host = PopupHost()
        let first = decision("first", at: 1), waiting = decision("waiting", at: 2)
        func begin() {
            host.collapse()
            host.show(first, on: side, seconds: 0, many: .queue)
            host.show(waiting, on: side, seconds: 0, many: .queue)
        }
        host.receive(summary(pending: []))
        begin()
        host.dismiss()
        XCTAssertEqual(host.item, waiting, "a snapshot older than the arrival cannot settle it")
        begin()
        host.receive(summary(pending: [], complete: false))
        host.dismiss()
        XCTAssertEqual(host.item, waiting, "an incomplete read cannot settle it")
        begin()
        host.receive(summary(pending: nil))
        host.dismiss()
        XCTAssertEqual(host.item, waiting, "an older hub cannot prove settlement")
        begin()
        host.receive(summary(pending: ["waiting"]))
        XCTAssertEqual(host.item, waiting, "the pending decision omitted by the capped overview is promoted")
        host.dismiss()
        XCTAssertNil(host.item, "explicit dismissal closes the promoted alert")
        begin()
        host.receive(summary(pending: []))
        host.dismiss()
        XCTAssertNil(host.item, "a newer complete decision list skips a settled item")
    }

    func testListedDecisionUsesOnlyNewerCompleteAuthoritativeSnapshots() {
        let host = PopupHost()
        let first = decision("first", at: 1), waiting = decision("waiting", at: 2)
        func begin() {
            host.collapse()
            host.show(first, on: side, seconds: 0, many: .list)
            host.show(waiting, on: side, seconds: 0, many: .list)
        }
        host.receive(summary(pending: []))
        begin()
        host.showWaiting(waiting)
        XCTAssertEqual(host.item, waiting, "an older snapshot cannot settle the alert")
        begin()
        host.receive(summary(pending: [], complete: false))
        host.showWaiting(waiting)
        XCTAssertEqual(host.item, waiting, "an incomplete snapshot cannot settle the alert")
        begin()
        host.receive(summary(pending: nil))
        host.showWaiting(waiting)
        XCTAssertEqual(host.item, waiting, "an older hub cannot prove settlement")
        begin()
        host.receive(summary(pending: ["waiting"]))
        host.showWaiting(waiting)
        XCTAssertEqual(host.item, waiting, "a pending alert can still be selected")
        begin()
        host.receive(summary(pending: ["first"]))
        host.showWaiting(waiting)
        XCTAssertEqual(host.item, first, "a settled alert is not shown again")
        XCTAssertTrue(host.queue.isEmpty, "the settled row is removed")
        begin()
        host.receive(summary(pending: ["waiting"]))
        XCTAssertEqual(host.item, waiting, "a settled displayed alert promotes the pending listed alert")
        XCTAssertTrue(host.queue.isEmpty, "the settled displayed alert does not return to the list")
        begin()
        host.receive(summary(pending: []))
        XCTAssertNil(host.item, "the popup closes when both decisions settle")
    }

    func testSettledSnapshotKeepsInFlightSendAndDisplayedOutcome() {
        for snapshotFirst in [true, false] {
            for delivered in [true, false] {
                let host = PopupHost()
                let item = decision("sending")
                host.show(item, on: side, seconds: 0)
                host.sendingDecisionIDs.insert(item.sourceId)
                XCTAssertTrue(host.popup.keepsSettled(item))
                XCTAssertFalse(host.popup.keepsSettled(decision("another-decision")),
                               "another send must not hold an unrelated alert")
                let settled = summary(pending: [])
                if snapshotFirst {
                    host.receive(settled)
                    XCTAssertEqual(host.item?.sourceId, item.sourceId, "the in-flight send retains its popup")
                    XCTAssertNil(host.outcome)
                }
                host.sendingDecisionIDs.remove(item.sourceId)
                host.sendEnded(WidgetPeekOutcome(text: "Result", tone: delivered ? .success : .warning,
                                                 sendAgain: delivered ? [] : [item]),
                               sent: [item.sourceId], delivered: delivered)
                host.receive(settled)
                XCTAssertEqual(host.item?.sourceId, item.sourceId, "a displayed result survives settlement")
                XCTAssertEqual(host.outcome?.tone, delivered ? .success : .warning)
                XCTAssertEqual(host.outcome?.sendAgain.map(\.sourceId), delivered ? [] : [item.sourceId])
            }
        }
    }

    func testEachPopupKeepsItsDurationAcrossListAndQueue() async {
        let host = PopupHost()
        let first = decision("first", at: 1), second = decision("second", at: 2)

        host.show(first, on: side, seconds: 0, many: .list)
        host.show(second, on: side, seconds: 0.2, many: .list)
        await host.advance(milliseconds: 350)
        XCTAssertEqual(host.item, first, "a finite arrival cannot close an until-closed alert")
        host.showWaiting(second)
        await host.advance(milliseconds: 350)
        XCTAssertNil(host.item, "an accessibility swap starts the new finite timer")

        host.show(first, on: side, seconds: 0.2, many: .list)
        host.show(second, on: side, seconds: 0, many: .list)
        host.hover(side, inside: true)
        host.showWaiting(second)
        await host.advance(milliseconds: 350)
        XCTAssertEqual(host.item, second, "swapping to until-closed retains that duration while hovered")
        host.hover(side, inside: false)
        await host.advance(milliseconds: 300)
        XCTAssertEqual(host.item, second, "leaving does not close the until-closed swap")
        host.collapse()

        host.show(first, on: side, seconds: 0.2, many: .queue)
        host.show(second, on: side, seconds: 0, many: .queue)
        await host.advance(milliseconds: 350)
        XCTAssertEqual(host.item, second, "until-closed waits until the first finite alert expires")
        await host.advance(milliseconds: 300)
        XCTAssertEqual(host.item, second, "the promoted until-closed alert stays")
        host.collapse()

        host.show(first, on: side, seconds: 0, many: .queue)
        host.show(second, on: side, seconds: 0.2, many: .queue)
        host.hover(side, inside: true)
        host.hover(side, inside: false)
        await host.advance(milliseconds: 350)
        XCTAssertEqual(host.item, first, "hover exit uses the shown alert's own zero duration")
        host.dismiss()
        await host.advance(milliseconds: 350)
        XCTAssertNil(host.item, "the promoted finite alert uses its own duration")
    }

    /// Several alerts in one popup (Alerts → Several at once), a popup that stays until it is closed, and a pointer
    /// that leaves the popup: the countdown starts again instead of closing it 220 ms later.
    func testAnOpenPopupListsOrQueuesLaterAlertsAndKeepsItsTimeAfterThePointerLeaves() async {
        let host = PopupHost()
        let first = decision(1), second = decision(2), third = decision(3)

        host.show(first, on: side, seconds: 60, many: .list)
        host.show(second, on: side, seconds: 60, many: .list)
        host.show(second, on: side, seconds: 60, many: .list)
        XCTAssertEqual(host.item, first, "a listed alert never replaces the one shown")
        XCTAssertEqual(host.queue, [second], "the same alert is listed once")
        host.showWaiting(second)
        XCTAssertEqual(host.item, second, "a click on a listed alert shows it")
        XCTAssertEqual(host.queue, [first], "the one shown takes its row")
        host.dismiss()
        XCTAssertNil(host.item, "× closes the whole list")
        XCTAssertEqual(host.queue, [])

        host.show(first, on: side, seconds: 60, many: .queue)
        host.show(second, on: side, seconds: 60, many: .queue)
        host.show(third, on: side, seconds: 60, many: .queue)
        host.dismiss()
        XCTAssertEqual(host.item, second, "× in a queue shows the next alert")
        XCTAssertEqual(host.queue, [third])
        host.dismiss(all: true)
        XCTAssertNil(host.item, "a click elsewhere closes the queue")
        XCTAssertEqual(host.queue, [])

        host.show(first, on: side, seconds: 60, many: .newest)
        host.show(second, on: side, seconds: 60, many: .newest)
        XCTAssertEqual(host.item, second, "newest replaces")
        XCTAssertEqual(host.queue, [])
        host.collapse()

        host.show(first, on: side, seconds: 0.3, many: .queue)
        host.show(second, on: side, seconds: 0.3, many: .queue)
        await host.advance(milliseconds: 300)
        XCTAssertEqual(host.item, second, "a queued alert shows when the one before it times out")
        await host.advance(milliseconds: 300)
        XCTAssertNil(host.item, "the last one in the queue times out too")

        host.show(first, on: side, seconds: 0, many: .list)
        await host.advance(milliseconds: 400)
        XCTAssertEqual(host.item, first, "0 seconds keeps the popup until it is closed")
        host.hover(side, inside: true)
        host.show(second, on: side, seconds: 0, many: .list)
        XCTAssertEqual(host.queue, [second], "a later alert is listed with the pointer on the popup")
        host.hover(side, inside: false)
        await host.advance(milliseconds: 400)
        XCTAssertEqual(host.item, first, "until closed: leaving the popup does not close it")
        host.collapse()

        // A decision answered in the chat while its alert is shown or listed takes that alert's place.
        let answeredFirst = WidgetInboxItem(id: first.id, sourceId: first.sourceId, kind: "decision", key: first.key,
            at: 9_000, needsAnswer: false, title: first.title, number: 1, options: ["yes", "no"], option: "a",
            answeredVia: "agent")
        let answeredSecond = WidgetInboxItem(id: second.id, sourceId: second.sourceId, kind: "decision",
            key: second.key, at: 9_500, needsAnswer: false, title: second.title, number: 2, option: "b",
            answeredVia: "automatic_heuristic")
        host.show(first, on: side, seconds: 60, many: .list)
        host.show(second, on: side, seconds: 60, many: .list)
        host.show(answeredFirst, on: side, seconds: 60, many: .list)
        XCTAssertEqual(host.item, answeredFirst, "the shown alert becomes its answer")
        host.show(answeredSecond, on: side, seconds: 60, many: .newest)
        XCTAssertEqual(host.queue, [answeredSecond], "a listed alert becomes its answer in its row")
        host.collapse()

        host.show(first, on: side, seconds: 0.8, many: .list)
        await host.advance(milliseconds: 500)
        host.hover(side, inside: true)
        host.hover(side, inside: false)
        await host.advance(milliseconds: 400)
        XCTAssertEqual(host.item, first, "leaving starts the countdown again; it closed after 220 ms before")
        await host.advance(milliseconds: 400)
        XCTAssertNil(host.item, "the countdown still ends it")
    }

    /// "Closing with staged decisions": "keep" ends the popup at its time and asks for the staged reminder, "ask"
    /// keeps it while a pick is staged in it (also on ×), and "send" sends what is staged in it.
    func testAStagedPickHoldsThePopupAsTheStagedPolicySays() async {
        let host = PopupHost()
        let item = decision(1)
        var staged = item
        staged.draftOption = "a"

        host.preferences.stagedOnLeave = "keep"
        host.show(item, on: side, seconds: 0.05)
        host.stagedForLeave = [staged]
        host.popup.stagingChanged([staged])
        await host.advance(milliseconds: 200)
        XCTAssertNil(host.item, "the timer survives the updated item")
        XCTAssertEqual(host.reminders, 1, "\"keep\" shows the staged reminder")

        host.preferences.stagedOnLeave = "ask"
        host.show(staged, on: side, seconds: 0.05)
        await host.advance(milliseconds: 300)
        XCTAssertEqual(host.item?.sourceId, "d_1_s", "the popup stays with its Send now")
        host.dismiss()
        XCTAssertNotNil(host.item, "explicit close retains a staged decision under ask")
        host.stagedForLeave = []
        await host.advance(milliseconds: 300)
        XCTAssertNil(host.item, "with nothing staged in it, its time ends it")

        host.preferences.stagedOnLeave = "send"
        host.stagedForLeave = [staged]
        host.show(staged, on: side, seconds: 0.05)
        await host.advance(milliseconds: 50)
        XCTAssertEqual(host.stagedSends, [["d_1_s"]], "\"send\" sends the pick staged in the popup")
        XCTAssertNotNil(host.item, "and the popup stays for the result")
        XCTAssertEqual(host.reminders, 1)
    }

    func testLeavingPopupDoesNotReplaceOutcomeLifetime() async {
        let host = PopupHost()
        let item = decision(1)
        host.show(item, on: side, seconds: 0.05)
        host.sendEnded(WidgetPeekOutcome(text: "Not delivered", tone: .warning), sent: [item.sourceId], delivered: false)
        host.hover(side, inside: true)
        host.hover(side, inside: false)
        await host.advance(milliseconds: 150)
        XCTAssertEqual(host.outcome?.text, "Not delivered")
        XCTAssertNotNil(host.item)
        host.end(advance: false)

        host.preferences.sendCloseSeconds = 0
        host.show(item, on: side, seconds: 0.05)
        host.sendEnded(WidgetPeekOutcome(text: "Delivered", tone: .success), sent: [item.sourceId], delivered: true)
        host.hover(side, inside: true)
        host.hover(side, inside: false)
        await host.advance(milliseconds: 150)
        XCTAssertEqual(host.outcome?.text, "Delivered", "zero send-close time remains open")
        host.end(advance: false)
    }

    func testSentPopupStartsTheNextAlertsOwnCountdownInQueueAndListModes() async {
        for many in [WidgetAlerts.PopupMany.queue, .list] {
            let host = PopupHost()
            let item = decision(1)
            var later = item
            later.id = "decision:later"
            later.sourceId = "later"
            host.show(item, on: side, seconds: 0, many: many)
            host.show(later, on: side, seconds: 0.05, many: many)
            host.sent([item.sourceId])
            XCTAssertEqual(host.item?.sourceId, "later")
            XCTAssertEqual(host.popup.seconds, 0.05, "the next alert gets its own duration")
            await host.advance(milliseconds: 300)
            XCTAssertNil(host.item, "the next alert does not inherit an already finished timer")
        }
    }

    func testSettledPopupKeepsDeliveredOutcomeForItsConfiguredLifetime() async {
        let host = PopupHost()
        host.preferences.sendCloseSeconds = 0.4
        let item = decision(1)
        var later = item
        later.id = "decision:later"
        later.sourceId = "later"
        host.show(item, on: side, seconds: 0.05, many: .list)
        host.sendEnded(WidgetPeekOutcome(text: "Delivered", tone: .success), sent: [item.sourceId], delivered: true)
        host.show(later, on: side, seconds: 0.4, many: .list)
        var answered = item
        answered.needsAnswer = false
        answered.answeredVia = "agent"
        host.show(answered, on: side, seconds: 0.05, many: .list)
        host.receive(summary(pending: ["later"], answered: [answered]))
        XCTAssertEqual(host.item?.sourceId, item.sourceId)
        XCTAssertEqual(host.outcome?.text, "Delivered")
        XCTAssertEqual(host.queue.map(\.sourceId), ["later"])
        await host.advance(milliseconds: 150)
        XCTAssertEqual(host.outcome?.text, "Delivered", "neither snapshot nor new alert shortens the outcome")
        await host.advance(milliseconds: 400)
        XCTAssertEqual(host.item?.sourceId, "later", "the pending alert follows the configured outcome lifetime")
        XCTAssertNil(host.outcome)
    }

    func testSettledPopupKeepsFailureAndOnlyRemovesProvenStaleResend() {
        let host = PopupHost()
        let item = decision(1)
        var other = item
        other.id = "decision:other"
        other.sourceId = "other"
        var answered = item
        answered.needsAnswer = false
        answered.answeredVia = "agent"
        var snapshot = summary(pending: [], answered: [answered])
        host.receive(snapshot)
        host.show(item, on: side, seconds: 0)
        host.sendEnded(WidgetPeekOutcome(text: "Not delivered", tone: .warning, sendAgain: [item, other]),
                       sent: [item.sourceId], delivered: false)
        XCTAssertEqual(host.outcome?.sendAgain.map(\.sourceId), [item.sourceId, "other"],
                       "the older snapshot cannot settle the new outcome")
        snapshot.complete = false
        host.receive(snapshot)
        XCTAssertEqual(host.outcome?.sendAgain.map(\.sourceId), [item.sourceId, "other"],
                       "an incomplete snapshot cannot remove resend controls")
        snapshot.complete = true
        snapshot.answeredElsewhere = []
        host.receive(snapshot)
        XCTAssertEqual(host.outcome?.sendAgain.map(\.sourceId), [item.sourceId, "other"],
                       "an answered but undelivered decision is absent from pending IDs")
        snapshot.answeredElsewhere = [answered]
        host.receive(snapshot)
        XCTAssertEqual(host.outcome?.sendAgain.map(\.sourceId), ["other"])
        XCTAssertEqual(host.outcome?.text, "Not delivered")
        XCTAssertEqual(host.item?.sourceId, item.sourceId, "failure stays until dismissed")
    }

    func testOnlyNewerCompleteSnapshotSettlesOrdinaryPopupControls() {
        let host = PopupHost()
        let item = decision(1)
        var later = item
        later.id = "decision:later"
        later.sourceId = "later"
        var snapshot = summary(pending: [])
        host.receive(snapshot)
        host.show(item, on: side, seconds: 0, many: .list)
        host.show(later, on: side, seconds: 0, many: .list)
        XCTAssertEqual(host.item?.sourceId, item.sourceId, "an older snapshot does not settle a new alert")
        snapshot.complete = false
        host.receive(snapshot)
        XCTAssertEqual(host.queue.map(\.sourceId), ["later"])
        snapshot.complete = true
        snapshot.pendingDecisionIDs = nil
        host.receive(snapshot)
        XCTAssertEqual(host.item?.sourceId, item.sourceId, "an older hub cannot prove settlement")
        snapshot.pendingDecisionIDs = ["later"]
        host.receive(snapshot)
        XCTAssertEqual(host.item?.sourceId, "later", "a pending listed alert replaces the settled one")
        XCTAssertTrue(host.queue.isEmpty)
        snapshot.pendingDecisionIDs = []
        host.receive(snapshot)
        XCTAssertNil(host.item, "the last settled alert closes")
    }
}
