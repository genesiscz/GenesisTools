import SwiftUI

/// Concave shoulders meet the bezel; only the inward edge has ordinary rounded corners.
public struct EdgePanelShape: Shape {
    public var placement: EdgePanelPlacement
    public var shoulder: CGFloat
    public var corner: CGFloat
    public var joined: Bool

    public init(placement: EdgePanelPlacement, shoulder: CGFloat = 10, corner: CGFloat = 18, joined: Bool = true) {
        self.placement = placement
        self.shoulder = shoulder
        self.corner = corner
        self.joined = joined
    }

    public var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(shoulder, corner) }
        set { shoulder = newValue.first; corner = newValue.second }
    }

    public func path(in rect: CGRect) -> Path {
        if !joined {
            return RoundedRectangle(cornerRadius: corner, style: .continuous).path(in: rect)
        }
        let vertical = placement != .top
        let width = vertical ? rect.width : rect.height
        let height = vertical ? rect.height : rect.width
        let s = min(max(0, shoulder), min(width / 3, height / 4))
        let c = min(max(0, corner), min(width - s, (height - 2 * s) / 2))
        var path = Path()
        path.move(to: CGPoint(x: width, y: 0))
        path.addQuadCurve(to: CGPoint(x: width - s, y: s), control: CGPoint(x: width, y: s))
        path.addLine(to: CGPoint(x: c, y: s))
        path.addQuadCurve(to: CGPoint(x: 0, y: s + c), control: CGPoint(x: 0, y: s))
        path.addLine(to: CGPoint(x: 0, y: height - s - c))
        path.addQuadCurve(to: CGPoint(x: c, y: height - s), control: CGPoint(x: 0, y: height - s))
        path.addLine(to: CGPoint(x: width - s, y: height - s))
        path.addQuadCurve(to: CGPoint(x: width, y: height), control: CGPoint(x: width, y: height - s))
        path.closeSubpath()
        let transform: CGAffineTransform
        switch placement {
        case .right:
            transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
        case .left:
            transform = CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: rect.maxX, ty: rect.minY)
        case .top:
            transform = CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: rect.minX, ty: rect.maxY)
        }
        return path.applying(transform)
    }
}
