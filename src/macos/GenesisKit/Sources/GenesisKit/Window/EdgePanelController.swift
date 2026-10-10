import AppKit
import QuartzCore
import SwiftUI

private final class EdgeInteractionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

/// What an edge panel's content shows. A growing panel switches at the start of its transition and a shrinking one at
/// the end, so a closing panel keeps its content until the visible shape has reached its smaller size.
@MainActor
public final class EdgePanelMotion: ObservableObject {
    @Published public internal(set) var presentation: WidgetModulePresentation
    /// The pointer is on the panel. A host may build its larger content ahead of a click while this is true.
    @Published public var pointerInside = false

    public init(presentation: WidgetModulePresentation = .compact) {
        self.presentation = presentation
    }
}

/// The panel's root: the hosting view fills it, and while a transition runs a shape layer masks it to the animated
/// outline. The window itself changes size once per transition, so no frame of the motion re-lays out SwiftUI.
private final class EdgePanelRootView: NSView {
    let maskLayer = CAShapeLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        maskLayer.fillColor = NSColor.black.cgColor
        // A standalone layer animates every property change by default; only the explicit path animation may move it.
        maskLayer.actions = ["path": NSNull(), "bounds": NSNull(), "position": NSNull(), "frame": NSNull()]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var isFlipped: Bool { false }

    var clipping = false {
        didSet {
            guard clipping != oldValue else { return }
            layer?.mask = clipping ? maskLayer : nil
        }
    }

    override func layout() {
        super.layout()
        for view in subviews { view.frame = bounds }
        maskLayer.frame = bounds
    }
}

/// Wakes once per display frame while a transition runs: it keeps the window shadow on the moving outline and records
/// the callback timing. The motion itself runs in the render server and does not depend on these callbacks.
private final class EdgeFrameTicker: NSObject {
    private var link: CADisplayLink?
    private let tick: () -> Void

    init(view: NSView, tick: @escaping () -> Void) {
        self.tick = tick
        super.init()
        let link = view.displayLink(target: self, selector: #selector(step))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func step(_ link: CADisplayLink) { tick() }

    func stop() {
        link?.invalidate()
        link = nil
    }
}

/// Owns only one native panel. Content and actions belong to the host.
@MainActor
public final class EdgePanelController<Content: View> {
    private struct Transition {
        let token: Int
        let from: CGRect
        let to: CGRect
        let window: CGRect
        let presentation: WidgetModulePresentation
        let shrinking: Bool
        let started: CFTimeInterval
        let duration: CFTimeInterval
        var timing: AnimationTiming
        let ticker: EdgeFrameTicker
    }

    public let panel: NSPanel
    public let placement: EdgePanelPlacement
    /// What the hosted content should show; it lags the requested presentation while the panel shrinks.
    public let motion: EdgePanelMotion
    /// The outline of each presentation. The mask draws the same shape the content clips to, so the hand-over at the
    /// end of a transition is invisible.
    public var shape: (WidgetModulePresentation) -> EdgePanelShape
    private let screen: NSScreen
    private let root: EdgePanelRootView
    private let hosting: NSHostingView<Content>
    private var compactSize: CGSize
    private var expandedSize: CGSize
    private var previewSize = CGSize(width: 300, height: 240)
    private var sideCenterY: CGFloat?
    private var lastTarget: CGRect?
    private var lastPresentation: WidgetModulePresentation?
    private var transition: Transition?
    private struct Resize {
        let token: Int
        let from: CGRect
        let to: CGRect
        let presentation: WidgetModulePresentation
        let started: CFTimeInterval
        let duration: CFTimeInterval
        let curve: (Float, Float, Float, Float)
        var timing: AnimationTiming
        let ticker: EdgeFrameTicker
    }
    private var resize: Resize?
    private var generation = 0
    public private(set) var isExpanded = false
    /// Driver callback timing only; neither callback count nor gaps establish compositor frame delivery.
    public private(set) var lastTransitionTiming: AnimationTiming.Summary?
    /// Slows every transition by this factor (`GENESIS_WIDGET_MOTION_SCALE`), for frame-by-frame review.
    private static var motionScale: Double {
        let value = Double(ProcessInfo.processInfo.environment["GENESIS_WIDGET_MOTION_SCALE"] ?? "") ?? 1
        return value.isFinite && value > 0 ? min(value, 20) : 1
    }

    public init(
        placement: EdgePanelPlacement, screen: NSScreen, compactSize: CGSize, expandedSize: CGSize,
        title: String, motion: EdgePanelMotion? = nil,
        shape: ((WidgetModulePresentation) -> EdgePanelShape)? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.placement = placement
        self.screen = screen
        self.compactSize = compactSize
        self.expandedSize = expandedSize
        self.motion = motion ?? EdgePanelMotion()
        self.shape = shape ?? { _ in EdgePanelShape(placement: placement, shoulder: 0, corner: 0, joined: false) }
        let frame = EdgePanelGeometry.frame(
            placement: placement, size: compactSize, screen: screen.frame,
            visible: screen.visibleFrame, sideCenterY: screen.visibleFrame.midY + 55)
        let panel = EdgeInteractionPanel(
            contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.title = title
        panel.identifier = NSUserInterfaceItemIdentifier("widget-preview." + placement.rawValue)
        panel.isFloatingPanel = true
        // isFloatingPanel resets the level. Apply the top notch's menu-bar layer afterward.
        panel.level = placement == .top ? .statusBar : .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        let hosting = NSHostingView(rootView: content())
        // The controller owns the frame. Intrinsic sizing otherwise snaps an opening panel to the
        // content's full width between animation callbacks, moving its anchored edge off screen.
        hosting.sizingOptions = []
        let root = EdgePanelRootView(frame: CGRect(origin: .zero, size: frame.size))
        root.addSubview(hosting)
        hosting.frame = root.bounds
        panel.contentView = root
        self.panel = panel
        self.root = root
        self.hosting = hosting
    }

    public func updateContent(@ViewBuilder _ content: () -> Content) {
        hosting.rootView = content()
    }

    public func setCompactSize(_ size: CGSize) { compactSize = size }
    public func setExpandedSize(_ size: CGSize) { expandedSize = size }
    public func setPreviewSize(_ size: CGSize) { previewSize = size }
    public func setSideCenterY(_ value: CGFloat) { sideCenterY = value }

    /// The outline the user sees, in screen coordinates: the animated shape during a transition, else the window.
    public var visibleFrame: CGRect {
        guard let transition else { return panel.frame }
        if let path = root.maskLayer.presentation()?.path, !path.isEmpty {
            return path.boundingBoxOfPath.offsetBy(dx: transition.window.minX, dy: transition.window.minY)
        }
        return transition.from
    }

    public func show() {
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    public func hide() {
        lastTarget = nil
        generation += 1
        end(outcome: "interrupted")
        endResize(outcome: "interrupted")
        if let presentation = lastPresentation, motion.presentation != presentation {
            motion.presentation = presentation
        }
        panel.orderOut(nil)
    }

    public func setExpanded(_ expanded: Bool, reduceMotion: Bool) {
        setPresentation(expanded ? .expanded : .compact, reduceMotion: reduceMotion)
    }

    public func setPresentation(_ presentation: WidgetModulePresentation, reduceMotion: Bool) {
        let expanded = presentation == .expanded
        let becameExpanded = expanded && !isExpanded
        let size: CGSize
        switch presentation {
        case .compact: size = compactSize
        case .preview: size = previewSize
        case .expanded: size = expandedSize
        }
        let target = EdgePanelGeometry.frame(
            placement: placement, size: size,
            screen: screen.frame, visible: screen.visibleFrame,
            sideCenterY: sideCenterY ?? screen.visibleFrame.midY + 55)
        if lastTarget == target, lastPresentation == presentation, !reduceMotion { return }
        lastTarget = target
        lastPresentation = presentation
        generation += 1
        let token = generation
        let from = visibleFrame
        let fromPath = transition.flatMap { _ in root.maskLayer.presentation()?.path }
        let fromWindow = transition?.window ?? panel.frame
        let wasTransitioning = transition != nil
        end(outcome: "interrupted")
        endResize(outcome: "interrupted")
        isExpanded = expanded
        if reduceMotion || !panel.isVisible || from == target {
            settle(presentation, frame: target)
        } else if !wasTransitioning, motion.presentation == presentation {
            // Same content, another size (it was measured, or the rail gained a session): the edges move with the
            // content, which needs a real resize. These are rare and small; open and close stay layout-free.
            beginResize(token: token, presentation: presentation, from: panel.frame, to: target)
        } else {
            // Only a change of content may keep the larger window while it shrinks, so that the old content stays
            // visible until the outline is small. A new size for the same content takes its window at once.
            let shrinking = motion.presentation != presentation
                && fromWindow.insetBy(dx: -0.5, dy: -0.5).contains(target)
            begin(token: token, presentation: presentation, from: from, fromPath: fromPath, fromWindow: fromWindow,
                to: target, shrinking: shrinking)
        }
        if becameExpanded {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private func settle(_ presentation: WidgetModulePresentation, frame: CGRect) {
        if motion.presentation != presentation { motion.presentation = presentation }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        root.clipping = false
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        CATransaction.commit()
        panel.invalidateShadow()
    }

    private func begin(
        token: Int, presentation: WidgetModulePresentation, from: CGRect, fromPath: CGPath?, fromWindow: CGRect,
        to target: CGRect, shrinking: Bool
    ) {
        let started = CACurrentMediaTime()
        // A shrinking panel keeps its window and content until the outline is small; a growing one takes its final
        // window and content now, so the reveal never lays SwiftUI out again.
        let window = shrinking ? fromWindow : target
        let overlap = from.intersection(target)
        let visibleFrom = shrinking ? from : overlap.isNull ? target : overlap
        let startPath: CGPath
        if let fromPath, shrinking || target.contains(from) {
            var shift = CGAffineTransform(translationX: fromWindow.minX - window.minX, y: fromWindow.minY - window.minY)
            startPath = fromPath.copy(using: &shift) ?? fromPath
        } else {
            startPath = EdgePanelGeometry.maskPath(shape: shape(motion.presentation), visible: visibleFrom, window: window)
        }
        if !shrinking, motion.presentation != presentation { motion.presentation = presentation }
        let endPath = EdgePanelGeometry.maskPath(shape: shape(presentation), visible: target, window: window)
        let spec = EdgePanelGeometry.motion(to: presentation, shrinking: shrinking)
        let duration = spec.duration * Self.motionScale

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        root.maskLayer.path = startPath
        root.clipping = true
        if panel.frame != window {
            panel.setFrame(window, display: true)
            root.layoutSubtreeIfNeeded()
        }
        CATransaction.commit()

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated { self?.complete(token) }
        }
        let animation = CABasicAnimation(keyPath: "path")
        animation.fromValue = startPath
        animation.toValue = endPath
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(
            controlPoints: spec.curve.0, spec.curve.1, spec.curve.2, spec.curve.3)
        root.maskLayer.path = endPath
        root.maskLayer.add(animation, forKey: "edge.outline")
        CATransaction.commit()

        let ticker = EdgeFrameTicker(view: root) { [weak self] in
            MainActor.assumeIsolated { self?.tick(token) }
        }
        transition = Transition(
            token: token, from: visibleFrom, to: target, window: window, presentation: presentation,
            shrinking: shrinking, started: started, duration: duration, timing: AnimationTiming(at: started),
            ticker: ticker)
    }

    private func tick(_ token: Int) {
        guard var current = transition, current.token == token else { return }
        let start = CACurrentMediaTime()
        // The window server draws the shadow from the window's pixels, so it follows the moving outline only when asked.
        panel.invalidateShadow()
        current.timing.record(startedAt: start, finishedAt: CACurrentMediaTime())
        transition = current
    }

    private func complete(_ token: Int) {
        guard let current = transition, current.token == token else { return }
        end(outcome: "completed")
        settle(current.presentation, frame: current.to)
    }

    /// Stops the running transition where it is. The caller decides what the panel shows next.
    private func end(outcome: String) {
        guard let current = transition else { return }
        transition = nil
        current.ticker.stop()
        root.maskLayer.removeAnimation(forKey: "edge.outline")
        log(current.timing.summary(outcome: outcome), presentation: current.presentation,
            kind: current.shrinking ? "shrink" : "grow")
    }

    private func beginResize(token: Int, presentation: WidgetModulePresentation, from: CGRect, to target: CGRect) {
        let started = CACurrentMediaTime()
        root.clipping = false
        let spec = EdgePanelGeometry.motion(to: presentation, shrinking: target.height < from.height)
        let duration = spec.duration * Self.motionScale
        let ticker = EdgeFrameTicker(view: root) { [weak self] in
            MainActor.assumeIsolated { self?.resizeTick(token) }
        }
        resize = Resize(
            token: token, from: from, to: target, presentation: presentation, started: started, duration: duration,
            curve: spec.curve, timing: AnimationTiming(at: started), ticker: ticker)
    }

    private func resizeTick(_ token: Int) {
        guard var current = resize, current.token == token else { return }
        let start = CACurrentMediaTime()
        let progress = EdgePanelGeometry.bezier((start - current.started) / current.duration, current.curve)
        var frame = EdgePanelGeometry.interpolate(from: current.from, to: current.to, progress: CGFloat(progress))
        // AppKit rounds native frames. Re-anchor every step so an interrupted resize cannot carry that half-point
        // rounding error into the next one.
        switch placement {
        case .top:
            frame.origin.x = current.to.midX - frame.width / 2
            frame.origin.y = current.to.maxY - frame.height
        case .right: frame.origin.x = current.to.maxX - frame.width
        case .left: frame.origin.x = current.to.minX
        }
        let done = start - current.started >= current.duration
        panel.setFrame(done ? current.to : frame, display: true)
        current.timing.record(startedAt: start, finishedAt: CACurrentMediaTime())
        resize = current
        if done { endResize(outcome: "completed") }
    }

    private func endResize(outcome: String) {
        guard let current = resize else { return }
        resize = nil
        current.ticker.stop()
        log(current.timing.summary(outcome: outcome), presentation: current.presentation, kind: "resize")
    }

    private func log(_ summary: AnimationTiming.Summary, presentation: WidgetModulePresentation, kind: String) {
        lastTransitionTiming = summary
        PerfLog.mark("edge.transition pid=\(ProcessInfo.processInfo.processIdentifier) window=\(panel.windowNumber) edge=\(placement.rawValue) state=\(presentation) \(kind) \(summary.description)")
    }
}
