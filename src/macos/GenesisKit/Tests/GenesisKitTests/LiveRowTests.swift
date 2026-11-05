import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// A dense list's row is live (a real `Button`) only under the pointer. A pointer that was already on the row when the
/// list opened, scrolled or refreshed sends no hover event, so the row stays at rest: its click must still act.
final class LiveRowTests: XCTestCase {
    @MainActor
    func testARestingRowTakesAClickWithNoHoverBeforeIt() {
        XCTAssertEqual(clicks(live: true), 1, "the harness's click reaches a live row's button (the positive control)")
        XCTAssertEqual(clicks(live: false), 1, "a click on a row that never saw a hover event did nothing")
    }

    /// One synthetic click on a row hosted in a window that is never ordered front; `live` keeps the row live.
    @MainActor
    private func clicks(live: Bool) -> Int {
        var clicks = 0
        let row = Text("Decision 3: Bump next anyway?")
            .frame(width: 240, height: 40)
            .rowButton { clicks += 1 }
            .liveRow(selected: live)
        let host = NSHostingView(rootView: row)
        host.frame = NSRect(x: 0, y: 0, width: 240, height: 40)
        // Shown, as SwiftUI needs for a click, but invisible and under every window (GrowingTextEditorTests does the
        // same); it is never made key, so it takes no focus from the user.
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: -1000)
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))

        func event(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: CGPoint(x: 120, y: 20), modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }

        window.sendEvent(event(.leftMouseDown))
        window.sendEvent(event(.leftMouseUp))
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        return clicks
    }
}
