import AppKit
import SwiftUI

public enum EdgePanelPlacement: String, CaseIterable, Identifiable, Sendable {
    case top, right, left
    public var id: String { rawValue }
}

public enum EdgePanelGeometry {
    public static func frame(
        placement: EdgePanelPlacement, size: CGSize, screen: CGRect, visible: CGRect,
        sideCenterY: CGFloat
    ) -> CGRect {
        let width = min(max(1, size.width), screen.width)
        let height = min(max(1, size.height), placement == .top ? screen.height : visible.height)
        switch placement {
        case .top:
            return CGRect(
                x: screen.midX - width / 2, y: screen.maxY - height, width: width, height: height)
        case .right, .left:
            let y = min(max(sideCenterY - height / 2, visible.minY), visible.maxY - height)
            return CGRect(
                x: placement == .right ? screen.maxX - width : screen.minX, y: y, width: width,
                height: height)
        }
    }

    public static func mediaFrame(anchor: CGRect, visible: CGRect) -> CGRect {
        let bounds = visible.insetBy(dx: 12, dy: 12)
        let size = CGSize(width: min(740, bounds.width), height: min(650, bounds.height))
        return CGRect(
            x: min(max(anchor.midX - size.width / 2, bounds.minX), bounds.maxX - size.width),
            y: min(max(anchor.midY - size.height / 2, bounds.minY), bounds.maxY - size.height),
            width: size.width, height: size.height)
    }

    public static func interpolate(from: CGRect, to: CGRect, progress: CGFloat) -> CGRect {
        CGRect(
            x: from.minX + (to.minX - from.minX) * progress,
            y: from.minY + (to.minY - from.minY) * progress,
            width: max(1, from.width + (to.width - from.width) * progress),
            height: max(1, from.height + (to.height - from.height) * progress))
    }

    /// Duration and cubic Bézier control points of one outline transition. Opening uses a drawer curve that starts
    /// fast and settles without overshoot; closing is shorter, because a system response should get out of the way.
    public static func motion(
        to presentation: WidgetModulePresentation, shrinking: Bool
    ) -> (duration: Double, curve: (Float, Float, Float, Float)) {
        if shrinking { return (0.22, GenMotion.curve) }
        return (presentation == .expanded ? 0.30 : 0.22, GenMotion.curve)
    }

    /// How one size change around the same content runs (a disclosure opened, an answer arrived, the rail gained a
    /// session). The window changes at most once at each end, never per frame: a growing outline takes its larger
    /// window at the start and is revealed by the mask; a shrinking one keeps its window until the mask is small.
    public struct ReshapePlan: Equatable, Sendable {
        /// The window the motion runs in, in screen coordinates.
        public let window: CGRect
        public let resizesAtStart: Bool
        public let resizesAtEnd: Bool
        /// Expanding motion (GenMotion's longer opening duration) rather than collapsing.
        public let growing: Bool
        /// Where the content sits in `window` (top-left origin, as SwiftUI places it) at the start and the end.
        public let startContent: CGRect
        public let endContent: CGRect
    }

    public static func reshape(from visible: CGRect, to target: CGRect, window current: CGRect) -> ReshapePlan {
        let window: CGRect
        if current.insetBy(dx: -0.5, dy: -0.5).contains(target) {
            window = current
        } else if target.insetBy(dx: -0.5, dy: -0.5).contains(visible) {
            window = target
        } else {
            window = visible.union(target)
        }
        return ReshapePlan(
            window: window, resizesAtStart: window != current, resizesAtEnd: window != target,
            growing: target.width * target.height > visible.width * visible.height,
            startContent: localRect(visible, in: window), endContent: localRect(target, in: window))
    }

    /// `visible` (screen coordinates, y up) in the coordinates SwiftUI uses inside a window at `window`: top-left
    /// origin, y down.
    public static func localRect(_ visible: CGRect, in window: CGRect) -> CGRect {
        CGRect(
            x: visible.minX - window.minX, y: window.maxY - visible.maxY, width: visible.width, height: visible.height)
    }

    /// The eased progress of a cubic Bézier timing curve at linear time `t` (0…1), as CAMediaTimingFunction computes it.
    public static func bezier(_ t: Double, _ curve: (Float, Float, Float, Float)) -> Double {
        let (x1, y1, x2, y2) = (Double(curve.0), Double(curve.1), Double(curve.2), Double(curve.3))
        let time = min(1, max(0, t))
        func coordinate(_ s: Double, _ a: Double, _ b: Double) -> Double {
            3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s
        }
        // x(s) is monotonic for control points inside 0…1, so bisection finds s for the elapsed time.
        var low = 0.0, high = 1.0
        for _ in 0..<32 {
            let middle = (low + high) / 2
            if coordinate(middle, x1, x2) < time { low = middle } else { high = middle }
        }
        return coordinate((low + high) / 2, y1, y2)
    }

    /// The outline at `visible` (screen coordinates) as a path in the y-up coordinates of a window at `window`, drawn
    /// exactly as SwiftUI draws `shape` in that window's top-left-origin space.
    public static func maskPath(shape: EdgePanelShape, visible: CGRect, window: CGRect) -> CGPath {
        let path = shape.path(in: localRect(visible, in: window)).cgPath
        var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: window.height)
        return path.copy(using: &flip) ?? path
    }
}
