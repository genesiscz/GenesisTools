import CoreGraphics
import Foundation
import GenesisKit

/// The part of the hierarchy a sunburst shows: the focused node's span of the root and its depth. Animating these
/// three numbers from one focus to another is the whole drill transition: every arc follows from them.
public struct SunburstViewport: Equatable, Sendable {
    public var x0: Double
    public var x1: Double
    public var depth: Double

    public init(x0: Double, x1: Double, depth: Double) {
        self.x0 = x0
        self.x1 = x1
        self.depth = depth
    }

    /// The viewport that shows `item` as the centre.
    public init(_ item: ChartPartition.Item) {
        self.init(x0: item.x0, x1: item.x1, depth: Double(item.depth))
    }
}

/// One drawn ring segment. Angles are radians clockwise from twelve o'clock; radii are points from the centre.
public struct SunburstArc: Equatable, Sendable {
    /// The partition item, or the parent's item for an aggregate.
    public let item: Int
    public let id: String
    public let name: String
    public let value: Double
    /// 1 for the ring around the centre disc; fractional while a drill animates.
    public let ring: Double
    public let startAngle: Double
    public let endAngle: Double
    public let innerRadius: Double
    public let outerRadius: Double
    /// The folded small children of one parent ("N smaller items"): drawn translucent, not drillable.
    public let isAggregate: Bool
    public let count: Int

    public var midAngle: Double { (startAngle + endAngle) / 2 }
    public var midRadius: Double { (innerRadius + outerRadius) / 2 }
    public var thickness: Double { outerRadius - innerRadius }
}

/// How a label sits on an arc: its centre point and its rotation (radians, clockwise), along the ring (`tangential`)
/// or across it (`radial`), always turned so it never reads upside down.
public struct SunburstLabelPlacement: Equatable, Sendable {
    public enum Direction: Sendable { case tangential, radial }
    public let center: CGPoint
    public let rotation: Double
    public let direction: Direction
}

/// The pure geometry of a sunburst: which arcs a viewport shows, where a point lands, and where a label fits.
public struct SunburstLayout: Sendable {
    public let partition: ChartPartition
    /// Rings drawn around the centre disc.
    public let maxDepth: Int
    /// An arc narrower than this (radians) is folded into its parent's "smaller items" arc. On an inner ring the
    /// floor is higher: an arc keeps at least about 2.5 points of its inner edge.
    public let minAngle: Double
    /// The centre disc's radius as a fraction of the outer radius.
    public let centerFraction: Double
    /// A parent shows at most this many children as their own arcs; the smaller rest fold, however wide they are.
    public let maxChildren: Int

    public init(
        partition: ChartPartition, maxDepth: Int = 4, minAngle: Double = 0.012, centerFraction: Double = 0.26,
        maxChildren: Int = 14
    ) {
        self.partition = partition
        self.maxDepth = max(1, maxDepth)
        self.minAngle = max(0, minAngle)
        self.centerFraction = min(0.8, max(0.05, centerFraction))
        self.maxChildren = max(1, maxChildren)
    }

    public enum Hit: Equatable, Sendable {
        case center
        case arc(SunburstArc)
        case none
    }

    /// Radii for a chart of outer radius `radius`.
    public func centerRadius(_ radius: Double) -> Double { radius * centerFraction }
    public func ringThickness(_ radius: Double) -> Double { (radius - centerRadius(radius)) / Double(maxDepth) }

    /// The arcs visible through `viewport` for a chart of outer radius `radius`, outer rings last.
    public func arcs(_ viewport: SunburstViewport, radius: Double) -> [SunburstArc] {
        guard !partition.isEmpty, viewport.x1 > viewport.x0, radius > 0 else { return [] }
        let r0 = centerRadius(radius)
        let thickness = ringThickness(radius)
        let window = viewport.x1 - viewport.x0
        let fullCircle = 2 * Double.pi
        var result: [SunburstArc] = []

        func angle(_ x: Double) -> Double { min(fullCircle, max(0, (x - viewport.x0) / window * fullCircle)) }

        func radii(_ ring: Double) -> (Double, Double) {
            let inner = r0 + max(0, ring - 1) * thickness
            let outer = r0 + min(Double(maxDepth), ring) * thickness
            return (inner, outer)
        }

        /// The narrowest arc a ring draws on its own: `minAngle`, or wider where the one-point gaps would erase it
        /// (an arc must keep about 2.5 points of its inner edge, or it is all gap and still takes hover and clicks).
        func narrowest(innerRadius: Double) -> Double { max(minAngle, 2.5 / max(innerRadius, 1)) }

        func visit(_ position: Int) {
            let item = partition.items[position]
            // Folded children are gathered in runs of neighbours. A run ends at a child drawn on its own, so a fold
            // never spans (and covers) the arcs between two runs; mid-drill, children clipped at both ends of the
            // window are two runs.
            var foldStart = Double.infinity
            var foldEnd = -Double.infinity
            var foldValue = 0.0
            var foldCount = 0
            var runs = 0

            func flushFold() {
                defer {
                    foldStart = .infinity
                    foldEnd = -.infinity
                    foldValue = 0
                    foldCount = 0
                }
                guard foldCount > 0 else { return }
                let ring = Double(item.depth + 1) - viewport.depth
                let (inner, outer) = radii(ring)
                guard foldEnd - foldStart >= minAngle * 0.5, ring > 0, outer > inner + 0.25 else { return }
                runs += 1
                result.append(SunburstArc(
                    item: position, id: runs == 1 ? "\(item.id)#smaller" : "\(item.id)#smaller-\(runs)",
                    name: Plural.count(foldCount, "smaller item"), value: foldValue, ring: ring, startAngle: foldStart,
                    endAngle: foldEnd, innerRadius: inner, outerRadius: outer, isAggregate: true, count: foldCount))
            }

            for (rank, child) in item.children.enumerated() {
                let node = partition.items[child]
                let a0 = angle(node.x0)
                let a1 = angle(node.x1)
                guard a1 > a0 else { continue }
                let ring = Double(node.depth) - viewport.depth
                if ring <= 0 {
                    // An ancestor of the focus, or the focus itself: not drawn, but its children may be.
                    visit(child)
                    continue
                }
                if ring > Double(maxDepth) + 0.999 { continue }
                let (inner, outer) = radii(ring)
                if a1 - a0 < narrowest(innerRadius: inner) || rank >= maxChildren {
                    foldStart = min(foldStart, a0)
                    foldEnd = max(foldEnd, a1)
                    foldValue += node.value
                    foldCount += 1
                    continue
                }
                flushFold()
                // A band still too thin to draw (the old centre shrinking away at the end of a drill) is skipped, but
                // its children are not: they are the rings that matter at that moment.
                if outer > inner + 0.25 {
                    result.append(SunburstArc(
                        item: child, id: node.id, name: node.name, value: node.value, ring: ring, startAngle: a0,
                        endAngle: a1, innerRadius: inner, outerRadius: outer, isAggregate: false, count: 1))
                }
                if ring < Double(maxDepth) { visit(child) }
            }
            flushFold()
        }

        visit(0)
        return result.sorted { $0.ring < $1.ring }
    }

    /// What lies under `point` (relative to the chart's centre, y down) among `arcs`.
    public func hit(_ point: CGPoint, radius: Double, arcs: [SunburstArc]) -> Hit {
        let distance = (Double(point.x) * Double(point.x) + Double(point.y) * Double(point.y)).squareRoot()
        if distance <= centerRadius(radius) { return .center }
        if distance > radius { return .none }
        let angle = Self.angle(of: point)
        for arc in arcs where distance >= arc.innerRadius && distance < arc.outerRadius {
            if angle >= arc.startAngle && angle < arc.endAngle { return .arc(arc) }
        }
        return .none
    }

    /// Radians clockwise from twelve o'clock for a point relative to the centre (y down), in 0..<2π.
    public static func angle(of point: CGPoint) -> Double {
        var angle = atan2(Double(point.x), -Double(point.y))
        if angle < 0 { angle += 2 * Double.pi }
        return angle
    }

    /// The point at `angle` (clockwise from twelve o'clock) and `radius` from the centre, y down.
    public static func point(angle: Double, radius: Double) -> CGPoint {
        CGPoint(x: sin(angle) * radius, y: -cos(angle) * radius)
    }

    /// Where a label of `size` sits on `arc`, or nil when it fits neither along nor across the ring. `padding` is the
    /// room kept free at each end.
    public static func labelPlacement(_ arc: SunburstArc, size: CGSize, padding: Double = 4) -> SunburstLabelPlacement? {
        let width = Double(size.width)
        let height = Double(size.height)
        let mid = arc.midAngle
        let center = point(angle: mid, radius: arc.midRadius)
        // Along the ring: straight text whose lower edge sits at `base` fits when the chord there is longer than it.
        let span = arc.endAngle - arc.startAngle
        let base = max(0, arc.midRadius - height / 2)
        let along = span >= Double.pi ? Double.infinity : 2 * base * sin(span / 2)
        if arc.thickness >= height + padding, along >= width + 2 * padding {
            var rotation = mid
            if mid > Double.pi / 2, mid < 3 * Double.pi / 2 { rotation -= Double.pi }
            return SunburstLabelPlacement(center: center, rotation: rotation, direction: .tangential)
        }
        // Across the ring: needs the ring's depth for the text and the arc's width for its height.
        if arc.thickness >= width + 2 * padding, span * arc.innerRadius >= height + padding {
            var rotation = mid - Double.pi / 2
            if mid > Double.pi { rotation += Double.pi }
            return SunburstLabelPlacement(center: center, rotation: rotation, direction: .radial)
        }
        return nil
    }
}
