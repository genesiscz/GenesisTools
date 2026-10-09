// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Pomodoro/FocusHUDWindow.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import SwiftUI

/// Spec 22 (S6) §10.2 — the panel that hosts the HUD.
///
/// Mirrors `FlowPillWindowController`'s non-activating panel, with two deliberate differences:
/// this one takes mouse events (it has controls and a hover reveal) and it is draggable, with
/// its position remembered per display. It must never become key: a timer that steals focus
/// mid-keystroke is worse than no timer.
final class FocusHUDPanel: ConstraintSafePanel {
    /// The HUD refuses key status so it can never swallow a keystroke meant for the editor you
    /// are working in. That also makes a `TextField` inside it impossible to type into, so the
    /// refusal is lifted for exactly as long as a field is open (see `beginTextEditing`).
    public var allowsKey = false

    public override var canBecomeKey: Bool { allowsKey }
    public override var canBecomeMain: Bool { false }
}

@MainActor
public final class FocusHUDWindowController {
    private var panel: FocusHUDPanel?
    private var hosting: NSHostingController<AnyView>?
    private var moveObserver: NSObjectProtocol?
    /// The app the user was typing in before a HUD field took key status; it gets focus back.
    private var appBeforeEditing: NSRunningApplication?
    private let makeContent: () -> AnyView
    private static let level: NSWindow.Level = .floating
    private static let frameKey = "focus.hud.frame"
    private static let visibleKey = "focus.hud.visible"
    private static let styleKey = "focus.hud.style"

    public static var savedStyle: FocusHUDStyle {
        FocusHUDStyle(rawValue: UserDefaults.standard.string(forKey: styleKey) ?? "") ?? .full
    }

    public private(set) var isVisible = false
    public private(set) var style: FocusHUDStyle = FocusHUDWindowController.savedStyle

    /// Whether the HUD was up when the app last closed. Default true: the point of a timer
    /// window is that it is there.
    public static var wasVisible: Bool {
        UserDefaults.standard.object(forKey: visibleKey) as? Bool ?? true
    }

    public init(content: @escaping () -> AnyView) {
        makeContent = content
    }

    public func toggle() {
        isVisible ? hide() : show(followPointer: true)
    }

    /// Swaps shape in place. The panel keeps its top-left corner so a compact HUD appears where
    /// the full one was, rather than jumping by the height difference.
    public func setStyle(_ next: FocusHUDStyle) {
        guard next != style else { return }
        style = next
        UserDefaults.standard.set(next.rawValue, forKey: Self.styleKey)
        guard let panel else { return }
        // The content closure reads the current style, so the rootView has to be rebuilt for
        // the swap to reach the view. Cheap: one SwiftUI tree, once per toggle.
        hosting?.rootView = makeContent()
        let size = FocusHUDMetrics.size(for: next)
        let topLeft = CGPoint(x: panel.frame.minX, y: panel.frame.maxY)
        panel.setFrame(CGRect(x: topLeft.x, y: topLeft.y - size.height,
                              width: size.width, height: size.height), display: true)
        persistFrame()
    }

    public func toggleStyle() {
        setStyle(style == .full ? .compact : .full)
    }

    /// Lets the panel take key status for a text field, and gives it back afterwards. Without
    /// the round trip a field in this window can be clicked but never typed into.
    public func beginTextEditing() {
        guard let panel else { return }
        appBeforeEditing = NSWorkspace.shared.frontmostApplication
        panel.allowsKey = true
        panel.makeKeyAndOrderFront(nil)
    }

    public func endTextEditing() {
        guard let panel else { return }
        panel.allowsKey = false
        panel.resignKey()
        // Hand focus back to whatever the user was actually working in. Hiding Genesis would do
        // it too, but it would also hide the Studio and every other Genesis window.
        if let previous = appBeforeEditing, previous != NSRunningApplication.current {
            previous.activate()
        }
        appBeforeEditing = nil
    }

    /// `followPointer` is for an explicit "show it" from a menu or a shortcut: if the remembered
    /// frame is on a different screen from the pointer, the window comes to the screen you are
    /// looking at. An automatic show (a phase starting, a relaunch) leaves it where you put it.
    public func show(followPointer: Bool = false) {
        let panel = ensurePanel()
        // Rebuilt on every show so the tag menu lists the tags that exist now, not the ones
        // that existed when the window was first created.
        if panel.isVisible == false { hosting?.rootView = makeContent() }
        // Never move a window that is already on screen. Starting a phase calls show(), and
        // snapping the HUD back to a remembered frame at that moment throws away wherever the
        // user had just dragged it.
        if !panel.isVisible {
            restoreFrame(panel, followPointer: followPointer)
        } else if followPointer {
            bringToPointerScreenIfElsewhere(panel)
        }
        panel.orderFrontRegardless()
        isVisible = true
        UserDefaults.standard.set(true, forKey: Self.visibleKey)
    }

    public func hide() {
        persistFrame()
        panel?.orderOut(nil)
        isVisible = false
        UserDefaults.standard.set(false, forKey: Self.visibleKey)
    }

    // MARK: - Frame

    private func restoreFrame(_ panel: FocusHUDPanel, followPointer: Bool) {
        if let saved = UserDefaults.standard.string(forKey: Self.frameKey) {
            let rect = NSRectFromString(saved)
            // A remembered position on a display that is now unplugged would put the HUD
            // somewhere nobody can see, so fall back when it no longer intersects a screen.
            if rect.width > 0, NSScreen.screens.contains(where: { $0.frame.intersects(rect) }) {
                // Remembered, but on another display than the one being used: an explicit
                // "show" has to end with the window in front of the person who asked.
                if followPointer, let pointerScreen = screenUnderPointer(),
                   !pointerScreen.frame.intersects(rect) {
                    defaultPosition(panel, on: pointerScreen)
                    return
                }
                // The saved top-left corner, at the current style's size: the shape may have changed in
                // Settings since the frame was saved, and the content is built for the current one.
                let size = FocusHUDMetrics.size(for: style)
                panel.setFrame(CGRect(x: rect.minX, y: rect.maxY - size.height, width: size.width, height: size.height),
                               display: false)
                return
            }
        }
        defaultPosition(panel, on: screenUnderPointer())
    }

    private func bringToPointerScreenIfElsewhere(_ panel: FocusHUDPanel) {
        guard let pointerScreen = screenUnderPointer(),
              !pointerScreen.frame.intersects(panel.frame) else { return }
        defaultPosition(panel, on: pointerScreen)
    }

    private func screenUnderPointer() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    }

    private func persistFrame() {
        guard let panel else { return }
        UserDefaults.standard.set(NSStringFromRect(panel.frame), forKey: Self.frameKey)
    }

    /// Bottom-right of the given screen, inset clear of the Dock.
    private func defaultPosition(_ panel: FocusHUDPanel, on screen: NSScreen?) {
        guard let visible = screen?.visibleFrame else { return }
        let size = FocusHUDMetrics.size(for: style)
        let origin = CGPoint(x: visible.maxX - size.width - 24, y: visible.minY + 24)
        panel.setFrame(CGRect(origin: origin, size: size), display: false)
    }

    private func ensurePanel() -> FocusHUDPanel {
        if let panel { return panel }

        let panel = FocusHUDPanel(
            contentRect: CGRect(origin: .zero, size: FocusHUDMetrics.size(for: style)),
            styleMask: [.borderless, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        // NSPanel defaults this to true, which would hide the HUD the moment you go back to
        // the app you are working in — i.e. always. Same trap the companion overlay documents.
        panel.hidesOnDeactivate = false
        panel.level = Self.level
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isReleasedWhenClosed = false

        let hosting = NSHostingController(rootView: makeContent())
        hosting.sizingOptions = []
        panel.contentViewController = hosting
        self.hosting = hosting
        panel.setAccessibilityIdentifier("focus-hud-window")

        // Remember where it was dragged the moment it lands, not at hide time. A crash or a
        // kill between the drag and the hide would otherwise lose the position.
        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.persistFrame() }
            }

        self.panel = panel
        return panel
    }
}
