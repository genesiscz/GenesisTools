// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusStudioWindow.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// Spec 22 (S6) §10.4 — the Focus Studio window (Pattern 7: NSWindowController + NSHostingView,
/// never a SwiftUI `Settings`/`Window` scene).
///
/// One window, reused. Re-showing it reloads the range rather than opening a second copy, so a
/// menu item pressed twice cannot leave two studios disagreeing about the same day.
@MainActor
public final class FocusStudioWindowController: NSWindowController, NSWindowDelegate {
    private let model: FocusStudioModel

    public init(model: FocusStudioModel) {
        self.model = model
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.minSize = NSSize(width: 880, height: 560)
        window.title = "Focus Studio"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(red: 0.06, green: 0.05, blue: 0.07, alpha: 1)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("focus-studio-window")
        // The title bar strip zooms on a double-click and drags the window (UI/WindowTitlebar.swift).
        window.contentView = NSHostingView(rootView: FocusStudioView(model: model).titlebarZone())
        super.init(window: window)
        window.delegate = self
        window.setAccessibilityIdentifier("focus-studio-window")
    }

    public required init?(coder: NSCoder) { fatalError("not supported") }

    public func present() {
        guard let window else { return }
        if !window.isVisible {
            window.center()
        }
        model.reload()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
