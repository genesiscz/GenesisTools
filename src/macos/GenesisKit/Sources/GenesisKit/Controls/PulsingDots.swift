import AppKit
import SwiftUI

/// Dots in a row that grow and brighten in turn ("working…"), animated by Core Animation.
///
/// The same look as a SwiftUI `scaleEffect` + `opacity` with `.repeatForever(autoreverses:)` and a
/// per-dot delay, without its cost: SwiftUI animates in the app, so every display frame re-evaluated
/// the view graph and laid out the window while an agent worked. A layer animation runs in the
/// render server and the app does nothing between frames (measured on the widget's ring, 2026-10-08:
/// 0.72 s of CPU per 15 s for one SwiftUI ring, none for the layer one).
public struct PulsingDots: NSViewRepresentable {
    public var color: Color
    public var count: Int
    public var diameter: CGFloat
    public var spacing: CGFloat
    /// Seconds from small to full (and the same back).
    public var period: Double
    /// How much later each dot starts than the one before it.
    public var stagger: Double

    public init(color: Color, count: Int = 3, diameter: CGFloat = 4.5, spacing: CGFloat = 3, period: Double = 0.55, stagger: Double = 0.18) {
        self.color = color
        self.count = count
        self.diameter = diameter
        self.spacing = spacing
        self.period = period
        self.stagger = stagger
    }

    public func makeNSView(context: Context) -> DotsView {
        DotsView()
    }

    public func updateNSView(_ view: DotsView, context: Context) {
        view.configure(
            DotsView.Style(color: NSColor(color).cgColor, count: count, diameter: diameter, spacing: spacing, period: period, stagger: stagger)
        )
    }

    public func sizeThatFits(_ proposal: ProposedViewSize, nsView: DotsView, context: Context) -> CGSize? {
        CGSize(width: CGFloat(count) * diameter + CGFloat(max(0, count - 1)) * spacing, height: diameter)
    }

    public final class DotsView: NSView {
        struct Style: Equatable {
            var color: CGColor
            var count: Int
            var diameter: CGFloat
            var spacing: CGFloat
            var period: Double
            var stagger: Double
        }

        private var style: Style?
        private var dots: [CALayer] = []
        private static let pulseKey = "genesis.pulse"

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not used")
        }

        func configure(_ style: Style) {
            guard style != self.style else { return }
            self.style = style
            dots.forEach { $0.removeFromSuperlayer() }
            dots = (0..<style.count).map { _ in
                let dot = CALayer()
                dot.backgroundColor = style.color
                dot.cornerRadius = style.diameter / 2
                layer?.addSublayer(dot)
                return dot
            }
            needsLayout = true
            restartPulse()
        }

        override public func layout() {
            super.layout()
            guard let style else { return }
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            let width = CGFloat(style.count) * style.diameter + CGFloat(max(0, style.count - 1)) * style.spacing
            var x = (bounds.width - width) / 2
            for dot in dots {
                dot.bounds = CGRect(x: 0, y: 0, width: style.diameter, height: style.diameter)
                dot.position = CGPoint(x: x + style.diameter / 2, y: bounds.midY)
                x += style.diameter + style.spacing
            }
            CATransaction.commit()
        }

        override public func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            // A layer drops its animations when its view leaves the window; dots that come back pulse again.
            restartPulse()
        }

        private func restartPulse() {
            guard let style else { return }
            let now = CACurrentMediaTime()
            for (index, dot) in dots.enumerated() {
                dot.removeAnimation(forKey: Self.pulseKey)
                // The resting look between runs, as the SwiftUI version showed before its first frame.
                dot.transform = CATransform3DMakeScale(0.55, 0.55, 1)
                dot.opacity = 0.4
                guard window != nil, style.period > 0 else { continue }
                let scale = CABasicAnimation(keyPath: "transform.scale")
                scale.fromValue = 0.55
                scale.toValue = 1
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0.4
                fade.toValue = 1
                let pulse = CAAnimationGroup()
                pulse.animations = [scale, fade]
                pulse.duration = style.period
                pulse.autoreverses = true
                pulse.repeatCount = .infinity
                pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                pulse.beginTime = now + Double(index) * style.stagger
                pulse.fillMode = .backwards
                pulse.isRemovedOnCompletion = false
                dot.add(pulse, forKey: Self.pulseKey)
            }
        }
    }
}
