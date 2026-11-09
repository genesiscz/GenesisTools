import AppKit
import GenesisKit
import GenesisKitTestHooks
import SwiftUI
import XCTest

/// `window.show { which: "picker", focus: false }` and `--recorder --picker --no-focus`: the capture picker's panel
/// comes to the front without taking the keyboard from the app the person types in; its first click takes it.
/// GenesisKitTestHooks refuses every request for the keyboard in a test run and counts it, so the count shows whether
/// the panel asked.
@MainActor
final class RecorderHuntPickerFocusHonouredTests: XCTestCase {
    func testAPickerPresentedWithoutFocusIsInFrontAndNeverAsksForTheKeyboard() {
        _ = NSApplication.shared
        let panel = RecordingPickerPanel()
        panel.window.alphaValue = 0
        defer { panel.dismiss() }
        let screen = NSScreen.screens.first?.frame ?? CGRect(x: 0, y: 0, width: 800, height: 800)
        let anchor = CGPoint(x: screen.midX, y: screen.midY)
        let before = GenesisKitTestHooksRefusedFocus()
        panel.present(Text("Record").frame(width: 300, height: 200), near: anchor, focus: false) {}
        XCTAssertTrue(panel.window.isVisible, "the picker is on screen")
        XCTAssertEqual(GenesisKitTestHooksRefusedFocus() - before, 0, "the picker never asks for the keyboard")
        panel.dismiss()
        panel.present(Text("Record").frame(width: 300, height: 200), near: anchor) {}
        XCTAssertTrue(panel.window.isVisible, "the picker is on screen again")
        XCTAssertEqual(GenesisKitTestHooksRefusedFocus() - before, 1, "by default it asks for the keyboard (the hooks refuse it)")
    }
}
