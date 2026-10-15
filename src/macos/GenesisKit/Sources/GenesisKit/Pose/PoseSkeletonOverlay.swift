import SwiftUI

/// Maps normalized pose coordinates onto a view that shows the camera image with aspect fill, the way
/// `CameraPreviewView` does. Pure, for tests.
public struct PoseOverlayGeometry: Equatable, Sendable {
    public var size: CGSize
    /// Image width over height.
    public var imageAspect: Double
    public var mirrored: Bool

    public init(size: CGSize, imageAspect: Double, mirrored: Bool) {
        self.size = size
        self.imageAspect = imageAspect > 0 ? imageAspect : 4.0 / 3.0
        self.mirrored = mirrored
    }

    /// The rectangle the whole image covers (it overflows the view on one axis).
    public var imageRect: CGRect {
        guard size.width > 0, size.height > 0 else { return .zero }
        let viewAspect = size.width / size.height
        if viewAspect > imageAspect {
            let height = size.width / imageAspect
            return CGRect(x: 0, y: (size.height - height) / 2, width: size.width, height: height)
        }
        let width = size.height * imageAspect
        return CGRect(x: (size.width - width) / 2, y: 0, width: width, height: size.height)
    }

    public func point(_ x: Double, _ y: Double) -> CGPoint {
        let rect = imageRect
        let column = mirrored ? 1 - x : x
        return CGPoint(x: rect.minX + column * rect.width, y: rect.minY + y * rect.height)
    }

    public func rect(_ box: CGRect) -> CGRect {
        let a = point(Double(box.minX), Double(box.minY))
        let b = point(Double(box.maxX), Double(box.maxY))
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }
}

/// The detected pose drawn over a camera preview: joints as small rings, bones as thin lines, mirrored
/// to match the preview. With a `target` (the calibrated pose, or the last good one) it also draws that
/// pose as a faint dashed ghost and an arrow from each joint that has moved away from it.
///
/// One `Canvas` pass per sample and no animation of its own: it redraws only when its inputs change,
/// and it compares equal when they do not, so a parent update does not repaint it. It takes no clicks.
public struct PoseSkeletonOverlay: View, Equatable {
    public var sample: PoseSample?
    public var target: PoseSample?
    public var mirrored: Bool
    public var tint: Color
    public var targetTint: Color
    /// A joint farther than this fraction of the view's shorter side from its target gets an arrow.
    public var arrowThreshold: Double

    public init(sample: PoseSample?, target: PoseSample? = nil, mirrored: Bool = true, tint: Color = .white,
                targetTint: Color = .mint, arrowThreshold: Double = 0.03) {
        self.sample = sample
        self.target = target
        self.mirrored = mirrored
        self.tint = tint
        self.targetTint = targetTint
        self.arrowThreshold = arrowThreshold
    }

    /// The lines drawn between joints: the shoulder line and the neck up to the nose (the head's drop).
    public static let bones: [(PoseJoint, PoseJoint)] = [
        (.rightShoulder, .neck), (.neck, .leftShoulder), (.neck, .nose),
    ]
    /// The joints drawn as rings.
    public static let rings: [PoseJoint] = [.nose, .leftEye, .rightEye, .leftEar, .rightEar, .leftShoulder, .rightShoulder]

    public var body: some View {
        Canvas(rendersAsynchronously: false) { context, size in
            if let target {
                draw(target, in: &context, size: size, ghost: true)
            }
            if let sample {
                draw(sample, in: &context, size: size, ghost: false)
                if let target { drawArrows(from: sample, to: target, in: &context, size: size) }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func geometry(_ sample: PoseSample, _ size: CGSize) -> PoseOverlayGeometry {
        PoseOverlayGeometry(size: size, imageAspect: sample.imageAspect, mirrored: mirrored)
    }

    private func draw(_ sample: PoseSample, in context: inout GraphicsContext, size: CGSize, ghost: Bool) {
        let map = geometry(sample, size)
        let color = ghost ? targetTint.opacity(0.55) : tint.opacity(0.9)
        let line = StrokeStyle(lineWidth: ghost ? 1.25 : 1.5, lineCap: .round, lineJoin: .round,
                               dash: ghost ? [4, 4] : [])
        var bones = Path()
        for (a, b) in Self.bones {
            guard let start = sample.joint(a), let end = sample.joint(b) else { continue }
            bones.move(to: map.point(start.x, start.y))
            bones.addLine(to: map.point(end.x, end.y))
        }
        if sample.joint(.neck) == nil, let left = sample.joint(.leftShoulder), let right = sample.joint(.rightShoulder) {
            bones.move(to: map.point(left.x, left.y))
            bones.addLine(to: map.point(right.x, right.y))
        }
        if !ghost {
            // A dark halo under the light line keeps it readable on a bright wall, without a shadow.
            context.stroke(bones, with: .color(.black.opacity(0.28)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
        }
        context.stroke(bones, with: .color(color), style: line)

        if sample.joints.isEmpty, let face = sample.face, face.confidence > PoseSample.minimumConfidence {
            let box = Path(roundedRect: map.rect(face.box), cornerRadius: 10, style: .continuous)
            context.stroke(box, with: .color(color), style: line)
        }

        let radius: CGFloat = ghost ? 3 : 3.5
        for joint in Self.rings {
            guard let point = sample.joint(joint) else { continue }
            let center = map.point(point.x, point.y)
            let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            if !ghost { context.stroke(ring, with: .color(.black.opacity(0.28)), lineWidth: 3) }
            context.stroke(ring, with: .color(color), lineWidth: ghost ? 1 : 1.25)
            if !ghost {
                let dot = Path(ellipseIn: CGRect(x: center.x - 1, y: center.y - 1, width: 2, height: 2))
                context.fill(dot, with: .color(color))
            }
        }
    }

    private func drawArrows(from sample: PoseSample, to target: PoseSample, in context: inout GraphicsContext, size: CGSize) {
        let threshold = arrowThreshold * Double(min(size.width, size.height))
        let color = targetTint.opacity(0.95)
        for joint in Self.rings {
            guard let current = sample.joint(joint), let goal = target.joint(joint) else { continue }
            let from = geometry(sample, size).point(current.x, current.y)
            let to = geometry(target, size).point(goal.x, goal.y)
            for segment in Self.arrow(from: from, to: to, threshold: threshold) {
                context.stroke(segment, with: .color(color), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// The shaft and head of an arrow from `from` towards `to`, stopping short of both ends; empty when
    /// the points are closer than `threshold`.
    static func arrow(from: CGPoint, to: CGPoint, threshold: Double) -> [Path] {
        let dx = to.x - from.x, dy = to.y - from.y
        let length = hypot(dx, dy)
        guard length >= threshold, length > 8 else { return [] }
        let ux = dx / length, uy = dy / length
        let start = CGPoint(x: from.x + ux * 6, y: from.y + uy * 6)
        let tip = CGPoint(x: to.x - ux * 5, y: to.y - uy * 5)
        var shaft = Path()
        shaft.move(to: start)
        shaft.addLine(to: tip)
        let head: CGFloat = min(6, length / 3)
        var wings = Path()
        wings.move(to: CGPoint(x: tip.x - ux * head - uy * head * 0.6, y: tip.y - uy * head + ux * head * 0.6))
        wings.addLine(to: tip)
        wings.addLine(to: CGPoint(x: tip.x - ux * head + uy * head * 0.6, y: tip.y - uy * head - ux * head * 0.6))
        return [shaft, wings]
    }

    public nonisolated static func == (lhs: PoseSkeletonOverlay, rhs: PoseSkeletonOverlay) -> Bool {
        lhs.sample == rhs.sample && lhs.target == rhs.target && lhs.mirrored == rhs.mirrored
            && lhs.tint == rhs.tint && lhs.targetTint == rhs.targetTint && lhs.arrowThreshold == rhs.arrowThreshold
    }
}

/// Which pose the live overlay draws as its target.
public enum PoseOverlayTarget: Equatable, Sendable {
    case none
    /// The last sample taken while posture was upright and clear (SlouchSniper's "last good pose").
    case lastGood
    /// A fixed pose, usually the calibration's reference pose.
    case pose(PoseSample)
}

/// `PoseSkeletonOverlay` fed by a `PoseSampleFeed`. It is the only view that observes the feed, so a new
/// sample re-renders this leaf and nothing else; it tells the feed it is watched while on screen.
public struct PoseSkeletonLiveOverlay: View {
    @ObservedObject private var feed: PoseSampleFeed
    private let target: PoseOverlayTarget
    private let mirrored: Bool
    private let tint: Color
    private let targetTint: Color

    public init(feed: PoseSampleFeed, target: PoseOverlayTarget = .none, mirrored: Bool = true,
                tint: Color = .white, targetTint: Color = .mint) {
        self.feed = feed
        self.target = target
        self.mirrored = mirrored
        self.tint = tint
        self.targetTint = targetTint
    }

    public var body: some View {
        PoseSkeletonOverlay(sample: feed.sample, target: resolvedTarget, mirrored: mirrored, tint: tint,
                            targetTint: targetTint)
            .equatable()
            .onAppear { feed.beginWatching() }
            .onDisappear { feed.endWatching() }
    }

    private var resolvedTarget: PoseSample? {
        switch target {
        case .none: nil
        case .lastGood: feed.lastGood
        case let .pose(sample): sample
        }
    }
}
