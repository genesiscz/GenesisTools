import AppKit
import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit
@testable import GenesisKitCharts

/// A made-up disk: every number is invented.
enum ChartFixtures {
    static let gb = 1_000_000_000.0

    static var disk: ChartNode {
        func leaf(_ id: String, _ name: String, _ gigabytes: Double, muted: Bool = false) -> ChartNode {
            ChartNode(id: id, name: name, value: gigabytes * gb, muted: muted)
        }
        let projects = ChartNode(id: "/Users/alice/Projects", name: "Projects", value: 0, children: [
            leaf("/Users/alice/Projects/atlas", "atlas", 61),
            leaf("/Users/alice/Projects/beacon", "beacon", 34),
            leaf("/Users/alice/Projects/comet", "comet", 18),
            leaf("/Users/alice/Projects/drift", "drift", 7),
        ] + (0..<30).map { leaf("/Users/alice/Projects/tiny\($0)", "tiny\($0)", 0.08) })
        let library = ChartNode(id: "/Users/alice/Library", name: "Library", value: 0, children: [
            leaf("/Users/alice/Library/Caches", "Caches", 42),
            leaf("/Users/alice/Library/Containers", "Containers", 38),
            leaf("/Users/alice/Library/Developer", "Developer", 55),
        ])
        let alice = ChartNode(id: "/Users/alice", name: "alice", value: 0, children: [
            projects, library, leaf("/Users/alice/Movies", "Movies", 44), leaf("/Users/alice/Downloads", "Downloads", 21),
        ])
        return ChartNode(id: "/", name: "Macintosh HD", value: 0, children: [
            ChartNode(id: "/Users", name: "Users", value: 0, children: [alice]),
            leaf("/Applications", "Applications", 88),
            leaf("/System", "System", 34),
            leaf("/Library", "Library", 26),
            leaf("/private", "Unaccounted", 12, muted: true),
        ])
    }
}

@MainActor
final class KitChartsTests: XCTestCase {
    func testDonutDataChangesClearInvalidHoverAndNotifyOnce() {
        let kept = DonutSegment(id: "kept", value: 10, color: .blue, label: "Kept")
        let hoveredSlice = DonutSegment(id: "hovered", value: 20, color: .red, label: "Hovered")
        var hovered: String? = hoveredSlice.id
        var reported: [String?] = []
        DonutLayout.reconcileHover(&hovered, in: [kept, hoveredSlice]) { reported.append($0) }
        XCTAssertEqual(hovered, hoveredSlice.id)
        XCTAssertTrue(reported.isEmpty)
        // Rendering must ignore stale focus before the data-change callback updates stored hover.
        XCTAssertNil(DonutLayout.drawableID(hovered, in: [kept]))
        DonutLayout.reconcileHover(&hovered, in: [kept]) { reported.append($0) }
        XCTAssertNil(hovered)
        XCTAssertEqual(reported.count, 1)
        XCTAssertNil(reported[0])
        DonutLayout.reconcileHover(&hovered, in: [kept]) { reported.append($0) }
        XCTAssertEqual(reported.count, 1)
        for value in [0.0, -1, Double.nan, Double.infinity] {
            hovered = hoveredSlice.id
            let invalid = DonutSegment(id: hoveredSlice.id, value: value, color: .red, label: "No arc")
            XCTAssertNil(DonutLayout.drawableID(hovered, in: [kept, invalid]))
            DonutLayout.reconcileHover(&hovered, in: [kept, invalid]) { reported.append($0) }
            XCTAssertNil(hovered, "a retained ID without a drawable arc is not a hover")
        }
        XCTAssertEqual(reported.count, 5)
    }

    func testDonutAccessibilityAndCenterExcludeNonFiniteSegments() {
        let values: [Double] = [.infinity, .nan, -.infinity, -1, 0, 25, 75]
        let segments = values.enumerated().map {
            DonutSegment(id: "\($0.offset)", value: $0.element, color: .blue, label: "Slice")
        }
        let visible = DonutLayout.visibleSegments(segments)
        XCTAssertEqual(visible.map(\.value), [25, 75])
        let total = DonutLayout.total(segments)
        XCTAssertEqual(total, 100)
        XCTAssertEqual(visible.map { Int(($0.value / total * 100).rounded()) }, [25, 75])
        XCTAssertEqual(DonutLayout.arcs(values, gap: 0).map(\.index), [5, 6])
    }

    // MARK: Squarified layout

    private func randomValues(_ count: Int, seed: UInt64) -> [Double] {
        var state = seed
        return (0..<count).map { _ in
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double((state >> 33) % 1000 + 1)
        }
    }

    func testSquarifiedAreasAreProportionalToTheValuesWithinOnePercent() {
        let rect = CGRect(x: 10, y: 20, width: 640, height: 400)
        for seed in 1...6 {
            let values = randomValues(37, seed: UInt64(seed))
            let rects = SquarifiedLayout.layout(values, in: rect)
            let total = values.reduce(0, +)
            for (value, frame) in zip(values, rects) {
                let frame = try? XCTUnwrap(frame)
                let area = Double((frame?.width ?? 0) * (frame?.height ?? 0))
                let expected = value / total * Double(rect.width * rect.height)
                XCTAssertEqual(area, expected, accuracy: expected * 0.01, "seed \(seed)")
            }
        }
    }

    func testSquarifiedRectanglesTileTheSpaceWithoutOverlap() {
        let rect = CGRect(x: 0, y: 0, width: 500, height: 300)
        let rects = SquarifiedLayout.layout(randomValues(25, seed: 9), in: rect).compactMap { $0 }
        let area = rects.reduce(0.0) { $0 + Double($1.width * $1.height) }
        XCTAssertEqual(area, 150_000, accuracy: 1)
        for frame in rects {
            XCTAssertTrue(rect.insetBy(dx: -0.001, dy: -0.001).contains(frame), "\(frame) leaves the space")
        }
        for (i, a) in rects.enumerated() {
            for b in rects[(i + 1)...] {
                let overlap = a.intersection(b)
                XCTAssertTrue(overlap.isNull || overlap.width * overlap.height < 0.01, "\(a) overlaps \(b)")
            }
        }
    }

    func testSquarifiedRectanglesStayNearlySquare() {
        let rect = CGRect(x: 0, y: 0, width: 600, height: 400)
        // Equal values in a 3:2 space: six squares-ish cells.
        let equal = SquarifiedLayout.layout(Array(repeating: 1, count: 6), in: rect).compactMap { $0 }
        XCTAssertLessThan(equal.map(SquarifiedLayout.aspect).max() ?? 9, 1.6)
        // The paper's example: 6, 6, 4, 3, 2, 2, 1 in a 6×4 space.
        let paper = SquarifiedLayout.layout([6, 6, 4, 3, 2, 2, 1], in: CGRect(x: 0, y: 0, width: 6, height: 4))
            .compactMap { $0 }
        XCTAssertLessThan(paper.map(SquarifiedLayout.aspect).max() ?? 9, 3.0)
        // Random values: a slice-and-dice layout would give long slivers; squarified keeps the mean low.
        let random = SquarifiedLayout.layout(randomValues(60, seed: 4), in: rect).compactMap { $0 }
        let mean = random.map(SquarifiedLayout.aspect).reduce(0, +) / Double(random.count)
        XCTAssertLessThan(mean, 2.0, "mean aspect \(mean)")
    }

    func testSquarifiedLayoutIsDeterministicAndPutsTheLargestFirst() {
        let values = [3.0, 9, 3, 1, 5]
        let a = SquarifiedLayout.layout(values, in: CGRect(x: 0, y: 0, width: 300, height: 200))
        let b = SquarifiedLayout.layout(values, in: CGRect(x: 0, y: 0, width: 300, height: 200))
        XCTAssertEqual(a, b)
        XCTAssertEqual(a[1]?.origin, .zero, "the largest value takes the top-left corner")
        // Equal values keep their input order: the first 3 sits before the second.
        let first = try? XCTUnwrap(a[0])
        let second = try? XCTUnwrap(a[2])
        XCTAssertTrue((first?.minY ?? 0) < (second?.minY ?? 0) || (first?.minX ?? 0) < (second?.minX ?? 0))
    }

    func testZeroNegativeAndInvalidValuesTakeNoRoom() {
        let rects = SquarifiedLayout.layout([0, -4, 5, .nan, 5, .infinity], in: CGRect(x: 0, y: 0, width: 100, height: 50))
        XCTAssertNil(rects[0])
        XCTAssertNil(rects[1])
        XCTAssertNil(rects[3])
        XCTAssertNil(rects[5])
        XCTAssertEqual(Double((rects[2]?.width ?? 0) * (rects[2]?.height ?? 0)), 2500, accuracy: 0.5)
        XCTAssertEqual(SquarifiedLayout.layout([], in: .zero), [])
        XCTAssertEqual(SquarifiedLayout.layout([1, 2], in: .zero), [nil, nil])
    }

    func testTreemapCellsFoldChildrenTooSmallToSeeAndKeepTheParentsOwnSpace() throws {
        let partition = ChartPartition(root: ChartFixtures.disk)
        let projects = try XCTUnwrap(partition.position(of: "/Users/alice/Projects"))
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 200)
        let cells = TreemapLayout.cells(partition, focus: projects, in: bounds, levels: 1)
        let folded = cells.filter { $0.folded > 0 }
        XCTAssertEqual(folded.count, 1)
        XCTAssertEqual(folded.first?.folded, 30)
        XCTAssertEqual(folded.first?.foldedValue ?? 0, 2.4 * ChartFixtures.gb, accuracy: 1_000)
        XCTAssertEqual(cells.filter(\.isNode).map { partition.items[$0.item].name }, ["atlas", "beacon", "comet", "drift"])
        let area = cells.reduce(0.0) { $0 + Double($1.rect.width * $1.rect.height) }
        XCTAssertEqual(area, 60_000, accuracy: 1, "the cells tile the bounds")
        // A parent bigger than its children keeps the rest as its own grey cell.
        let own = ChartNode(id: "r", name: "r", value: 10, children: [ChartNode(id: "a", name: "a", value: 6)])
        let ownCells = TreemapLayout.cells(ChartPartition(root: own), focus: 0, in: bounds)
        XCTAssertEqual(ownCells.filter(\.isRemainder).count, 1)
        let remainder = try XCTUnwrap(ownCells.first(where: \.isRemainder))
        XCTAssertEqual(Double(remainder.rect.width * remainder.rect.height), 24_000, accuracy: 1)
    }

    func testEveryIntermediateDrillViewportDrawsTheChildren() throws {
        // At the very end of a drill the old centre's band is too thin to draw; its children must still be drawn.
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 3)
        let users = layout.partition.items[try XCTUnwrap(layout.partition.position(of: "/Users"))]
        // The last steps matter: there the old centre's band is a fraction of a point thick.
        for t in (0...20).map({ Double($0) / 20 }) + [0.99, 0.995, 0.999, 0.9999] {
            let viewport = SunburstViewport(x0: 0, x1: 1 + (users.x1 - 1) * t, depth: t)
            let arcs = layout.arcs(viewport, radius: 150)
            XCTAssertTrue(arcs.contains { $0.name == "alice" || $0.name == "Library" }, "t = \(t)")
        }
    }

    // MARK: Partition

    func testThePartitionSizesNodesByTheirChildrenAndOrdersThemLargestFirst() throws {
        let partition = ChartPartition(root: ChartFixtures.disk)
        let root = try XCTUnwrap(partition.items.first)
        XCTAssertEqual(root.value, 482.4 * ChartFixtures.gb, accuracy: 1_000, "the root is its children's sum")
        XCTAssertEqual(root.x0, 0)
        XCTAssertEqual(root.x1, 1, accuracy: 1e-12)
        let names = root.children.map { partition.items[$0].name }
        XCTAssertEqual(names, ["Users", "Applications", "System", "Library", "Unaccounted"])
        let users = partition.items[root.children[0]]
        XCTAssertEqual(users.branch, 0)
        XCTAssertEqual(partition.items[root.children[1]].branch, 1)
        let developer = try XCTUnwrap(partition.position(of: "/Users/alice/Library/Developer"))
        XCTAssertEqual(partition.items[developer].branch, 0, "a deep node keeps its top-level branch")
        XCTAssertEqual(partition.items[developer].depth, 4)
        XCTAssertEqual(partition.ancestors(of: developer).map { partition.items[$0].name }, ["Macintosh HD", "Users", "alice", "Library"])
        let atlas = try XCTUnwrap(partition.position(of: "/Users/alice/Projects/atlas"))
        XCTAssertEqual(partition.items[partition.commonAncestor(developer, atlas)].name, "alice")
    }

    func testAnEmptyOrZeroTreeHasNoItems() {
        XCTAssertTrue(ChartPartition(root: ChartNode(id: "r", name: "r", value: 0)).isEmpty)
        let partition = ChartPartition(root: ChartNode(id: "r", name: "r", value: 10, children: [
            ChartNode(id: "a", name: "a", value: 0), ChartNode(id: "b", name: "b", value: -3),
        ]))
        XCTAssertEqual(partition.items.count, 1)
        XCTAssertEqual(partition.items[0].children, [])
    }

    // MARK: Sunburst

    func testTheFirstRingSpansTheWholeCircleWhenTheChildrenFillTheRoot() {
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 3)
        let arcs = layout.arcs(SunburstViewport(layout.partition.items[0]), radius: 200)
        let first = arcs.filter { $0.ring == 1 }
        XCTAssertEqual(first.first?.name, "Users")
        XCTAssertEqual(first.first?.startAngle ?? 1, 0, accuracy: 1e-9, "the largest child starts at twelve o'clock")
        let sweep = first.reduce(0) { $0 + $1.endAngle - $1.startAngle }
        XCTAssertEqual(sweep, 2 * Double.pi, accuracy: 1e-6)
        XCTAssertEqual(first.first?.innerRadius ?? 0, 52, accuracy: 1e-9, "the centre disc is 26 % of the radius")
        XCTAssertTrue(arcs.allSatisfy { $0.ring <= 3 })
    }

    func testThinArcsFoldIntoOneSmallerItemsArcPerParent() throws {
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 4, minAngle: 0.012)
        let projects = try XCTUnwrap(layout.partition.position(of: "/Users/alice/Projects"))
        let arcs = layout.arcs(SunburstViewport(layout.partition.items[projects]), radius: 200)
        let folded = arcs.filter(\.isAggregate)
        XCTAssertEqual(folded.count, 1)
        XCTAssertEqual(folded.first?.count, 30)
        XCTAssertEqual(folded.first?.name, "30 smaller items")
        XCTAssertFalse(arcs.contains { $0.name.hasPrefix("tiny") }, "a folded item is never drawn alone")
    }

    func testAParentShowsAtMostMaxChildrenArcsAndFoldsTheRest() throws {
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 2, maxChildren: 2)
        let projects = try XCTUnwrap(layout.partition.position(of: "/Users/alice/Projects"))
        let arcs = layout.arcs(SunburstViewport(layout.partition.items[projects]), radius: 200)
        XCTAssertEqual(arcs.filter { !$0.isAggregate }.map(\.name), ["atlas", "beacon"])
        XCTAssertEqual(arcs.first(where: \.isAggregate)?.count, 32, "comet, drift and the 30 tiny ones fold together")
    }

    func testAHostColourReplacesTheBranchHue() throws {
        let orange = ChartColor(red: 0.94, green: 0.54, blue: 0.29)
        let tree = ChartNode(id: "r", name: "r", value: 0, children: [
            ChartNode(id: "a", name: "a", value: 3, color: orange), ChartNode(id: "b", name: "b", value: 1),
        ])
        let partition = ChartPartition(root: tree)
        XCTAssertEqual(partition.items[1].color, orange)
        let shade = try XCTUnwrap(ChartPalette.shade(branch: 0, sibling: 4, ring: 1, muted: false, color: orange).usingColorSpace(.sRGB))
        XCTAssertEqual(shade.redComponent, 0.94 * 0.92, accuracy: 0.03, "only the depth rule touches a host colour")
        XCTAssertNil(partition.items[2].color)
    }

    func testDrillingMakesTheFocusTheCentreAndItsChildrenTheWholeRing() throws {
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 3)
        let library = try XCTUnwrap(layout.partition.position(of: "/Users/alice/Library"))
        let arcs = layout.arcs(SunburstViewport(layout.partition.items[library]), radius: 100)
        XCTAssertEqual(arcs.map(\.name), ["Developer", "Caches", "Containers"])
        XCTAssertEqual(arcs.reduce(0) { $0 + $1.endAngle - $1.startAngle }, 2 * Double.pi, accuracy: 1e-6)
        XCTAssertTrue(arcs.allSatisfy { $0.ring == 1 })
    }

    func testAHalfwayViewportDrawsTheChildrenGrowingIntoPlace() throws {
        // The drill transition: halfway from the root to "Users", the Users arc already covers more than its share.
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 3)
        let users = layout.partition.items[try XCTUnwrap(layout.partition.position(of: "/Users"))]
        let half = SunburstViewport(x0: users.x0 / 2, x1: (1 + users.x1) / 2, depth: 0.5)
        let arcs = layout.arcs(half, radius: 100)
        let alice = try XCTUnwrap(arcs.first { $0.name == "alice" })
        XCTAssertEqual(alice.ring, 1.5, accuracy: 1e-9)
        XCTAssertGreaterThan(alice.endAngle - alice.startAngle, (users.x1 - users.x0) * 2 * Double.pi)
    }

    func testHitTestingFindsTheCentreTheArcAndNothing() throws {
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 3)
        let arcs = layout.arcs(SunburstViewport(layout.partition.items[0]), radius: 200)
        XCTAssertEqual(layout.hit(CGPoint(x: 5, y: -5), radius: 200, arcs: arcs), .center)
        XCTAssertEqual(layout.hit(CGPoint(x: 300, y: 0), radius: 200, arcs: arcs), .none)
        // Just right of twelve o'clock in the first ring: the largest child.
        guard case .arc(let arc) = layout.hit(CGPoint(x: 3, y: -70), radius: 200, arcs: arcs) else {
            return XCTFail("no arc under the point")
        }
        XCTAssertEqual(arc.name, "Users")
        XCTAssertEqual(SunburstLayout.angle(of: CGPoint(x: 0, y: -1)), 0, accuracy: 1e-9)
        XCTAssertEqual(SunburstLayout.angle(of: CGPoint(x: 1, y: 0)), Double.pi / 2, accuracy: 1e-9)
        XCTAssertEqual(SunburstLayout.angle(of: CGPoint(x: -1, y: 0)), 3 * Double.pi / 2, accuracy: 1e-9)
    }

    func testLabelsSitAlongWideArcsAcrossDeepNarrowOnesAndNowhereElse() {
        func arc(_ start: Double, _ end: Double, inner: Double, outer: Double) -> SunburstArc {
            SunburstArc(item: 0, id: "x", name: "x", value: 1, ring: 1, startAngle: start, endAngle: end,
                        innerRadius: inner, outerRadius: outer, isAggregate: false, count: 1)
        }
        let label = CGSize(width: 40, height: 12)
        let wide = SunburstLayout.labelPlacement(arc(0, 1.2, inner: 80, outer: 110), size: label)
        XCTAssertEqual(wide?.direction, .tangential)
        XCTAssertEqual(wide?.rotation ?? 9, 0.6, accuracy: 1e-9)
        let bottom = SunburstLayout.labelPlacement(arc(2.8, 3.6, inner: 80, outer: 110), size: label)
        XCTAssertEqual(bottom?.direction, .tangential)
        XCTAssertEqual(bottom?.rotation ?? 9, 3.2 - Double.pi, accuracy: 1e-9, "the bottom half is turned upright")
        let narrow = SunburstLayout.labelPlacement(arc(0, 0.2, inner: 80, outer: 140), size: label)
        XCTAssertEqual(narrow?.direction, .radial)
        XCTAssertNil(SunburstLayout.labelPlacement(arc(0, 0.05, inner: 80, outer: 100), size: label))
    }

    // MARK: Donut, sparkline, ramp

    func testDonutSlicesKeepTheirShareAndAGapBetweenNeighbours() {
        let arcs = DonutLayout.arcs([3, 0, 1, -2], gap: 0.04)
        XCTAssertEqual(arcs.map(\.index), [0, 2])
        let sweeps = arcs.map { $0.endAngle - $0.startAngle }
        XCTAssertEqual(sweeps[0] / sweeps[1], 3, accuracy: 1e-9)
        XCTAssertEqual(arcs[1].startAngle - arcs[0].endAngle, 0.04, accuracy: 1e-9)
        XCTAssertEqual(DonutLayout.arcs([5], gap: 0.1), [DonutLayout.Arc(index: 0, startAngle: 0, endAngle: 2 * Double.pi)])
        XCTAssertEqual(DonutLayout.arcs([0, 0], gap: 0.1), [])
        XCTAssertEqual(DonutLayout.hit(CGPoint(x: 5, y: -50), arcs: arcs, inner: 40, outer: 60), 0)
        XCTAssertNil(DonutLayout.hit(CGPoint(x: 0.5, y: -50), arcs: arcs, inner: 40, outer: 60), "the gap at twelve o'clock")
        XCTAssertNil(DonutLayout.hit(CGPoint(x: 1, y: -10), arcs: arcs, inner: 40, outer: 60))
    }

    func testSparklinePointsSpanTheFrameAndMarkTheExtremes() {
        let points = SparklinePath.points([2, 8, 5], range: nil, in: CGRect(x: 0, y: 0, width: 100, height: 50))
        XCTAssertEqual(points.map(\.x), [0, 50, 100])
        XCTAssertEqual(points[0].y, 50, "the lowest value sits on the bottom edge")
        XCTAssertEqual(points[1].y, 0, "the highest value sits on the top edge")
        let flat = SparklinePath.points([4, 4], range: nil, in: CGRect(x: 0, y: 0, width: 10, height: 10))
        XCTAssertEqual(flat[0].y, 5, "equal values draw a line through the middle")
        XCTAssertEqual(SparklinePath.points([7], range: 0...10, in: CGRect(x: 0, y: 0, width: 10, height: 10)).count, 2)
        XCTAssertTrue(SparklinePath.points([], range: nil, in: .zero).isEmpty)
        let extrema = Sparkline.extrema([3, 1, 9, 1, 9])
        XCTAssertEqual(extrema?.min, 1)
        XCTAssertEqual(extrema?.max, 4)
        // FocusSparkline still draws counts from zero to the peak.
        let focus = FocusSparkline(samples: [0, 5, 10]).path(in: CGRect(x: 0, y: 0, width: 20, height: 10))
        XCTAssertEqual(focus.boundingRect, CGRect(x: 0, y: 0, width: 20, height: 10))
    }

    func testLabelInkMeetsContrastOnMediumAndCategoricalFills() throws {
        let greys = (0...100).map { step in
            let value = Double(step) / 100
            return NSColor(srgbRed: value, green: value, blue: value, alpha: 1)
        }
        let hues = ChartPalette.components.map { NSColor(srgbRed: $0.0, green: $0.1, blue: $0.2, alpha: 1) }
        for fill in greys + hues {
            let ink = try XCTUnwrap(NSColor(ChartPalette.ink(on: fill)).usingColorSpace(.sRGB))
            let alpha = ink.alphaComponent
            let composed = NSColor(srgbRed: ink.redComponent * alpha + fill.redComponent * (1 - alpha),
                                   green: ink.greenComponent * alpha + fill.greenComponent * (1 - alpha),
                                   blue: ink.blueComponent * alpha + fill.blueComponent * (1 - alpha), alpha: 1)
            let foreground = ChartPalette.luminance(composed)
            let background = ChartPalette.luminance(fill)
            let contrast = (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
            XCTAssertGreaterThanOrEqual(contrast, 4.5, "fill \(fill)")
        }
        let middle = NSColor(srgbRed: 0.58, green: 0.58, blue: 0.58, alpha: 1)
        XCTAssertEqual(ChartPalette.ink(on: middle), Color.black.opacity(0.82))
    }

    func testTheHealthRampRunsFromRedThroughAmberToGreen() throws {
        let red = try XCTUnwrap(ChartPalette.rampColor(0).usingColorSpace(.sRGB))
        let amber = try XCTUnwrap(ChartPalette.rampColor(0.45).usingColorSpace(.sRGB))
        let green = try XCTUnwrap(ChartPalette.rampColor(1).usingColorSpace(.sRGB))
        XCTAssertGreaterThan(red.redComponent, red.greenComponent + 0.3)
        XCTAssertGreaterThan(amber.redComponent, 0.8)
        XCTAssertGreaterThan(amber.greenComponent, 0.6)
        XCTAssertGreaterThan(green.greenComponent, green.redComponent + 0.3)
        XCTAssertEqual(ChartPalette.ink(on: NSColor(srgbRed: 0.95, green: 0.8, blue: 0.3, alpha: 1)), Color.black.opacity(0.82))
        XCTAssertEqual(ChartPalette.ink(on: NSColor(srgbRed: 0.2, green: 0.3, blue: 0.6, alpha: 1)), Color.white.opacity(0.95))
    }

    // MARK: Pictures

    private func hue(_ rep: NSBitmapImageRep, at point: CGPoint, width: CGFloat) -> (hue: CGFloat, saturation: CGFloat, brightness: CGFloat) {
        guard let color = KitShots.color(rep, at: point, viewWidth: width) else { return (0, 0, 0) }
        return (color.hueComponent, color.saturationComponent, color.brightnessComponent)
    }

    func testTheSunburstDrawsClockwiseFromTwelveWithTheFirstBranchInBlue() throws {
        let size = CGSize(width: 420, height: 420)
        let view = SunburstChart(root: ChartFixtures.disk, focus: .constant(nil), maxDepth: 4,
                                 valueText: { ByteFormat.file(Int64($0)) })
            .padding(10).background(Color(white: 0.09))
        let rep = try KitShots.render(view, size: size, name: "chart-sunburst")
        // Ring 1 just right of twelve o'clock: "Users", branch 0, blue.
        let ring1 = hue(rep, at: CGPoint(x: 214, y: 210 - 70), width: size.width)
        XCTAssertGreaterThan(ring1.saturation, 0.3)
        XCTAssertEqual(ring1.hue, 0.61, accuracy: 0.06, "Users is drawn in the first hue (blue)")
        // Ring 1 in the middle of Applications' angles (two thirds round, clockwise after Users): the teal branch.
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 4)
        let apps = try XCTUnwrap(layout.arcs(SunburstViewport(layout.partition.items[0]), radius: 198)
            .first { $0.name == "Applications" })
        XCTAssertGreaterThan(apps.midAngle, Double.pi, "Applications sits on the left half, after Users")
        let applications = SunburstLayout.point(angle: apps.midAngle, radius: 70)
        let teal = hue(rep, at: CGPoint(x: 210 + applications.x, y: 210 + applications.y), width: size.width)
        XCTAssertEqual(teal.hue, 0.48, accuracy: 0.06, "Applications follows clockwise in teal")
        // The centre disc, above its text, is a dark neutral grey.
        let disc = hue(rep, at: CGPoint(x: 210, y: 172), width: size.width)
        XCTAssertLessThan(disc.saturation, 0.1)
        XCTAssertLessThan(disc.brightness, 0.3)
    }

    func testADrilledSunburstShowsTheFocusInTheCentre() throws {
        let size = CGSize(width: 360, height: 360)
        let view = SunburstChart(root: ChartFixtures.disk, focus: .constant("/Users/alice/Projects"), maxDepth: 3,
                                 valueText: { ByteFormat.file(Int64($0)) })
            .background(Color(white: 0.09))
        let rep = try KitShots.render(view, size: size, name: "chart-sunburst-drilled")
        // The whole first ring is the Users branch now (blue family), wherever it is sampled.
        var coloured = 0
        for angle in stride(from: 0.2, to: 6.0, by: 0.9) {
            let point = SunburstLayout.point(angle: angle, radius: 62)
            let sample = hue(rep, at: CGPoint(x: 180 + point.x, y: 180 + point.y), width: size.width)
            if sample.saturation > 0.2 {
                coloured += 1
                XCTAssertEqual(sample.hue, 0.61, accuracy: 0.09, "angle \(angle)")
            }
        }
        XCTAssertGreaterThanOrEqual(coloured, 5, "the ring is drawn: \(coloured) of 7 samples hit an arc")
    }

    func testTheTreemapPutsTheLargestBranchTopLeft() throws {
        let size = CGSize(width: 520, height: 340)
        let view = TreemapView(root: ChartFixtures.disk, focus: .constant(nil), valueText: { ByteFormat.file(Int64($0)) })
            .background(Color(white: 0.09))
        let rep = try KitShots.render(view, size: size, name: "chart-treemap")
        let corner = hue(rep, at: CGPoint(x: 60, y: 150), width: size.width)
        XCTAssertGreaterThan(corner.saturation, 0.25)
        XCTAssertEqual(corner.hue, 0.61, accuracy: 0.07, "Users (blue) takes the top-left of the map")
        let drilled = TreemapView(root: ChartFixtures.disk, focus: .constant("/Users/alice"), valueText: { ByteFormat.file(Int64($0)) })
            .background(Color(white: 0.09))
        let inside = try KitShots.render(drilled, size: size, name: "chart-treemap-drilled")
        var filled = 0
        for y in stride(from: 10, to: Int(size.height), by: 40) {
            for x in stride(from: 10, to: Int(size.width), by: 40) where hue(inside, at: CGPoint(x: x, y: y), width: size.width).saturation > 0.2 {
                filled += 1
            }
        }
        XCTAssertGreaterThan(filled, 60, "alice's children fill the drilled map (\(filled) of 117 samples coloured)")
    }

    func testTheSmallChartsDraw() throws {
        let segments = [
            DonutSegment(id: "apps", value: 120, color: ChartPalette.color(0), label: "Apps"),
            DonutSegment(id: "media", value: 80, color: ChartPalette.color(2), label: "Media"),
            DonutSegment(id: "purgeable", value: 30, color: ChartPalette.color(4), label: "Purgeable"),
            DonutSegment(id: "free", value: 40, color: ChartPalette.muted, label: "Free"),
        ]
        let gallery = VStack(spacing: 22) {
            HStack(spacing: 28) {
                RingGauge(progress: 0.62, tint: ChartPalette.color(1), lineWidth: 10, label: "Used") {
                    Text("62%").font(.system(size: 20, weight: .semibold, design: .rounded))
                }
                .frame(width: 120, height: 120)
                SegmentedDonut(segments: segments, title: "Disk", valueText: { "\(Int($0)) GB" })
                    .frame(width: 150, height: 150)
            }
            HealthBar(value: 0.98, threshold: 0.4) { IconButton(systemName: "questionmark.circle", tooltip: "What is health?") {} }
            HealthBar(value: 0.45, threshold: 0.4)
            HealthBar(value: 0.12, threshold: 0.4)
            Sparkline(values: [12, 14, 13, 18, 22, 19, 25, 31, 28, 35], tint: ChartPalette.color(7), fill: true, showsExtrema: true)
                .frame(height: 44)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NativeThemePalette.graphiteBase)
        .environment(\.colorScheme, .dark)
        let size = CGSize(width: 460, height: 420)
        let rep = try KitShots.render(gallery, size: size, name: "chart-small")
        XCTAssertGreaterThan(KitShots.brightness(rep, in: CGRect(x: 24, y: 200, width: 400, height: 120), viewWidth: size.width), 0.06)
        // The gauge alone: its arc at three o'clock is tinted; at nine o'clock (past 62 %) only the track shows.
        let gauge = RingGauge(progress: 0.62, tint: ChartPalette.color(1), lineWidth: 10).background(Color.black)
        let gaugeRep = try KitShots.render(gauge, size: CGSize(width: 140, height: 140), name: "chart-gauge")
        let right = hue(gaugeRep, at: CGPoint(x: 135, y: 70), width: 140)
        let left = hue(gaugeRep, at: CGPoint(x: 5, y: 70), width: 140)
        XCTAssertGreaterThan(right.saturation, 0.3, "the arc passes three o'clock")
        XCTAssertLessThan(left.saturation, 0.15, "nine o'clock is only track at 62 %")
    }

    /// A strip of the drill transition, for a person to look at.
    func testSunburstDrillTransitionStrip() throws {
        guard let folder = KitShots.folder else { throw XCTSkip("pictures only when GENESISKIT_SHOTS names a folder") }
        final class Box: ObservableObject { @Published var focus: String? }
        struct Host: View {
            @ObservedObject var box: Box
            var body: some View {
                SunburstChart(root: ChartFixtures.disk, focus: $box.focus, maxDepth: 3, valueText: { ByteFormat.file(Int64($0)) })
                    .background(Color(white: 0.09))
            }
        }
        let box = Box()
        let (window, host) = HostedShot.host(Host(box: box), size: CGSize(width: 300, height: 300))
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        box.focus = "/Users"
        var frames: [NSBitmapImageRep] = []
        let start = Date()
        for ms in [0, 120, 240, 360, 480, 700] {
            RunLoop.main.run(until: start.addingTimeInterval(Double(ms) / 1000))
            frames.append(try XCTUnwrap(HostedShot.bitmap(host)))
        }
        try HostedShot.writeStrip(frames, to: folder.appendingPathComponent("chart-sunburst-drill-strip.png"))
    }
}

// MARK: Review fixes (2026-10-13)

extension KitChartsTests {
    func testThePartitionIsBuiltInOnePassAndComparesByValue() {
        let first = ChartPartition(root: ChartFixtures.disk)
        let second = ChartPartition(root: ChartFixtures.disk)
        XCTAssertEqual(first, second)
        // A folder of value 0 with children is kept at its children's sum.
        let projects = first.items[first.position(of: "/Users/alice/Projects")!]
        XCTAssertEqual(projects.value, (61 + 34 + 18 + 7 + 30 * 0.08) * ChartFixtures.gb, accuracy: 1)
        XCTAssertEqual(first.items[0].value, 482.4 * ChartFixtures.gb, accuracy: 1)
        // Deep chain: 2,000 levels build without the old per-level re-summing.
        var node = ChartNode(id: "leaf", name: "leaf", value: 1)
        for level in 0..<2_000 { node = ChartNode(id: "n\(level)", name: "n", value: 0, children: [node]) }
        let deep = ChartPartition(root: node)
        XCTAssertEqual(deep.items.count, 2_001)
        XCTAssertEqual(deep.items.last?.value, 1)
    }

    func testAnArcTooThinForItsGapsFolds() {
        // 0.02 rad clears minAngle (0.012) but at an inner radius of 26 pt is 0.5 pt wide: all gap.
        let thin = 0.02 / (2 * Double.pi)
        let root = ChartNode(id: "r", name: "r", value: 0, children: [
            ChartNode(id: "big", name: "big", value: 1 - thin),
            ChartNode(id: "thin", name: "thin", value: thin),
        ])
        let layout = SunburstLayout(partition: ChartPartition(root: root), maxDepth: 1)
        let arcs = layout.arcs(SunburstViewport(layout.partition.items[0]), radius: 100)
        XCTAssertNil(arcs.first { $0.id == "thin" }, "a sliver the gaps would erase takes no hover")
        XCTAssertNotNil(arcs.first { $0.isAggregate })
        // On a wide chart the same share is a real arc on an outer ring.
        let deep = ChartNode(id: "r", name: "r", value: 0, children: [ChartNode(id: "p", name: "p", value: 0, children: root.children)])
        let wide = SunburstLayout(partition: ChartPartition(root: deep), maxDepth: 2, centerFraction: 0.6)
        XCTAssertNotNil(wide.arcs(SunburstViewport(wide.partition.items[0]), radius: 400).first { $0.id == "thin" })
    }

    func testFoldsNeverSpanTheArcsBetweenThem() {
        // Mid-drill, the window clips children at both ends: two folded runs, never one aggregate over the middle.
        let layout = SunburstLayout(partition: ChartPartition(root: ChartFixtures.disk), maxDepth: 4)
        let projects = layout.partition.items[layout.partition.position(of: "/Users/alice/Projects")!]
        let atlas = layout.partition.items[layout.partition.position(of: "/Users/alice/Projects/atlas")!]
        let viewport = SunburstViewport(x0: atlas.x1 - atlas.span * 0.001, x1: projects.x1, depth: Double(projects.depth))
        let arcs = layout.arcs(viewport, radius: 200)
        for aggregate in arcs where aggregate.isAggregate {
            for arc in arcs where !arc.isAggregate && arc.ring == aggregate.ring {
                let inside = arc.startAngle >= aggregate.startAngle && arc.endAngle <= aggregate.endAngle
                XCTAssertFalse(inside, "\(aggregate.id) covers \(arc.name)")
            }
        }
        XCTAssertEqual(Set(arcs.map(\.id)).count, arcs.count, "fold ids stay unique")
    }

    func testTreemapCellsKeepTheirKeyWhenNewDataShiftsTheTree() throws {
        let before = ChartPartition(root: ChartFixtures.disk)
        var children = ChartFixtures.disk.children
        children.insert(ChartNode(id: "/Volumes", name: "Volumes", value: 300 * ChartFixtures.gb), at: 0)
        let after = ChartPartition(root: ChartNode(id: "/", name: "Macintosh HD", value: 0, children: children))
        let bounds = CGRect(x: 0, y: 0, width: 600, height: 400)
        let old = TreemapLayout.cells(before, focus: 0, in: bounds)
        let new = TreemapLayout.cells(after, focus: 0, in: bounds)
        let apps = try XCTUnwrap(old.first { before.items[$0.item].id == "/Applications" })
        let moved = try XCTUnwrap(new.first { after.items[$0.item].id == "/Applications" })
        XCTAssertNotEqual(apps.item, moved.item, "the item index shifted")
        XCTAssertEqual(TreemapCanvas.key(of: apps, in: before), TreemapCanvas.key(of: moved, in: after), "the hover key did not")
    }

    func testAStaleDonutSelectionDimsNothing() throws {
        let segments = [
            DonutSegment(id: "apps", value: 120, color: ChartPalette.color(0), label: "Apps"),
            DonutSegment(id: "free", value: 40, color: ChartPalette.color(2), label: "Free"),
        ]
        let size = CGSize(width: 200, height: 200)
        let plain = try KitShots.render(
            SegmentedDonut(segments: segments, title: "Disk", valueText: { "\(Int($0))" }).background(Color.black),
            size: size, name: "donut-plain")
        let stale = try KitShots.render(
            SegmentedDonut(segments: segments, selection: .constant("gone"), title: "Disk", valueText: { "\(Int($0))" })
                .background(Color.black),
            size: size, name: "donut-stale")
        let band = CGRect(x: 0, y: 0, width: 200, height: 40)
        XCTAssertEqual(
            KitShots.brightness(stale, in: band, viewWidth: size.width),
            KitShots.brightness(plain, in: band, viewWidth: size.width), accuracy: 0.01)
    }

    func testAHealthBarWithNothingMeasuredShowsAnEmptyTrack() throws {
        let size = CGSize(width: 360, height: 40)
        let empty = try KitShots.render(
            HealthBar(value: nil as Double?).padding(.horizontal, 8).background(Color(white: 0.09)), size: size,
            name: "healthbar-empty")
        let full = try KitShots.render(
            HealthBar(value: 0.9).padding(.horizontal, 8).background(Color(white: 0.09)), size: size, name: "healthbar-full")
        func colouredPixels(_ rep: NSBitmapImageRep) -> Int {
            var count = 0
            for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
                for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
                    guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                    if c.saturationComponent > 0.25, c.brightnessComponent > 0.35 { count += 1 }
                }
            }
            return count
        }
        XCTAssertGreaterThan(colouredPixels(full), 100, "the measured bar is filled in its colour")
        XCTAssertEqual(colouredPixels(empty), 0, "nothing measured: no colour at all")
        // The dash at the right end: a light grey stroke.
        var brightest: CGFloat = 0
        let scale = CGFloat(empty.pixelsWide) / size.width
        for y in Int(10 * scale)..<Int(30 * scale) {
            for x in Int(320 * scale)..<Int(356 * scale) {
                brightest = max(brightest, empty.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)?.brightnessComponent ?? 0)
            }
        }
        XCTAssertGreaterThan(brightest, 0.4, "the dash is drawn")
    }

    func testTheSparklineReadsLargeValuesWithoutExponents() {
        let summary = Sparkline.summary([1.2e9, 4.5e9, 3.1e9])
        XCTAssertFalse(summary.contains("e+"), summary)
        XCTAssertTrue(summary.contains("B"), "compact: \(summary)")
        XCTAssertEqual(Sparkline.summary([1, 2.5], valueText: { "\(Int($0)) GB" }), "Latest 2 GB, lowest 1 GB, highest 2 GB")
        XCTAssertEqual(Sparkline.summary([.nan]), "No data")
    }
}
