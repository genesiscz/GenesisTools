import AppKit
import SwiftUI

private final class EdgeInteractionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

private final class EdgeFrameAnimation: NSAnimation {
    var render: ((Double) -> Void)?
    override var currentProgress: NSAnimation.Progress {
        get { super.currentProgress }
        set {
            super.currentProgress = newValue
            render?(Double(newValue))
        }
    }
}

/// Owns only one native panel. Content and actions belong to the host.
@MainActor
public final class EdgePanelController<Content: View> {
    public let panel: NSPanel
    public let placement: EdgePanelPlacement
    private let screen: NSScreen
    private let compactSize: CGSize
    private let expandedSize: CGSize
    private var animation: EdgeFrameAnimation?
    private var generation = 0
    public private(set) var isExpanded = false

    public init(
        placement: EdgePanelPlacement, screen: NSScreen, compactSize: CGSize, expandedSize: CGSize,
        title: String, @ViewBuilder content: () -> Content
    ) {
        self.placement = placement
        self.screen = screen
        self.compactSize = compactSize
        self.expandedSize = expandedSize
        let frame = EdgePanelGeometry.frame(
            placement: placement, size: compactSize, screen: screen.frame,
            visible: screen.visibleFrame, sideCenterY: screen.visibleFrame.midY + 55)
        let panel = EdgeInteractionPanel(
            contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.title = title
        panel.identifier = NSUserInterfaceItemIdentifier("widget-preview." + placement.rawValue)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.contentView = NSHostingView(rootView: content())
        self.panel = panel
    }

    public func show() { panel.orderFrontRegardless() }

    public func hide() {
        generation += 1
        animation?.stop()
        animation = nil
        panel.orderOut(nil)
    }

    public func setExpanded(_ expanded: Bool, reduceMotion: Bool) {
        let becameExpanded = expanded && !isExpanded
        generation += 1
        let token = generation
        animation?.stop()
        isExpanded = expanded
        let target = EdgePanelGeometry.frame(
            placement: placement, size: expanded ? expandedSize : compactSize,
            screen: screen.frame, visible: screen.visibleFrame,
            sideCenterY: screen.visibleFrame.midY + 55)
        if reduceMotion || !panel.isVisible || panel.frame == target {
            panel.setFrame(target, display: true)
        } else {
            let start = panel.frame
            let next = EdgeFrameAnimation(duration: expanded ? 0.40 : 0.28, animationCurve: .linear)
            next.animationBlockingMode = .nonblocking
            next.frameRate = 60
            next.render = { [weak self] value in
                guard let self, self.generation == token else { return }
                let progress = EdgePanelGeometry.motionProgress(value, opening: expanded)
                self.panel.setFrame(
                    EdgePanelGeometry.interpolate(from: start, to: target, progress: progress), display: true)
            }
            animation = next
            next.start()
        }
        if becameExpanded {
            panel.makeKeyAndOrderFront(nil)
        }
    }

}
