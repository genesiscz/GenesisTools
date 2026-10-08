import AppKit
import SwiftUI

/// An open arc that turns clockwise, drawn and turned by Core Animation.
///
/// A SwiftUI `rotationEffect` driven by `.repeatForever` is animated in the app: every display frame
/// re-evaluates the view graph and lays out the whole window. One working ring in the agent widget
/// kept GenesisTools Preview at 23% CPU (2026-10-08). Here the turn is a layer animation, which the
/// render server runs, so the app does no work between frames.
public struct SpinningArc: NSViewRepresentable {
    public var color: Color
    public var lineWidth: CGFloat
    /// The visible part of the circle, as `Circle().trim(from:to:)` takes it.
    public var trim: ClosedRange<CGFloat>
    /// Seconds per turn.
    public var period: Double
    /// False draws the arc still.
    public var spinning: Bool

    public init(color: Color, lineWidth: CGFloat = 2, trim: ClosedRange<CGFloat> = 0.12...0.78, period: Double = 1.65, spinning: Bool = true) {
        self.color = color
        self.lineWidth = lineWidth
        self.trim = trim
        self.period = period
        self.spinning = spinning
    }

    public func makeNSView(context: Context) -> ArcView {
        ArcView()
    }

    public func updateNSView(_ view: ArcView, context: Context) {
        view.configure(color: NSColor(color).cgColor, lineWidth: lineWidth, trim: trim, period: period, spinning: spinning)
    }

    public final class ArcView: NSView {
        private let arc = CAShapeLayer()
        private var period = 0.0
        private var spinning = false
        private static let spinKey = "genesis.spin"

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            arc.fillColor = nil
            arc.lineCap = .round
            layer?.addSublayer(arc)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not used")
        }

        func configure(color: CGColor, lineWidth: CGFloat, trim: ClosedRange<CGFloat>, period: Double, spinning: Bool) {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            arc.strokeColor = color
            arc.lineWidth = lineWidth
            arc.strokeStart = trim.lowerBound
            arc.strokeEnd = trim.upperBound
            CATransaction.commit()
            if period != self.period || spinning != self.spinning {
                self.period = period
                self.spinning = spinning
                restartSpin()
            }
        }

        override public func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            arc.frame = bounds
            let inset = arc.lineWidth / 2
            // From three o'clock, clockwise on screen, as `Circle().trim` draws (the layer's y axis points up).
            let path = CGMutablePath()
            let radius = max(0, min(bounds.width, bounds.height) / 2 - inset)
            path.addArc(center: CGPoint(x: bounds.midX, y: bounds.midY), radius: radius, startAngle: 0, endAngle: -2 * .pi, clockwise: true)
            arc.path = path
            CATransaction.commit()
        }

        override public func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // A layer drops its animations when its view leaves the window; one that comes back spins again.
            restartSpin()
        }

        private func restartSpin() {
            arc.removeAnimation(forKey: Self.spinKey)
            guard spinning, period > 0, window != nil else { return }
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0
            spin.toValue = -2 * Double.pi
            spin.duration = period
            spin.repeatCount = .infinity
            spin.isRemovedOnCompletion = false
            arc.add(spin, forKey: Self.spinKey)
        }
    }
}
