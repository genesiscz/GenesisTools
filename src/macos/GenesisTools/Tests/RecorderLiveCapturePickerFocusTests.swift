import AppKit
import GenesisKit
import SwiftUI
import XCTest
@testable import GenesisToolsRecorder

/// 2026-11-09: the capture picker closed several times while agents' apps took the focus. It stays open until its own
/// close control, Escape, or a choice, unless Settings → Recorder says to close it when it loses the keyboard.
@MainActor
final class RecorderLiveCapturePickerFocusTests: XCTestCase {
    private func presented(_ panel: RecordingPickerPanel, onDismiss: @escaping () -> Void) {
        _ = NSApplication.shared
        panel.window.alphaValue = 0
        let screen = NSScreen.screens.first?.frame ?? CGRect(x: 0, y: 0, width: 800, height: 800)
        panel.present(Text("Record").frame(width: 300, height: 200), near: CGPoint(x: screen.midX, y: screen.midY),
                      focus: false, onDismiss: onDismiss)
    }

    private func loseTheKeyboard(_ panel: RecordingPickerPanel) {
        panel.windowDidResignKey(Notification(name: NSWindow.didResignKeyNotification, object: panel.window))
    }

    func testAPickerSetToStayOpenKeepsItsPlaceWhenAnotherAppTakesTheKeyboard() {
        let panel = RecordingPickerPanel()
        defer { panel.dismiss() }
        var cancelled = 0
        panel.closesOnFocusLoss = false
        presented(panel) { cancelled += 1 }
        loseTheKeyboard(panel)
        XCTAssertTrue(panel.window.isVisible, "the picker stays on screen")
        XCTAssertEqual(cancelled, 0, "losing the keyboard is no cancel")
        XCTAssertFalse(panel.window.hidesOnDeactivate, "another app becoming active does not hide it")
    }

    func testAPickerSetToCloseStillCancelsWhenItLosesTheKeyboard() {
        let panel = RecordingPickerPanel()
        defer { panel.dismiss() }
        var cancelled = 0
        presented(panel) { cancelled += 1 }
        loseTheKeyboard(panel)
        XCTAssertFalse(panel.window.isVisible)
        XCTAssertEqual(cancelled, 1)
    }

    func testTheCapturePickerStaysOpenByDefaultAndTheSettingCanCloseIt() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "recorder-live-picker-\(UUID().uuidString)"))
        XCTAssertEqual(CapturePickerFocusLoss.load(defaults), .stayOpen)
        XCTAssertFalse(CapturePickerFocusLoss.load(defaults).closesPicker)
        defaults.set(CapturePickerFocusLoss.close.rawValue, forKey: CapturePickerFocusLoss.key)
        XCTAssertTrue(CapturePickerFocusLoss.load(defaults).closesPicker)
    }
}
