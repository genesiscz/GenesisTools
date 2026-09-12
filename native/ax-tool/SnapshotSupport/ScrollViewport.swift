import Foundation

public struct ScrollViewportAncestor: Equatable {
    public let identity: Int
    public let role: String
    public let frame: CGRect

    public init(identity: Int, role: String, frame: CGRect) {
        self.identity = identity
        self.role = role
        self.frame = frame
    }
}

public enum PageScrollAxis {
    case horizontal
    case vertical
}

public enum ScrollViewportError: Error, LocalizedError {
    case unavailable
    case changed

    public var errorDescription: String? {
        switch self {
        case .unavailable: return "no trustworthy AXScrollArea viewport at point; use --pixels"
        case .changed: return "scroll viewport geometry changed; inspect before retrying"
        }
    }
}

public func resolveScrollViewport(
    ancestors: [ScrollViewportAncestor],
    selectedWindowIdentity: Int,
    selectedWindowFrame: CGRect,
    point: CGPoint
) throws -> ScrollViewportAncestor {
    guard let windowIndex = ancestors.firstIndex(where: { $0.identity == selectedWindowIdentity }),
          ancestors[windowIndex].role == "AXWindow",
          selectedWindowFrame.width.isFinite,
          selectedWindowFrame.height.isFinite,
          selectedWindowFrame.width > 0,
          selectedWindowFrame.height > 0,
          selectedWindowFrame.contains(point),
          let viewport = ancestors[..<windowIndex].first(where: { $0.role == "AXScrollArea" }),
          viewport.frame.origin.x.isFinite,
          viewport.frame.origin.y.isFinite,
          viewport.frame.width.isFinite,
          viewport.frame.height.isFinite,
          viewport.frame.width > 0,
          viewport.frame.height > 0,
          selectedWindowFrame.contains(viewport.frame),
          viewport.frame.contains(point) else {
        throw ScrollViewportError.unavailable
    }

    return viewport
}

public func validateScrollViewportUnchanged(
    expected: ScrollViewportAncestor,
    current: ScrollViewportAncestor
) throws {
    guard expected.identity == current.identity, expected.role == current.role, expected.frame.equalTo(current.frame) else {
        throw ScrollViewportError.changed
    }
}

public func pageScrollDistance(viewport: ScrollViewportAncestor, axis: PageScrollAxis, pages: Int) throws -> Int {
    let page = axis == .horizontal ? viewport.frame.width : viewport.frame.height
    let distance = page * Double(pages)
    guard (1...20).contains(pages), distance.isFinite, distance >= 1, distance <= 1_000_000 else {
        throw ScrollViewportError.unavailable
    }

    return Int(distance.rounded())
}
