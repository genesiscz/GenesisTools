// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusSessionWindow.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// Spec 22 (S6) §10.7 — the window one session card opens (Pattern 7).
///
/// One window per session id, cascaded, so comparing two pomodoros means opening two cards and
/// putting them side by side rather than losing the first one.
@MainActor
final class FocusSessionWindowController: NSWindowController, NSWindowDelegate {
    let sessionId: Int64
    private let model: FocusSessionDetailModel
    /// Told when the window closes, so the owner can drop its reference instead of leaking one
    /// controller per card ever clicked.
    var onClose: ((Int64) -> Void)?

    /// Where the next window lands. Static because the cascade is per app, not per window.
    private static var cascadePoint = NSPoint(x: 160, y: 160)

    init(model: FocusSessionDetailModel) {
        self.model = model
        sessionId = model.sessionId
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 820, height: 640),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.minSize = NSSize(width: 720, height: 520)
        window.title = "Focus session"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(red: 0.06, green: 0.05, blue: 0.07, alpha: 1)
        window.isReleasedWhenClosed = false
        // The title bar strip zooms on a double-click and drags the window (UI/WindowTitlebar.swift).
        window.contentView = NSHostingView(rootView: FocusSessionDetailView(model: model).titlebarZone())
        super.init(window: window)
        window.delegate = self
        window.setAccessibilityIdentifier("focus-session-window-\(sessionId)")
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    func present() {
        guard let window else { return }
        if !window.isVisible {
            Self.cascadePoint = window.cascadeTopLeft(from: Self.cascadePoint)
        }
        model.reload()
        // The title is only knowable after the first load, so it is set here rather than in init.
        window.title = model.title
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        onClose?(sessionId)
    }
}
