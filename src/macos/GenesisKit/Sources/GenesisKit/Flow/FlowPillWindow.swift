// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowPillWindow.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// The small floating panel that hosts the dictation pill.
///
/// Unlike the companion's full-screen overlay this covers only its own footprint,
/// so it needs no click-through shaping — it simply never takes mouse events.
/// The pill is informational; every control lives in the Flow window.
///
/// `.nonactivatingPanel` is what makes the whole feature work: showing the pill
/// must not deactivate the app the user is dictating into, or the paste target
/// changes out from under us between key-down and key-up.
final class FlowPillPanel: ConstraintSafePanel {
    public override var canBecomeKey: Bool { false }
    public override var canBecomeMain: Bool { false }
}

@MainActor
public final class FlowPillWindowController {

    private var panel: FlowPillPanel?
    private let makeContent: () -> AnyView

    /// Above normal windows but below the companion overlay, so the two never
    /// fight when both happen to be up.
    private static let level: NSWindow.Level = .floating

    public init(content: @escaping () -> AnyView) {
        makeContent = content
    }

    public func show() {
        guard let screen = screenContainingMouse() else { return }
        let panel = ensurePanel()
        position(panel, on: screen)
        panel.orderFrontRegardless()
    }

    public func hide() {
        panel?.orderOut(nil)
    }

    /// Build and lay out once while invisible so the first real show does not
    /// pay the initial SwiftUI render on the critical path — the same trick the
    /// companion overlay uses, and it matters more here because the pill is
    /// supposed to appear the instant the key goes down.
    public func prewarm() {
        guard panel == nil, let screen = screenContainingMouse() else { return }
        let panel = ensurePanel()
        panel.alphaValue = 0
        position(panel, on: screen)
        panel.orderFrontRegardless()
        panel.contentView?.layoutSubtreeIfNeeded()
        panel.displayIfNeeded()
        panel.orderOut(nil)
        panel.alphaValue = 1
    }

    // MARK: - Internals

    private func screenContainingMouse() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }

    private static let size = CGSize(width: 260, height: 96)

    /// Bottom-centre of the active screen, clear of the Dock.
    private func position(_ panel: FlowPillPanel, on screen: NSScreen) {
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.midX - Self.size.width / 2,
            y: visible.minY + 72
        )
        panel.setFrame(CGRect(origin: origin, size: Self.size), display: false)
    }

    private func ensurePanel() -> FlowPillPanel {
        if let panel { return panel }

        let panel = FlowPillPanel(
            contentRect: CGRect(origin: .zero, size: Self.size),
            styleMask: [.borderless, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        // NSPanel defaults hidesOnDeactivate to true, which would order the
        // pill out the moment focus moves to the app being dictated into —
        // i.e. always. Same trap the companion overlay documents.
        panel.hidesOnDeactivate = false
        panel.level = Self.level
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = false
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isReleasedWhenClosed = false

        let hosting = NSHostingController(rootView: makeContent())
        hosting.sizingOptions = []   // no constraint-loop size negotiation
        panel.contentViewController = hosting
        panel.setAccessibilityIdentifier("flow-pill-window")

        self.panel = panel
        return panel
    }
}
