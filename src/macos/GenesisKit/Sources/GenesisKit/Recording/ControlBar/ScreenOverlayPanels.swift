import AppKit

/// One non-activating, click-through window per display, with its capture exclusion ID allocated up front.
@MainActor
enum ScreenOverlayPanels {
    static func makePanel(frame: CGRect, view: NSView) -> NSPanel {
        let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
                            defer: false)
        panel.title = "Recording target"
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.sharingType = .none
        panel.contentView = view
        panel.setFrame(frame, display: false)
        return panel
    }
}
