import AppKit
import GenesisKitTestHooks
import XCTest

/// A test run never takes the user's keyboard focus (GenesisKitTestHooks, loaded with this bundle).
@MainActor
final class TestFocusTests: XCTestCase {
    func testAWindowAskedToBecomeKeyIsOnlyOrderedFront() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: -2000, y: -2000, width: 40, height: 40),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let before = GenesisKitTestHooksRefusedFocus()
        window.makeKeyAndOrderFront(nil)
        XCTAssertFalse(window.isKeyWindow, "a test window must not take the keyboard")
        XCTAssertEqual(GenesisKitTestHooksRefusedFocus() - before, 1)
    }
}
