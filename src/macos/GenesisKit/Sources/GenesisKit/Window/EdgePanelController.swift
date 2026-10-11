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
    /// Where the content sits in the window (top-left origin) while the outline changes size around the same content,
    /// or nil when it fills the window. It moves with the outline's edges in one SwiftUI animation on the outline's
    /// curve, so a composer at the bottom stays at the bottom edge while the window itself changes size only once.
    @Published public internal(set) var contentFrame: CGRect?

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
        /// The same content at another size (`beginReshape`), rather than a change of what the panel shows.
        let reshape: Bool
        /// Starts the motion at the first display frame (a reshape's outline and content start together there).
        var pendingStart: (() -> Void)?
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
    private var generation = 0
    public private(set) var isExpanded = false
    /// An expanded panel takes the keyboard (its composer). Off only for scripted motion checks on the user's own
    /// screen, which must not take the keyboard from the app they are typing in.
    public var becomesKeyOnExpand = true
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
        if let presentation = lastPresentation, motion.presentation != presentation {
            motion.presentation = presentation
        }
        placeContent(nil)
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
        let wasReshaping = transition?.reshape == true
        end(outcome: "interrupted")
        isExpanded = expanded
        if reduceMotion || !panel.isVisible || from == target {
            settle(presentation, frame: target)
        } else if motion.presentation == presentation, !wasTransitioning || wasReshaping {
            // Same content, another size (a disclosure opened, an answer arrived, the rail gained a session): the
            // window changes once and the content moves with the outline's edges (`motion.contentFrame`).
            beginReshape(token: token, presentation: presentation, from: from, fromPath: fromPath,
                fromWindow: fromWindow, to: target)
        } else {
            // Only a change of content may keep the larger window while it shrinks, so that the old content stays
            // visible until the outline is small. A new size for the same content takes its window at once.
            let shrinking = motion.presentation != presentation
                && fromWindow.insetBy(dx: -0.5, dy: -0.5).contains(target)
            begin(token: token, presentation: presentation, from: from, fromPath: fromPath, fromWindow: fromWindow,
                to: target, shrinking: shrinking)
        }
        if becameExpanded, becomesKeyOnExpand {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private func settle(_ presentation: WidgetModulePresentation, frame: CGRect) {
        if motion.presentation != presentation { motion.presentation = presentation }
        // The content fills the final window again; at the end of a reshape it already sits exactly there.
        placeContent(nil)
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
        placeContent(nil)
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
            shrinking: shrinking, reshape: false, started: started, duration: duration,
            timing: AnimationTiming(at: started), ticker: ticker)
    }

    /// The same content at another size. The window changes at most once at each end (`EdgePanelGeometry.reshape`):
    /// growing, it takes the larger window first and the mask reveals it; shrinking, it keeps its window until the
    /// mask is small. Meanwhile the content moves with the outline's edges through `motion.contentFrame`, animated by
    /// SwiftUI on the same curve and duration as the mask, so a composer at the bottom rides the bottom edge.
    private func beginReshape(
        token: Int, presentation: WidgetModulePresentation, from: CGRect, fromPath: CGPath?, fromWindow: CGRect,
        to target: CGRect
    ) {
        let started = CACurrentMediaTime()
        let plan = EdgePanelGeometry.reshape(from: from, to: target, window: fromWindow)
        let outline = shape(presentation)
        let startPath: CGPath
        if let fromPath {
            var shift = CGAffineTransform(
                translationX: fromWindow.minX - plan.window.minX, y: fromWindow.minY - plan.window.minY)
            startPath = fromPath.copy(using: &shift) ?? fromPath
        } else {
            startPath = EdgePanelGeometry.maskPath(shape: outline, visible: from, window: plan.window)
        }
        let endPath = EdgePanelGeometry.maskPath(shape: outline, visible: target, window: plan.window)
        let duration = GenMotion.duration(expanding: plan.growing) * Self.motionScale

        // The content takes its start place before the window changes, so the one resize moves nothing on screen.
        placeContent(plan.startContent)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        root.maskLayer.path = startPath
        root.clipping = true
        if panel.frame != plan.window { panel.setFrame(plan.window, display: true) }
        root.layoutSubtreeIfNeeded()
        CATransaction.commit()

        // The outline (render server) and the content (SwiftUI, main thread) start together at the first display frame,
        // not now: the click that opened or closed something still lays out and draws its own change on the main
        // thread, and an outline started here ran 30-60 ms ahead of the content, so a shrinking side panel cut off
        // its own header for the first frames (live check, 2026-10-11).
        let start = { [weak self] in
            guard let self else { return }
            CATransaction.begin()
            CATransaction.setCompletionBlock { [weak self] in
                MainActor.assumeIsolated { self?.complete(token) }
            }
            let animation = CABasicAnimation(keyPath: "path")
            animation.fromValue = startPath
            animation.toValue = endPath
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(
                controlPoints: GenMotion.curve.0, GenMotion.curve.1, GenMotion.curve.2, GenMotion.curve.3)
            root.maskLayer.path = endPath
            root.maskLayer.add(animation, forKey: "edge.outline")
            CATransaction.commit()
            placeContent(plan.endContent, animation: .timingCurve(
                Double(GenMotion.curve.0), Double(GenMotion.curve.1), Double(GenMotion.curve.2),
                Double(GenMotion.curve.3), duration: duration))
        }

        let ticker = EdgeFrameTicker(view: root) { [weak self] in
            MainActor.assumeIsolated { self?.tick(token) }
        }
        transition = Transition(
            token: token, from: from, to: target, window: plan.window, presentation: presentation,
            shrinking: !plan.growing, reshape: true, pendingStart: start, started: started, duration: duration,
            timing: AnimationTiming(at: started), ticker: ticker)
    }

    private func tick(_ token: Int) {
        guard var current = transition, current.token == token else { return }
        let start = CACurrentMediaTime()
        let pending = current.pendingStart
        current.pendingStart = nil
        // The window server draws the shadow from the window's pixels, so it follows the moving outline only when asked.
        panel.invalidateShadow()
        current.timing.record(startedAt: start, finishedAt: CACurrentMediaTime())
        transition = current
        pending?()
    }

    private func complete(_ token: Int) {
        guard let current = transition, current.token == token else { return }
        end(outcome: "completed")
        settle(current.presentation, frame: current.to)
    }

    /// Moves the content to `frame` (nil: the whole window) with exactly `animation`, whatever transaction the caller
    /// runs in: a disclosure's toggle runs inside its own animation and reaches here through the host's sync.
    private func placeContent(_ frame: CGRect?, animation: Animation? = nil) {
        guard motion.contentFrame != frame else { return }
        var transaction = Transaction(animation: animation)
        transaction.disablesAnimations = animation == nil
        withTransaction(transaction) { motion.contentFrame = frame }
    }

    /// Stops the running transition where it is. The caller decides what the panel shows next.
    private func end(outcome: String) {
        guard let current = transition else { return }
        transition = nil
        current.ticker.stop()
        root.maskLayer.removeAnimation(forKey: "edge.outline")
        let kind = current.shrinking ? "shrink" : "grow"
        log(current.timing.summary(outcome: outcome), presentation: current.presentation,
            kind: current.reshape ? "reshape." + kind : kind)
    }

    private func log(_ summary: AnimationTiming.Summary, presentation: WidgetModulePresentation, kind: String) {
        lastTransitionTiming = summary
        PerfLog.mark("edge.transition pid=\(ProcessInfo.processInfo.processIdentifier) window=\(panel.windowNumber) edge=\(placement.rawValue) state=\(presentation) \(kind) \(summary.description)")
    }
}
