import CoreImage
import CoreMedia
import SnapshotSupport
import XCTest

/// The isolated recorder's readiness, visibility, stacking and composition rules, driven by
/// synthetic frames. A whole-recording stall from one window shows up here as `readyToRender`
/// or `paintOrder` going wrong, without ScreenCaptureKit.
final class IsolatedCompositionTests: XCTestCase {
    private let left = CGRect(x: 0, y: 0, width: 10, height: 10)
    private let right = CGRect(x: 5, y: 0, width: 10, height: 10)

    private func layers() -> IsolatedLayers<String> {
        IsolatedLayers([IsolatedLayer(id: 1, pid: 100, bounds: left), IsolatedLayer(id: 2, pid: 200, bounds: right)])
    }

    private func rows(_ ids: [CGWindowID]) -> [IsolatedWindowRow] {
        ids.map { id in
            id == 1 ? IsolatedWindowRow(id: 1, pid: 100, bounds: left) : IsolatedWindowRow(id: 2, pid: 200, bounds: right)
        }
    }

    func testStartupWaitsForEveryVisibleWindowOnly() {
        var state = layers()
        state.receive("a", for: 1)
        XCTAssertFalse(state.readyToRender, "the first frame must not open without a window whose stream started later")
        state.receive("b", for: 2)
        XCTAssertTrue(state.readyToRender)
    }

    func testWindowThatLeavesAndReturnsDoesNotStallTheOthers() {
        var state = layers()
        state.receive("a", for: 1)
        state.receive("b", for: 2)
        state.markRendered()

        XCTAssertTrue(state.refresh(rows([1])), "a window leaving the screen changes the geometry")
        XCTAssertNil(state.layer(2)?.frame)
        state.refresh(rows([1, 2]))
        XCTAssertEqual(state.layer(2)?.visible, true)
        XCTAssertNil(state.layer(2)?.frame, "a returning window has no frame until its stream delivers one")

        state.receive("a2", for: 1)
        XCTAssertTrue(state.readyToRender, "the window still updating keeps recording")
        XCTAssertEqual(state.paintOrder.map(\.frame), ["a2"])

        state.receive("b2", for: 2)
        XCTAssertEqual(state.paintOrder.map(\.id), [2, 1], "back to front: the list puts window 1 in front")
    }

    func testEndedStreamStaysOutWhenItsWindowReturns() {
        var state = layers()
        state.receive("a", for: 1)
        state.receive("b", for: 2)
        state.markRendered()

        XCTAssertFalse(state.streamEnded(id: 2, windowPresent: false), "a window that left the screen is not fatal")
        state.refresh(rows([1, 2]))
        state.refresh(rows([1, 2]))
        XCTAssertEqual(state.layer(2)?.visible, false)
        state.receive("late", for: 2)
        XCTAssertNil(state.layer(2)?.frame, "an ended stream never paints again")
        state.receive("a2", for: 1)
        XCTAssertTrue(state.readyToRender)
        XCTAssertEqual(state.paintOrder.map(\.frame), ["a2"])
        XCTAssertEqual(state.warnings.count, 2, "one warning for the end and one for the return, not one per refresh")

        var fatal = layers()
        XCTAssertTrue(fatal.streamEnded(id: 1, windowPresent: true), "a stream that stops while its window is on screen is an error")
    }

    func testStackingFollowsTheWindowList() {
        var state = layers()
        state.receive("a", for: 1)
        state.receive("b", for: 2)
        XCTAssertFalse(state.refresh(rows([1, 2])), "the initial order and bounds are unchanged")
        XCTAssertEqual(state.paintOrder.map(\.id), [2, 1])
        XCTAssertTrue(state.refresh(rows([2, 1])), "a stacking change forces a frame")
        XCTAssertEqual(state.paintOrder.map(\.id), [1, 2])
    }

    func testEqualBoundsWindowsThatSwapOrderAreAChange() {
        var state = IsolatedLayers<String>([IsolatedLayer(id: 1, pid: 100, bounds: left),
                                            IsolatedLayer(id: 2, pid: 200, bounds: left)])
        state.receive("a", for: 1)
        state.receive("b", for: 2)
        let maximized = [IsolatedWindowRow(id: 1, pid: 100, bounds: left), IsolatedWindowRow(id: 2, pid: 200, bounds: left)]
        XCTAssertFalse(state.refresh(maximized))
        let before = state.geometry
        XCTAssertTrue(state.refresh(maximized.reversed()), "same rectangles, new front window: the frame must be redrawn")
        XCTAssertNotEqual(state.geometry, before, "geometry history records the new order")
        XCTAssertEqual(state.paintOrder.map(\.id), [1, 2])
    }

    func testContentRectIsDecodedFromItsDictionaryRepresentation() {
        let rect = CGRect(x: 0, y: 12, width: 640, height: 360)
        XCTAssertEqual(frameInfoRect(rect.dictionaryRepresentation), rect, "SCK stores a dictionary, not a CGRect")
        XCTAssertNil(frameInfoRect(nil))
        XCTAssertNil(frameInfoRect(NSNumber(value: 3)))
    }

    func testMovieEndsAtTheStopMomentOnTheFrameClock() {
        // Frames and the stop are host-clock times. Startup took 2.5 s before the run loop began;
        // a duration counted from then would end the movie 2.5 s before recording stopped.
        let stop = CMTime(seconds: 112.5, preferredTimescale: 600)
        let lastFrame = CMTime(seconds: 112.4, preferredTimescale: 600)
        XCTAssertEqual(movieSessionEnd(stop: stop, lastFrame: lastFrame), stop)
        XCTAssertEqual(movieSessionEnd(stop: stop, lastFrame: nil), stop)
        let late = CMTime(seconds: 112.6, preferredTimescale: 600)
        XCTAssertEqual(movieSessionEnd(stop: stop, lastFrame: late), late, "the end never cuts off an appended frame")
    }

    func testComposedFrameKeepsAlphaAndPaintsTheFrontWindowLast() {
        let geometry = CaptureCanvasGeometry(canvas: left.union(right), output: CGSize(width: 25, height: 10))
        // 2x surfaces into 10x10 point windows; window 2 is in front, so it is painted last.
        let red = CIImage(color: CIColor(red: 1, green: 0, blue: 0)).cropped(to: CGRect(x: 0, y: 0, width: 20, height: 20))
        let blue = CIImage(color: CIColor(red: 0, green: 0, blue: 1)).cropped(to: CGRect(x: 0, y: 0, width: 20, height: 20))
        let image = composeIsolatedFrame([IsolatedPaint(image: red, contentRect: nil, bounds: left),
                                          IsolatedPaint(image: blue, contentRect: nil, bounds: right)],
                                         geometry: geometry, transparent: true)
        var pixels = [UInt8](repeating: 255, count: 25 * 10 * 4)
        CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
            .render(image, toBitmap: &pixels, rowBytes: 25 * 4, bounds: CGRect(x: 0, y: 0, width: 25, height: 10),
                    format: .RGBA8, colorSpace: nil)
        func pixel(_ x: Int, _ y: Int) -> [UInt8] { Array(pixels[(y * 25 + x) * 4 ..< (y * 25 + x) * 4 + 4]) }

        for y in [1, 5, 8] {
            XCTAssertEqual(pixel(2, y), [0, 0, 0, 0], "left padding stays transparent")
            XCTAssertEqual(pixel(22, y), [0, 0, 0, 0], "right padding stays transparent")
            XCTAssertEqual(pixel(7, y), [255, 0, 0, 255], "only the back window covers this column")
            XCTAssertEqual(pixel(12, y), [0, 0, 255, 255], "the front window covers the overlap")
            XCTAssertEqual(pixel(17, y), [0, 0, 255, 255])
        }
    }

    func testThrottledUpdateGetsOneTrailingFrame() {
        var throttle = RenderThrottle()
        XCTAssertEqual(throttle.request(at: 1.7, interval: 0.5, force: false), .render)
        XCTAssertEqual(throttle.rendered(at: 1.7), 0, "movie time starts at the first composite frame, not at session start")
        XCTAssertEqual(throttle.firstRender, 1.7)

        guard case .schedule(let delay) = throttle.request(at: 1.8, interval: 0.5, force: false) else {
            return XCTFail("a throttled update must schedule a trailing frame, not vanish")
        }
        XCTAssertEqual(delay, 0.4, accuracy: 1e-9)
        XCTAssertEqual(throttle.request(at: 1.9, interval: 0.5, force: false), .coalesced, "one trailing frame at a time")
        XCTAssertTrue(throttle.pending, "finishing the movie flushes this content")
        XCTAssertTrue(throttle.trailingFired())
        XCTAssertEqual(throttle.request(at: 2.2, interval: 0.5, force: false), .render)
        XCTAssertEqual(throttle.rendered(at: 2.2), 0.5, accuracy: 1e-9)
        XCTAssertFalse(throttle.pending)
        XCTAssertFalse(throttle.trailingFired(), "a timer that fires after its content was rendered draws nothing")
    }
}
