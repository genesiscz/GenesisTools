import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The notice stack on a clock the test moves: several notices at once, each with its own time, a pointer over the
/// stack stops every clock, an error stays, and an Undo waits in its place for its result.
@MainActor
final class NoticeStackTests: XCTestCase {
    private func stack(_ clock: ManualNoticeClock, timing: NoticeStackTiming = .standard) -> NoticeStackModel {
        NoticeStackModel(clock: clock, timing: { timing }, announces: false)
    }

    private func texts(_ model: NoticeStackModel) -> [String] { model.notices.map(\.text) }

    func testThreePushesGiveThreeNoticesThatLeaveEachAfterItsOwnTime() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        model.push(StackedNotice(text: "Label added"))
        model.push(StackedNotice(text: "Confirmed “jason” → “JSON”", actions: [.undo { _ in }]))
        model.push(StackedNotice(text: "Exported", lasting: .seconds(10)))
        XCTAssertEqual(texts(model), ["Label added", "Confirmed “jason” → “JSON”", "Exported"],
                       "a new notice joins the others; none replaces the one before")

        clock.advance(by: 5.9)
        XCTAssertEqual(model.notices.count, 3)
        clock.advance(by: 0.1)
        XCTAssertEqual(texts(model), ["Confirmed “jason” → “JSON”", "Exported"], "a plain notice leaves after the plain time")
        clock.advance(by: 4)
        XCTAssertEqual(texts(model), ["Confirmed “jason” → “JSON”"], "a notice with its own time leaves at that time")
        clock.advance(by: 19.9)
        XCTAssertEqual(model.notices.count, 1, "a notice with an Undo stays the longer action time")
        clock.advance(by: 0.1)
        XCTAssertTrue(model.notices.isEmpty)
        XCTAssertEqual(clock.pendingCount, 0, "every timer fired or was cancelled")
    }

    func testTwoAnswersInARowKeepTwoUndoButtons() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        var undone: [String] = []
        model.push(StackedNotice(text: "Answered: JSON", actions: [.undo { _ in undone.append("first") }]))
        clock.advance(by: 2)
        model.push(StackedNotice(text: "Answered: Dana Example", actions: [.undo { _ in undone.append("second") }]))
        XCTAssertEqual(model.notices.map { $0.actions.map(\.label) }, [["Undo"], ["Undo"]])

        let first = model.notices[0]
        model.press(first.actions[0], of: first.id)
        XCTAssertEqual(undone, ["first"], "the first answer's Undo takes back the first answer")
        XCTAssertEqual(model.notices.count, 2, "an Undo waits in its place for its result")
        XCTAssertEqual(model.waiting[first.id], "Undoing…")
    }

    /// `maxVisible`: the newest notices show, the older ones fold into "+N more", and a stack within the limit folds none.
    func testOlderNoticesPastTheVisibleLimitFoldIntoACount() {
        let clock = ManualNoticeClock()
        var limit: Int? = 3
        let model = NoticeStackModel(clock: clock, timing: { .standard }, maxVisible: { limit }, announces: false)
        for index in 1...5 { model.push(StackedNotice(text: "Notice \(index)")) }
        XCTAssertEqual(model.visibleLimit, 3)
        let split = NoticeStackModel.split(model.notices, max: model.visibleLimit)
        XCTAssertEqual(split.shown.map(\.text), ["Notice 3", "Notice 4", "Notice 5"], "the newest three show")
        XCTAssertEqual(split.folded.map(\.text), ["Notice 1", "Notice 2"], "the two oldest fold into +2 more")
        XCTAssertEqual(NoticeStackModel.split(Array(model.notices.prefix(3)), max: 3).folded.count, 0)
        limit = nil
        XCTAssertEqual(NoticeStackModel.split(model.notices, max: model.visibleLimit).shown.count, 5, "no limit shows all")
    }

    func testAPushUnderAWaitingNoticesIDEndsTheWait() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        let id = model.push(StackedNotice(text: "Confirmed", actions: [.undo { _ in }]))
        let undo = model.notices[0].actions[0]
        model.press(undo, of: id)
        XCTAssertEqual(model.waiting[id], "Undoing…")
        model.push(StackedNotice(id: id, text: "Suggested again"))
        XCTAssertNil(model.waiting[id], "the new notice under the same id is the wait's answer")
        clock.advance(by: 6)
        XCTAssertTrue(model.notices.isEmpty, "its clock runs: it leaves after the plain time")
    }

    /// The clock counts time across a sleep (`SystemNoticeClock` counts it since Wave B): a notice shown before the Mac
    /// slept has used that time when the pointer stops the clocks after it wakes.
    func testTimeThatPassedWhileTheMacSleptCountsAgainstANotice() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        let id = model.push(StackedNotice(text: "Confirmed", actions: [.undo { _ in }]))
        clock.advance(by: 25)
        model.setPaused(true)
        XCTAssertEqual(model.remaining(id) ?? -1, 5, accuracy: 0.001)
        let system = SystemNoticeClock()
        let monotonic = Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
        XCTAssertEqual(system.now, monotonic, accuracy: 0.5, "the app's clock is the one that counts sleep")
    }

    func testThePointerOverTheStackStopsEveryClock() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        let plain = model.push(StackedNotice(text: "Label added"))
        let undo = model.push(StackedNotice(text: "Confirmed", actions: [.undo { _ in }]))
        clock.advance(by: 4)
        model.setPaused(true)
        XCTAssertEqual(clock.pendingCount, 0, "no timer runs while the pointer is over the stack")
        clock.advance(by: 600)
        XCTAssertEqual(model.notices.count, 2, "nothing leaves under the pointer")
        XCTAssertEqual(model.remaining(plain), 2)
        XCTAssertEqual(model.remaining(undo), 26)

        model.setPaused(false)
        clock.advance(by: 1.9)
        XCTAssertTrue(model.contains(plain), "the clock goes on from where it stopped, not from zero")
        clock.advance(by: 0.1)
        XCTAssertFalse(model.contains(plain))
        XCTAssertTrue(model.contains(undo))
    }

    func testAnErrorStaysUntilItIsClosed() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        var retried = 0
        let error = model.push(StackedNotice(text: "The meetings command failed.", more: "exit 1", tone: .error,
                                             actions: [.retry { retried += 1 }]))
        model.push(StackedNotice(text: "Skipped: it is confirmed already.", tone: .warning))
        clock.advance(by: 3600)
        XCTAssertEqual(texts(model), ["The meetings command failed."], "the warning left, the error stays")
        XCTAssertNil(model.remaining(error), "an error has no time")

        model.press(model.notices[0].actions[0], of: error)
        XCTAssertEqual(retried, 1)
        XCTAssertTrue(model.notices.isEmpty, "Retry closes the error: the new attempt reports on its own")

        let again = model.push(StackedNotice(text: "Failed again.", tone: .error))
        model.dismiss(again)
        XCTAssertTrue(model.notices.isEmpty, "the close button takes it away")
    }

    func testAResultReplacesItsNoticeInPlaceWithAFreshClock() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        var undoneID: StackedNotice.ID?
        model.push(StackedNotice(text: "A"))
        let confirmed = model.push(StackedNotice(text: "Confirmed B", actions: [.undo { undoneID = $0 }]))
        model.push(StackedNotice(text: "C", lasting: .untilDismissed))

        model.press(model.notices[1].actions[0], of: confirmed)
        XCTAssertEqual(undoneID, confirmed, "the action gets the notice's id")
        clock.advance(by: 120)
        XCTAssertEqual(texts(model), ["Confirmed B", "C"], "a waiting notice does not leave; the plain one did")

        let replaced = model.push(StackedNotice(text: "Suggested again: B"), replacing: confirmed)
        XCTAssertEqual(replaced, confirmed, "the result keeps the notice's id, so its row updates in place")
        XCTAssertEqual(texts(model), ["Suggested again: B", "C"], "the result takes the notice's place, not the top")
        XCTAssertNil(model.waiting[confirmed])
        XCTAssertEqual(model.remaining(confirmed), 6, "the result counts its own time from now")
        clock.advance(by: 6)
        XCTAssertEqual(texts(model), ["C"])
    }

    func testAWaitingNoticeWhoseActionDidNotStartGetsItsButtonsBack() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        let id = model.push(StackedNotice(text: "Confirmed", actions: [.undo { _ in }]))
        clock.advance(by: 10)
        model.press(model.notices[0].actions[0], of: id)
        clock.advance(by: 100)
        model.release(id)
        XCTAssertNil(model.waiting[id], "the Undo is offered again")
        XCTAssertEqual(model.remaining(id), 20, "its clock goes on from where the press stopped it")
    }

    func testAResultForANoticeAlreadyClosedGoesOnTop() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        let gone = model.push(StackedNotice(text: "Confirmed", actions: [.undo { _ in }]))
        model.push(StackedNotice(text: "Other", lasting: .untilDismissed))
        model.dismiss(gone)
        model.push(StackedNotice(text: "Suggested again"), replacing: gone)
        XCTAssertEqual(texts(model), ["Other", "Suggested again"])
    }

    func testAKeptActionLeavesTheNoticeAndItsTime() {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        var shown = 0
        let id = model.push(StackedNotice(text: "Exported m.md",
                                          actions: [.init("Show", symbol: "folder", afterPress: .keep) { _ in shown += 1 }]))
        clock.advance(by: 10)
        model.press(model.notices[0].actions[0], of: id)
        XCTAssertEqual(shown, 1)
        XCTAssertEqual(model.remaining(id), 20, "Show leaves the notice where it is, counting on")
    }

    func testTheTimingIsReadAtEachPush() {
        let clock = ManualNoticeClock()
        var timing = NoticeStackTiming(actionSeconds: 8, plainSeconds: 4)
        let model = NoticeStackModel(clock: clock, timing: { timing }, announces: false)
        let short = model.push(StackedNotice(text: "Confirmed", actions: [.undo { _ in }]))
        timing.actionSeconds = 60
        let long = model.push(StackedNotice(text: "Rejected", actions: [.undo { _ in }]))
        XCTAssertEqual(model.remaining(short), 8, "a changed setting does not stretch a notice on screen")
        XCTAssertEqual(model.remaining(long), 60, "the next notice stays the new time")
    }

    func testOnlyAPlainSuccessInTheLayoutFadesByItself() {
        XCTAssertTrue(NoticePill.fadesByItself(placement: .inline, tone: .success, hasFixes: false, canDismiss: true))
        XCTAssertFalse(NoticePill.fadesByItself(placement: .stacked, tone: .success, hasFixes: false, canDismiss: true),
                       "in a stack the stack owns the time: one notice, one timer")
        XCTAssertFalse(NoticePill.fadesByItself(placement: .inline, tone: .error, hasFixes: false, canDismiss: true))
        XCTAssertFalse(NoticePill.fadesByItself(placement: .inline, tone: .success, hasFixes: true, canDismiss: true))
    }

    /// The stack is as tall as its notices up to `maxHeight`, then it scrolls, so a long run of answers never covers
    /// the whole pane.
    func testTheStackGrowsWithItsNoticesAndScrollsPastItsHeight() async throws {
        let clock = ManualNoticeClock()
        let model = stack(clock)
        model.push(StackedNotice(text: "Notice 1", lasting: .untilDismissed))
        let host = NSHostingView(rootView: NoticeStackView(model, maxWidth: 400, maxHeight: 200))
        let one = try await settledHeight(host)
        XCTAssertGreaterThan(one, 20)
        XCTAssertLessThan(one, 100)

        for index in 2...12 { model.push(StackedNotice(text: "Notice \(index)", lasting: .untilDismissed)) }
        let twelve = try await settledHeight(host)
        XCTAssertEqual(twelve, 200, accuracy: 0.5, "twelve notices are taller than the stack: it scrolls")

        model.dismissAll()
        let none = try await settledHeight(host)
        XCTAssertEqual(none, 0, "an empty stack takes no room and no clicks")
    }

    /// A settings page scrolls; a stack on its content would sit at the content's far end, off screen. Inside a
    /// `noticeStackViewport()` it floats over the visible part instead. The plain host is the control.
    func testAStackOnScrolledContentFloatsOverTheViewport() async throws {
        let model = stack(ManualNoticeClock())
        model.push(StackedNotice(text: "Saved the work rules", lasting: .untilDismissed))
        FrameProbe.enabled = true
        defer { FrameProbe.enabled = false; FrameProbe.reset() }

        func stackFrame(viewport: Bool) async throws -> CGRect {
            FrameProbe.reset()
            let page = ScrollView {
                Color.gray.frame(height: 3000).frame(maxWidth: .infinity).noticeStack(model)
            }
            let root = Group {
                if viewport { page.noticeStackViewport() } else { page }
            }.frame(width: 400, height: 500)
            let host = NSHostingView(rootView: root)
            host.frame = NSRect(x: 0, y: 0, width: 400, height: 500)
            for _ in 0..<10 {
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(20))
            }
            return try XCTUnwrap(FrameProbe.frames["notice-stack"], "the stack is drawn")
        }

        let floating = try await stackFrame(viewport: true)
        XCTAssertLessThanOrEqual(floating.maxY, 500, "inside the viewport: \(floating)")
        XCTAssertGreaterThan(floating.minY, 350, "at its bottom edge: \(floating)")
        let onContent = try await stackFrame(viewport: false)
        XCTAssertGreaterThan(onContent.minY, 2500, "without a viewport it sits at the content's end: \(onContent)")
    }

    /// A new notice never moves the ones already there, at either edge a stack is pinned to: pinned at the bottom
    /// the newest goes above the others, pinned at the top below them (Meetings, `meetings.notices.place`).
    func testANewNoticeMovesNoOlderOneAtEitherEdge() async throws {
        FrameProbe.enabled = true
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        for alignment in [Alignment.bottom, .top] {
            let edge = alignment.vertical == .top ? "top" : "bottom"
            FrameProbe.reset()
            let model = stack(ManualNoticeClock())
            let host = NSHostingView(rootView: Color.clear.frame(width: 500, height: 600).noticeStack(model, alignment: alignment))
            host.frame = NSRect(x: 0, y: 0, width: 500, height: 600)
            model.push(StackedNotice(text: "First", lasting: .untilDismissed))
            let first = try await settledFrame("notice-stack-item:First", in: host)
            model.push(StackedNotice(text: "Second", lasting: .untilDismissed))
            _ = try await settledFrame("notice-stack-item:Second", in: host)
            let after = try await settledFrame("notice-stack-item:First", in: host)
            XCTAssertEqual(after, first, "pinned at the \(edge): the second notice moved the first")
        }
    }

    /// Pinned at the top, the newest notice is the last of the list: past the stack's height the list keeps its end
    /// in view, so the notice that just arrived is never scrolled out of sight.
    func testAStackPinnedAtTheTopKeepsItsNewestNoticeInViewPastItsHeight() async throws {
        FrameProbe.enabled = true
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let model = stack(ManualNoticeClock())
        let host = NSHostingView(rootView: Color.clear.frame(width: 500, height: 700).noticeStack(model, alignment: .top))
        host.frame = NSRect(x: 0, y: 0, width: 500, height: 700)
        // A scroll view scrolls only inside a window on screen; this one is transparent, under the desktop.
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.close() }
        for index in 1...12 {
            model.push(StackedNotice(text: "Notice \(index)", lasting: .untilDismissed))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
        }
        let stackFrame = try await settledFrame("notice-stack", in: host)
        let newest = try await settledFrame("notice-stack-item:Notice 12", in: host)
        XCTAssertEqual(stackFrame.height, 360, accuracy: 0.5, "twelve notices overflow the stack")
        XCTAssertTrue(stackFrame.insetBy(dx: -1, dy: -1).contains(newest), "the newest notice is in view: \(newest) in \(stackFrame)")
    }

    /// The frame `name` reports once it holds still for three layout rounds.
    private func settledFrame(_ name: String, in host: NSView) async throws -> CGRect {
        var last: CGRect?
        var still = 0
        for _ in 0..<60 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
            let frame = FrameProbe.frames[name]
            if let frame, frame == last {
                still += 1
                if still >= 3 { return frame }
            } else {
                still = 0
            }
            last = frame
        }
        return try XCTUnwrap(last, "\(name) is drawn")
    }

    private func settledHeight(_ host: NSHostingView<NoticeStackView>) async throws -> CGFloat {
        var last: CGFloat = -1
        for _ in 0..<20 {
            host.frame.size = NSSize(width: 400, height: max(1, host.fittingSize.height))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(20))
            let height = host.fittingSize.height
            if height == last { return height }
            last = height
        }
        return last
    }
}
