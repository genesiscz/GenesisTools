import CoreGraphics
import SnapshotSupport
import XCTest

final class DimmingOverlayTests: XCTestCase {
    private let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
    private let side = CGRect(x: 1512, y: -200, width: 2560, height: 1440)

    private func window(_ id: CGWindowID, owner: String? = "org.example.app", layer: Int = 0, frame: CGRect,
                        agent: Bool = false) -> OverlayWindowFacts {
        OverlayWindowFacts(windowID: id, ownerBundleID: owner, layer: layer, frame: frame, ownerIsAgent: agent)
    }

    func testAKnownDimmerIsAnOverlayOnEveryDisplayButItsMenuBarItemStays() {
        let windows = [
            window(11, owner: "com.pointum.hazeover", frame: main),
            window(12, owner: "com.pointum.hazeover-setapp", layer: 3, frame: CGRect(x: 1512, y: -200, width: 2560, height: 1415)),
            window(13, owner: "com.pointum.hazeover", layer: 25, frame: CGRect(x: 1200, y: 0, width: 24, height: 24)),
        ]
        XCTAssertEqual(DimmingOverlayRule.overlayIDs(windows, displays: [main, side]), [11, 12])
    }

    func testAnUnknownAgentAppsDisplaySizedWindowInTheNormalLayerIsAnOverlay() {
        let windows = [
            window(21, owner: "org.example.dimmer", frame: side.insetBy(dx: 0.5, dy: 0.5), agent: true),
            // A regular app in full screen covers the display too.
            window(22, owner: "org.example.editor", frame: main, agent: false),
            // An agent app's panel that does not cover a display.
            window(23, owner: "org.example.dimmer", frame: CGRect(x: 10, y: 10, width: 400, height: 300), agent: true),
            // A cursor highlighter: display-sized, but above the normal layer.
            window(24, owner: "org.example.cursor", layer: 101, frame: main, agent: true),
            // The desktop picture sits far below the normal layer.
            window(25, owner: "com.apple.dock", layer: -2_147_483_623, frame: main, agent: true),
        ]
        XCTAssertEqual(DimmingOverlayRule.overlayIDs(windows, displays: [main, side]), [21])
    }

    func testNoWindowsOrNoDisplaysFindNothing() {
        XCTAssertEqual(DimmingOverlayRule.overlayIDs([], displays: [main]), [])
        XCTAssertEqual(DimmingOverlayRule.overlayIDs([window(31, frame: main, agent: true)], displays: []), [])
    }
}
