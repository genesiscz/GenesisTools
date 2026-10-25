import AppKit
import GenesisKitTestHooks
import XCTest

/// A test run never takes the user's keyboard focus: GenesisKitTestHooks turns a request for a key window into
/// "order front" and refuses app activation from the moment the bundle loads.
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
        NSApp.activate(ignoringOtherApps: true)
        XCTAssertFalse(window.isKeyWindow, "a test window must not take the keyboard")
        XCTAssertFalse(NSApp.isActive, "a test run must not activate")
        XCTAssertEqual(GenesisKitTestHooksRefusedFocus() - before, 2)
    }
}
