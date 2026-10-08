// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowLayoutTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// The Dictation page header in a narrow window. `FLOW_SNAPSHOT_DIR=<dir>`
/// also writes a PNG per width.
@MainActor
final class FlowLayoutTests: XCTestCase {

    /// What the Dictation pane gets in a 720 pt main window: 720 minus the
    /// session sidebar (220), the Dictation rail (188) and its divider.
    private let narrowPane: CGFloat = 311
    private let widePane: CGFloat = 700

    /// Measured 2026-09-25 in the installed app: at 720 pt the title wrapped
    /// letter by letter beside the search field. Now the search drops below a
    /// one-line title instead.
    func testTitleStaysOneLineInANarrowPane() throws {
        let wide = try height(of: widePane, name: "flow-header-wide")
        let narrow = try height(of: narrowPane, name: "flow-header-narrow")

        XCTAssertLessThan(wide, 70, "title and search share one row when there is room")
        XCTAssertGreaterThan(narrow, wide, "the search moves below the title when narrow")
        // One extra row (the search field), not a title broken over 3 lines.
        XCTAssertLessThan(narrow - wide, 45)
    }

    private func height(of width: CGFloat, name: String) throws -> CGFloat {
        // The pane's dark background, or the white title vanishes in the PNG.
        let controller = NSHostingController(rootView: FlowHistoryHeader(search: .constant("")).background(Color.settingsBackground))
        let size = controller.sizeThatFits(in: NSSize(width: width, height: 1000))

        if let dir = ProcessInfo.processInfo.environment["FLOW_SNAPSHOT_DIR"] {
            let host = controller.view
            host.frame = NSRect(x: 0, y: 0, width: width, height: max(size.height, 1))
            host.layoutSubtreeIfNeeded()
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                if let png = rep.representation(using: .png, properties: [:]) {
                    try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
                }
            }
        }
        return size.height
    }
}
