import XCTest
@testable import GenesisKit

final class GenResizeTests: XCTestCase {
    /// The perf line names the steps, the gap percentiles and the late steps, so a laggy drag reads from the log alone.
    func testTheDragSummaryNamesStepsGapsAndLateSteps() {
        let gaps: [Double] = [8, 8, 9, 10, 12, 40, 90]
        let line = GenResizeDragTimer.summary("panel.hub.sidebar", from: 327, to: 412.6, gaps: gaps, seconds: 1.04)
        XCTAssertEqual(line, "resize panel.hub.sidebar 327->412 pt: 8 steps in 1.0 s, step gap p50 10 p95 90 max 90 ms, 2 over 33 ms")
    }

    /// A drag begins once, every step moves the live value, the collapse flag follows the host's verdict, and the
    /// end returns where it began and ended and leaves the state at rest.
    @MainActor
    func testDragStateBeginsOnceMovesAndEndsAtRest() {
        let drag = GenResizeDrag(rest: 300)
        XCTAssertEqual(drag.rest, 300)
        XCTAssertFalse(drag.active)
        XCTAssertNil(drag.end("none"), "no drag ran")
        drag.begin(at: 327)
        drag.begin(at: 999)
        XCTAssertEqual(drag.start, 327, "a second begin during the same drag changes nothing")
        XCTAssertEqual(drag.live, 327)
        drag.move(to: 140, collapsing: true)
        XCTAssertTrue(drag.willCollapse)
        drag.move(to: 412)
        XCTAssertFalse(drag.willCollapse)
        let ended = drag.end("panel.test")
        XCTAssertEqual(ended?.start, 327)
        XCTAssertEqual(ended?.final, 412)
        XCTAssertFalse(drag.active)
        XCTAssertNil(drag.live)
        XCTAssertFalse(drag.willCollapse)
        XCTAssertEqual(drag.rest, 300, "the rest is the host's to set from the result: a folding panel reopens at its pre-drag length")
    }

    func testOneStepHasNoGaps() {
        let line = GenResizeDragTimer.summary("prThreads.list", from: 260, to: 260, gaps: [], seconds: 0)
        XCTAssertEqual(line, "resize prThreads.list 260->260 pt: 1 steps in 0.0 s, step gap p50 0 p95 0 max 0 ms, 0 over 33 ms")
    }

    /// The AppKit hit area turns mouse events into translations along its axis and one end per press.
    @MainActor
    func testTheDragSurfaceReportsTranslationsAlongItsAxisAndEnds() {
        var changes: [CGFloat] = []
        var ended = 0
        let view = GenResizeDragSurface.SurfaceView()
        view.axis = .horizontal
        view.onChanged = { changes.append($0) }
        view.onEnded = { ended += 1 }
        func event(_ type: NSEvent.EventType, _ x: CGFloat, _ y: CGFloat) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: CGPoint(x: x, y: y), modifierFlags: [], timestamp: 0,
                               windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
        }
        view.mouseUp(with: event(.leftMouseUp, 10, 10))
        XCTAssertEqual(ended, 0, "a release with no press is nothing")
        view.mouseDown(with: event(.leftMouseDown, 100, 50))
        view.mouseDragged(with: event(.leftMouseDragged, 130, 50))
        view.mouseDragged(with: event(.leftMouseDragged, 90, 70))
        view.mouseUp(with: event(.leftMouseUp, 90, 70))
        XCTAssertEqual(changes, [30, -10])
        XCTAssertEqual(ended, 1)
        view.axis = .vertical
        view.mouseDown(with: event(.leftMouseDown, 0, 100))
        view.mouseDragged(with: event(.leftMouseDragged, 0, 60))
        XCTAssertEqual(changes.last, 40, "down in window coordinates is a positive translation")
        XCTAssertTrue(view.acceptsFirstMouse(for: nil), "a press in a window that is not key starts the drag")
        XCTAssertFalse(view.mouseDownCanMoveWindow)
    }
}
