import AppKit
import QuartzCore

/// Marks the picker's targets in Cocoa screen points. A hover keeps its border until the row changes or clears.
@MainActor
public final class TargetPulse {
    private struct Overlay {
        let screen: CGRect
        let panel: NSPanel
        let stroke: CAShapeLayer
    }

    private static let animationKey = "recording.targetPulse"
    private static let animationDuration: CFTimeInterval = 0.9
    private let overlays: [Overlay]
    private let reduceMotion: () -> Bool
    private let installCompletion: (@escaping @MainActor () -> Void) -> Void
    private var hovered: [CGRect] = []
    private var choice: UUID?
    private var pending: Task<Void, Never>?

    public convenience init(screens: [CGRect] = NSScreen.screens.map(\.frame)) {
        self.init(screens: screens, reduceMotion: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion })
    }

    init(screens: [CGRect], reduceMotion: @escaping () -> Bool, makeStroke: () -> CAShapeLayer = { CAShapeLayer() },
         installCompletion: @escaping (@escaping @MainActor () -> Void) -> Void = { completion in
             CATransaction.setCompletionBlock { Task { @MainActor in completion() } }
         }) {
        self.reduceMotion = reduceMotion
        self.installCompletion = installCompletion
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        overlays = screens.map { screen in
            let view = NSView(frame: CGRect(origin: .zero, size: screen.size))
            view.setAccessibilityElement(false)
            let canvas = CALayer()
            view.layer = canvas
            view.wantsLayer = true
            let stroke = makeStroke()
            stroke.frame = view.bounds
            stroke.fillColor = nil
            canvas.addSublayer(stroke)
            return Overlay(screen: screen, panel: ScreenOverlayPanels.makePanel(frame: screen, view: view), stroke: stroke)
        }
    }

    deinit {
        pending?.cancel()
        let panels = overlays.map(\.panel)
        Task { @MainActor in panels.forEach { $0.close() } }
    }

    /// Stable exclusion IDs for both recorders, including displays with no visible marker.
    public var windowIDs: [Int] { overlays.map(\.panel.windowNumber) }

    /// Pass one rect per window of an app, the selected area, or each selected display inset by six points.
    public func hover(_ rects: [CGRect]) {
        guard !rects.isEmpty else { return clear() }
        guard rects != hovered || choice != nil else { return }
        pending?.cancel()
        pending = nil
        choice = nil
        hovered = rects
        draw(rects, reduceMotion: reduceMotion(), animate: true)
        // Settle on a timer, not on Core Animation's completion: an overlay that is not rendered (a test, a display
        // that sleeps) never reports one, and the two beats must not stay attached to a steady border.
        schedule(after: .milliseconds(Int(Self.animationDuration * 1000))) { pulse in
            guard pulse.choice == nil, pulse.hovered == rects else { return }
            pulse.draw(rects, reduceMotion: pulse.reduceMotion(), animate: false)
        }
    }

    /// Confirms a choice after the chosen window has had time to come forward.
    public func pulse(_ rects: [CGRect], after delay: Duration = .milliseconds(350)) {
        guard !rects.isEmpty else { return clear() }
        let id = UUID()
        choice = id
        if delay > .zero {
            draw(hovered, reduceMotion: reduceMotion(), animate: false)
        }
        schedule(after: delay) { pulse in
            let reduced = pulse.reduceMotion()
            // A replaced CA animation also calls its completion. Only this choice may restore the hover.
            let end: @MainActor () -> Void = { [weak pulse] in
                guard let pulse, pulse.choice == id else { return }
                pulse.choice = nil
                pulse.draw(pulse.hovered, reduceMotion: pulse.reduceMotion(), animate: false)
            }
            pulse.draw(rects, reduceMotion: reduced, animate: true, completion: reduced ? nil : end)
            if reduced { pulse.schedule(after: .milliseconds(1200)) { _ in end() } }
        }
    }

    public func clear() {
        pending?.cancel()
        pending = nil
        choice = nil
        hovered = []
        draw([], reduceMotion: false, animate: false)
    }

    /// The picker has gone away. Let an already committed choice finish, with no hover to restore.
    func pickerClosed() {
        hovered = []
        if choice == nil { clear() }
    }

    private func schedule(after delay: Duration, _ action: @escaping @MainActor (TargetPulse) -> Void) {
        pending?.cancel()
        if delay <= .zero {
            action(self)
            return
        }
        let deadline = ContinuousClock.now + delay
        pending = Task { [weak self] in
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            guard !Task.isCancelled, let self else { return }
            self.pending = nil
            action(self)
        }
    }

    private func draw(_ rects: [CGRect], reduceMotion: Bool, animate: Bool, completion: (@MainActor () -> Void)? = nil) {
        let animation = animate && !reduceMotion ? Self.beats() : nil
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let completion {
            installCompletion(completion)
        }
        defer { CATransaction.commit() }
        for overlay in overlays {
            let path = CGMutablePath()
            for rect in rects where !rect.intersection(overlay.screen).isEmpty {
                // The window clips the complete border. Stroking the intersection would draw a seam between displays.
                let local = rect.offsetBy(dx: -overlay.screen.minX, dy: -overlay.screen.minY)
                let radius = min(8, min(local.width, local.height) / 2)
                path.addRoundedRect(in: local, cornerWidth: radius, cornerHeight: radius)
            }
            let stroke = overlay.stroke
            stroke.removeAnimation(forKey: Self.animationKey)
            guard !path.isEmpty else {
                stroke.path = nil
                if overlay.panel.isVisible { overlay.panel.orderOut(nil) }
                continue
            }
            stroke.path = path
            stroke.lineWidth = reduceMotion ? 3 : 1.5
            stroke.opacity = reduceMotion ? 1 : 0.75
            stroke.contentsScale = overlay.panel.backingScaleFactor
            overlay.panel.effectiveAppearance.performAsCurrentDrawingAppearance {
                stroke.strokeColor = NSColor.controlAccentColor.cgColor
            }
            if !overlay.panel.isVisible { overlay.panel.orderFrontRegardless() }
            if let animation { stroke.add(animation, forKey: Self.animationKey) }
        }
    }

    /// Both properties share the same two peaks and settle at their model-layer values.
    private static func beats() -> CAAnimationGroup {
        let opacity = CAKeyframeAnimation(keyPath: "opacity")
        opacity.values = [0.75, 1, 0.75, 1, 0.75]
        let width = CAKeyframeAnimation(keyPath: "lineWidth")
        width.values = [1.5, 4, 1.5, 4, 1.5]
        for track in [opacity, width] {
            track.keyTimes = [0, 0.22, 0.5, 0.72, 1]
            track.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 4)
            track.duration = animationDuration
        }
        let group = CAAnimationGroup()
        group.animations = [opacity, width]
        group.duration = animationDuration
        return group
    }
}
