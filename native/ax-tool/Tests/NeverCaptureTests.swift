import CoreGraphics
import SnapshotSupport
import XCTest

final class NeverCaptureTests: XCTestCase {
    private let main = DisplayFrame(id: 1, bounds: CGRect(x: 0, y: 0, width: 1512, height: 982))
    private let side = DisplayFrame(id: 4, bounds: CGRect(x: 1512, y: -200, width: 2560, height: 1440))

    private func window(_ pid: Int32, state: Int = 0, _ bounds: CGRect) -> SharingWindowFacts {
        SharingWindowFacts(ownerPID: pid, sharingState: state, bounds: bounds)
    }

    func testAnInvisibleNeverCaptureWindowOnEachDisplayNamesItsOwnerOnBoth() {
        let windows = [
            // A dimmer's 2 x 2 point windows, one per display.
            window(70, CGRect(x: 0, y: 0, width: 2, height: 2)),
            window(70, CGRect(x: 1512, y: -200, width: 2, height: 2)),
            // Ordinary windows (read only) never count.
            window(80, state: 1, CGRect(x: 100, y: 100, width: 800, height: 600)),
            window(81, state: 2, CGRect(x: 1600, y: 0, width: 800, height: 600)),
        ]
        XCTAssertEqual(NeverCaptureRule.owners(windows, displays: [main, side]),
                       [NeverCaptureOwner(pid: 70, windows: 2, displays: [1, 4])])
    }

    func testOwnWindowsWindowsOffEveryDisplayAndAWindowWithNoAreaAreHandled() {
        let windows = [
            window(90, CGRect(x: 10, y: 10, width: 300, height: 200)),
            // Parked outside every display.
            window(91, CGRect(x: -9000, y: -9000, width: 10, height: 10)),
            // No area, but its origin is on the side display.
            window(92, CGRect(x: 2000, y: 0, width: 0, height: 0)),
        ]
        let owners = NeverCaptureRule.owners(windows, displays: [main, side], own: 90)
        XCTAssertEqual(owners, [NeverCaptureOwner(pid: 92, windows: 1, displays: [4])])
        XCTAssertEqual(NeverCaptureRule.blocking(owners, display: 1), [])
        XCTAssertEqual(NeverCaptureRule.blocking(owners, display: 4), owners)
        XCTAssertEqual(NeverCaptureRule.blocking(owners, display: nil), owners)
    }

    private func facts(screen: Bool = true, movie: Bool = false, audio: Bool = false, available: Bool = true,
                       blocked: Bool = true) -> FrameSourceFacts {
        FrameSourceFacts(screenMode: screen, movie: movie, audio: audio, screenshotsAvailable: available, blocked: blocked)
    }

    func testAutoTakesScreenshotsOnlyOnABlockedDisplayThatCanDoWithoutTheStream() {
        XCTAssertEqual(chooseFrameSource(.auto, facts()), .use(.screenshot, note: nil))
        XCTAssertEqual(chooseFrameSource(.auto, facts(blocked: false)), .use(.stream, note: nil))
        XCTAssertEqual(chooseFrameSource(.stream, facts()), .use(.stream, note: nil))
        for kept in [facts(screen: false), facts(movie: true), facts(audio: true), facts(available: false)] {
            guard case .use(.stream, let note) = chooseFrameSource(.auto, kept) else {
                return XCTFail("auto must keep the stream for \(kept)")
            }
            XCTAssertNotNil(note)
        }
    }

    func testAnExplicitScreenshotSourceIsRefusedWhereItCannotWork() {
        XCTAssertEqual(chooseFrameSource(.screenshot, facts(blocked: false)), .use(.screenshot, note: nil))
        XCTAssertEqual(chooseFrameSource(.screenshot, facts(movie: true)),
                       .refuse("--frame-source screenshot: a movie (--video-out) needs the stream"))
        XCTAssertEqual(chooseFrameSource(.screenshot, facts(screen: false)),
                       .refuse("--frame-source screenshot: frames by screenshot work for a display recording (--mode screen) only"))
    }
}
