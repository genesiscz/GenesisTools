import CoreGraphics
import XCTest

@testable import GenesisKit

/// A `--snapshot` window turns opaque for its window-server capture only while a desktop picture hides it. The window
/// list below is the shape measured on 2026-10-11: the Dock's picture one layer under the desktop level, Finder's
/// desktop icons (transparent between the icons) above it.
@MainActor
final class WindowSnapshotTests: XCTestCase {
    private let desktopLevel = -2_147_483_623
    private let snapshotWindow = CGRect(x: 152, y: 39, width: 960, height: 760)

    private func window(_ layer: Int, _ bounds: CGRect, alpha: Double = 1) -> WindowSnapshot.ListedWindow {
        WindowSnapshot.ListedWindow(number: 1, layer: layer, alpha: alpha, bounds: bounds)
    }

    func testTheDesktopPictureOverTheWholeWindowHidesIt() {
        let above = [window(-2_147_483_603, CGRect(x: 0, y: 0, width: 2056, height: 1329)),
                     window(-2_147_483_624, CGRect(x: 0, y: 0, width: 2056, height: 1329))]
        XCTAssertTrue(WindowSnapshot.coveredByDesktopPicture(snapshotWindow, above: above, desktopLevel: desktopLevel))
    }

    func testDesktopIconsAloneNeverHideIt() {
        let above = [window(-2_147_483_603, CGRect(x: 0, y: 0, width: 2056, height: 1329))]
        XCTAssertFalse(WindowSnapshot.coveredByDesktopPicture(snapshotWindow, above: above, desktopLevel: desktopLevel))
    }

    func testAPictureOnAnotherDisplayOrOnlyPartlyOverItNeverHidesIt() {
        let otherDisplay = window(-2_147_483_624, CGRect(x: -1488, y: -1440, width: 2560, height: 1440))
        let partly = window(-2_147_483_624, CGRect(x: 600, y: 0, width: 1456, height: 1329))
        XCTAssertFalse(WindowSnapshot.coveredByDesktopPicture(
            snapshotWindow, above: [otherDisplay, partly], desktopLevel: desktopLevel))
    }

    func testAWindowListRowReadsItsLayerAlphaAndBounds() {
        let row: [String: Any] = [
            kCGWindowNumber as String: 402_613, kCGWindowLayer as String: -2_147_483_643,
            kCGWindowAlpha as String: 0.0,
            kCGWindowBounds as String: snapshotWindow.dictionaryRepresentation as NSDictionary,
        ]
        let expected = WindowSnapshot.ListedWindow(number: 402_613, layer: -2_147_483_643, alpha: 0, bounds: snapshotWindow)
        XCTAssertEqual(WindowSnapshot.ListedWindow(row), expected)
        XCTAssertNil(WindowSnapshot.ListedWindow([kCGWindowNumber as String: 1]))
    }

    func testATranslucentPictureNeverHidesIt() {
        let faded = window(-2_147_483_624, CGRect(x: 0, y: 0, width: 2056, height: 1329), alpha: 0.5)
        XCTAssertFalse(WindowSnapshot.coveredByDesktopPicture(snapshotWindow, above: [faded], desktopLevel: desktopLevel))
    }
}
