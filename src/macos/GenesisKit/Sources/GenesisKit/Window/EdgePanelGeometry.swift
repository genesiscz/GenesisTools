import AppKit

public enum EdgePanelPlacement: String, CaseIterable, Identifiable {
    case top, right, left
    public var id: String { rawValue }
}

public enum EdgePanelGeometry {
    public static func frame(
        placement: EdgePanelPlacement, size: CGSize, screen: CGRect, visible: CGRect, sideCenterY: CGFloat
    ) -> CGRect {
        let width = min(max(1, size.width), screen.width)
        let height = min(max(1, size.height), placement == .top ? screen.height : visible.height)
        switch placement {
        case .top:
            return CGRect(x: screen.midX - width / 2, y: screen.maxY - height, width: width, height: height)
        case .right, .left:
            let y = min(max(sideCenterY - height / 2, visible.minY), visible.maxY - height)
            return CGRect(
                x: placement == .right ? screen.maxX - width : screen.minX, y: y, width: width, height: height)
        }
    }

    public static func interpolate(from: CGRect, to: CGRect, progress: CGFloat) -> CGRect {
        CGRect(
            x: from.minX + (to.minX - from.minX) * progress,
            y: from.minY + (to.minY - from.minY) * progress,
            width: max(1, from.width + (to.width - from.width) * progress),
            height: max(1, from.height + (to.height - from.height) * progress))
    }

    public static func motionProgress(_ progress: Double, opening: Bool) -> CGFloat {
        let t = min(1, max(0, progress))
        guard t < 1 else { return 1 }
        if !opening {
            return CGFloat(1 - pow(1 - t, 3))
        }
        let end = 1 - exp(-10.0) * cos(8.0)
        return CGFloat((1 - exp(-10 * t) * cos(8 * t)) / end)
    }
}
