import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The file tree's text size (Views/MarkdownTreeFont.swift): the largest size at which every name fits
/// whole, between a floor and what the sidebar's width alone asks for.
final class MarkdownTreeFontFitTests: XCTestCase {
    /// A font-free measure: every character is half an em wide, at every size.
    private let steady = MarkdownTreeMeasure(advance: { 0.5 * Double($0.count) }, tracking: { _ in 0 })
    /// The same, set tighter as the text grows, the way the system font is.
    private let tightening = MarkdownTreeMeasure(advance: { 0.5 * Double($0.count) }, tracking: { -0.004 * ($0 - 13) })

    private typealias Item = (name: String, depth: Int)

    private let mixed: [Item] = [
        ("README.md", 0), ("Archive", 0), ("2026-10-13 daily note about the plan.md", 1),
        ("PlaywrightCheck-2026-10-13.md", 2), ("a.md", 3), ("MarkdownFileTreeView.swift", 4),
    ]

    private func demand(_ items: [Item], _ measure: MarkdownTreeMeasure) -> MarkdownTreeDemand {
        let rows = items.map { FileTreeRow(id: "/root/\($0.name)", name: $0.name, isFolder: false, depth: $0.depth) }
        return MarkdownTreeDemand(lines: rows.map { MarkdownTreeDemand.Line(row: $0) }, measure: measure)
    }

    private func fitted(
        _ items: [Item], width: Double, base: Double = 13, reserve: Double = 0, measure: MarkdownTreeMeasure? = nil
    ) -> Double {
        let measure = measure ?? steady
        return MarkdownTreeFont.size(
            base: base, width: width, scales: true, demand: demand(items, measure), reserve: reserve
        )
    }

    /// A row's width worked out from the real metrics at that size, not from the fit's own arithmetic.
    private func rowWidth(_ item: Item, at size: Double, _ measure: MarkdownTreeMeasure) -> Double {
        let metrics = FileTreeMetrics.scaled(toText: CGFloat(size))
        let chrome = 2 * FileTreeMetrics.rowInset + CGFloat(item.depth) * metrics.indent
            + metrics.chevronWidth + metrics.iconWidth + 3 * metrics.spacing
        let characters = Double(item.name.count)
        return Double(chrome) + size * (measure.advance(item.name) + characters * measure.tracking(size))
    }

    private func fits(_ item: Item, at size: Double, width: Double, reserve: Double = 0, _ measure: MarkdownTreeMeasure) -> Bool {
        rowWidth(item, at: size, measure) + MarkdownTreeFont.slack <= width - reserve
    }

    func testLongNamesShrinkTheTextToTheMinimumAndNoFurther() {
        let long: [Item] = [(String(repeating: "x", count: 120) + ".md", 0)]
        XCTAssertEqual(fitted(long, width: MarkdownSidebarWidth.standard), MarkdownTreeFont.minimum)
        XCTAssertEqual(fitted(long, width: MarkdownSidebarWidth.minimum), MarkdownTreeFont.minimum)
        XCTAssertEqual(fitted(long, width: MarkdownSidebarWidth.maximum), MarkdownTreeFont.minimum, "too long even at the widest sidebar")
    }

    func testTheTextShrinksBelowTheConfiguredSizeWhenTheNamesDoNotFit() {
        // The screenshot: a standard sidebar, a name longer than the room at 13 pt.
        let size = fitted([("PlaywrightCheck-2026-10-13.md", 0)], width: MarkdownSidebarWidth.standard)
        XCTAssertLessThan(size, 13)
        XCTAssertGreaterThan(size, MarkdownTreeFont.minimum)
    }

    func testShortNamesReachTheCeilingAtAWideSidebarAndNoHigher() {
        let short: [Item] = [("a.md", 0), ("b", 1)]
        for width in [MarkdownSidebarWidth.standard, 300, 410, MarkdownSidebarWidth.maximum] {
            XCTAssertEqual(
                fitted(short, width: width),
                MarkdownTreeFont.size(base: 13, width: width, scales: true),
                "short names get the ceiling at \(width)"
            )
        }
        XCTAssertEqual(fitted(short, width: MarkdownSidebarWidth.standard), 13)
        XCTAssertEqual(fitted(short, width: MarkdownSidebarWidth.maximum), 17, "four points over the base is the most")
    }

    func testTheTextIsTheLargestQuarterPointAtWhichEveryNameFits() {
        for measure in [steady, tightening] {
            for width in stride(from: MarkdownSidebarWidth.minimum, through: MarkdownSidebarWidth.maximum, by: 5) {
                let size = fitted(mixed, width: width, measure: measure)
                let ceiling = MarkdownTreeFont.size(base: 13, width: width, scales: true)
                XCTAssertGreaterThanOrEqual(size, MarkdownTreeFont.minimum)
                XCTAssertLessThanOrEqual(size, ceiling)
                XCTAssertEqual(size * 4, (size * 4).rounded(), "a quarter point")
                if size > MarkdownTreeFont.minimum {
                    XCTAssertTrue(mixed.allSatisfy { fits($0, at: size, width: width, measure) }, "every name fits at \(size) in \(width)")
                }
                if size < ceiling {
                    XCTAssertFalse(mixed.allSatisfy { fits($0, at: size + 0.25, width: width, measure) }, "a quarter point more would cut a name in \(width)")
                }
            }
        }
    }

    func testADeeperRowNeedsASmallerSizeThanTheSameNameAtTheTop() {
        let name = String(repeating: "n", count: 36) + ".md"
        let top = fitted([(name, 0)], width: 330)
        let deep = fitted([(name, 4)], width: 330)
        XCTAssertLessThan(deep, top)
        XCTAssertGreaterThan(deep, MarkdownTreeFont.minimum, "the comparison is not a tie at the floor")
        XCTAssertLessThan(top, MarkdownTreeFont.size(base: 13, width: 330, scales: true), "nor at the ceiling")
        // The deepest row sets the size of the whole list.
        XCTAssertEqual(fitted([(name, 0), (name, 4), ("a.md", 0)], width: 330), deep)
    }

    func testWideningNeverMakesANameThatFitStopFitting() {
        for measure in [steady, tightening] {
            var previous = fitted(mixed, width: MarkdownSidebarWidth.minimum, measure: measure)
            var width = MarkdownSidebarWidth.minimum
            while width < MarkdownSidebarWidth.maximum {
                let next = fitted(mixed, width: width + 1, measure: measure)
                XCTAssertGreaterThanOrEqual(next, previous, "the text never shrinks while the sidebar widens, at \(width)")
                for item in mixed where fits(item, at: previous, width: width, measure) {
                    XCTAssertTrue(fits(item, at: next, width: width + 1, measure), "\(item.name) fit at \(width) and stopped fitting at \(width + 1)")
                }
                previous = next
                width += 1
            }
        }
    }

    func testTheOffSwitchReturnsTheBaseAndNeverBuildsTheDemand() {
        var built = 0
        func build() -> MarkdownTreeDemand {
            built += 1
            return demand([(String(repeating: "x", count: 120), 0)], steady)
        }
        XCTAssertEqual(MarkdownTreeFont.size(base: 12.3, width: 560, scales: false, demand: build()), 12.3)
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: 160, scales: false, demand: build(), reserve: 15), 13)
        XCTAssertEqual(built, 0)
    }

    func testAScrollerTakesItsWidthOffTheNames() {
        var narrower = false
        for width in stride(from: MarkdownSidebarWidth.minimum, through: MarkdownSidebarWidth.maximum, by: 5) {
            let plain = fitted(mixed, width: width)
            let withScroller = fitted(mixed, width: width, reserve: 15)
            XCTAssertLessThanOrEqual(withScroller, plain)
            narrower = narrower || withScroller < plain
            if withScroller > MarkdownTreeFont.minimum {
                XCTAssertTrue(mixed.allSatisfy { fits($0, at: withScroller, width: width, reserve: 15, steady) })
            }
        }
        XCTAssertTrue(narrower, "15 points of scroller costs some size somewhere")
    }

    func testABaseUnderTheMinimumIsKeptAndAnEmptyListGetsTheCeiling() {
        let long: [Item] = [(String(repeating: "x", count: 120), 0)]
        XCTAssertEqual(fitted(long, width: MarkdownSidebarWidth.standard, base: 9), 9, "the user asked for less than the floor")
        XCTAssertEqual(fitted([], width: MarkdownSidebarWidth.maximum), 17)
    }

    func testTheCacheMeasuresAListOnceAndEachNameOnce() {
        var measured: [String] = []
        let counting = MarkdownTreeMeasure(
            advance: { measured.append($0); return 0.5 * Double($0.count) },
            tracking: { _ in 0 }
        )
        let fit = MarkdownTreeFit<FileTreeRow>()
        let rows = (0..<50).map { FileTreeRow(id: "/r/\($0)", name: "note-\($0 % 10).md", isFolder: false, depth: 0) }
        var builds = 0
        let line: (FileTreeRow) -> MarkdownTreeDemand.Line = { builds += 1; return .init(row: $0) }

        let first = fit.demand(for: rows, measure: counting, line: line)
        XCTAssertEqual(builds, 50)
        XCTAssertEqual(Set(measured).count, 10)
        XCTAssertEqual(measured.count, 50, "one advance per line when a list is built")

        // A divider drag asks again at every frame: the same list is not measured again.
        for _ in 0..<100 {
            XCTAssertTrue(fit.demand(for: rows, measure: counting, line: line) === first)
        }
        XCTAssertEqual(builds, 50)
        XCTAssertEqual(measured.count, 50)

        // A folder opened: the list changed, so it is read again.
        let more = rows + [FileTreeRow(id: "/r/new", name: "new.md", isFolder: false, depth: 1)]
        XCTAssertFalse(fit.demand(for: more, measure: counting, line: line) === first)
        XCTAssertEqual(builds, 101)
    }
}

/// The system font's widths: the model the fit rests on, against the font and against SwiftUI.
@MainActor
final class MarkdownTreeFontMeasureTests: XCTestCase {
    private let names = [
        "PlaywrightCheck-2026-10-13.md", "README.md", "Archive", "MarkdownFileTreeView.swift", "iiiiiiiiii",
        "WWWWWWWWWW", "2026-10-13 daily note about the plan.md", "Úvodní plán čeština.md",
    ]
    /// Up to 17 pt, the default ceiling (13 plus four), the model is exact. From 20 pt the system switches to
    /// its display face, which is a little narrower, so the model reads a little too wide there: safe.
    private let sizes: [Double] = [10.5, 11.25, 13, 14.75, 17]
    private let displaySizes: [Double] = [21, 24]

    private func fontWidth(_ name: String, at size: Double) -> Double {
        Double((name as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold)]).width)
    }

    private func modelWidth(_ name: String, at size: Double) -> Double {
        let measure = MarkdownTreeMeasure.system
        return size * (measure.advance(name) + Double(name.count) * measure.tracking(size))
    }

    func testTheModelReadsTheFontsWidthAtEverySize() {
        for name in names {
            for size in sizes {
                XCTAssertEqual(modelWidth(name, at: size), fontWidth(name, at: size), accuracy: 0.25, "\(name) at \(size)")
            }
            for size in displaySizes {
                XCTAssertGreaterThanOrEqual(modelWidth(name, at: size), fontWidth(name, at: size) - 0.25, "\(name) at \(size) would be cut")
            }
        }
    }

    /// Why the tracking is in the model: a name measured at 100 pt and scaled down reads far too narrow.
    func testScalingALargeMeasurementReadsTheNameTooNarrow() {
        let name = "PlaywrightCheck-2026-10-13.md"
        let scaled = fontWidth(name, at: 100) / 100 * 10.5
        XCTAssertLessThan(scaled, fontWidth(name, at: 10.5) * 0.95)
    }

    func testSwiftUIDrawsANameNoWiderThanTheModelPlusTheSlack() {
        for name in names {
            for size in sizes + displaySizes {
                let host = NSHostingView(rootView: Text(name).font(.system(size: size, weight: .semibold)).lineLimit(1).fixedSize())
                let drawn = Double(host.fittingSize.width)
                let model = modelWidth(name, at: size)
                XCTAssertLessThanOrEqual(drawn, model + MarkdownTreeFont.slack, "\(name) at \(size) is cut")
                if size <= sizes.max() ?? 0 {
                    XCTAssertGreaterThanOrEqual(drawn, model - 0.5, "\(name) at \(size) loses room")
                }
            }
        }
    }

    /// The fit's chrome (two insets, indent, chevron, icon and three gaps) against the real row.
    func testARowsWidthIsItsChromePlusItsName() {
        let tree = FileTreeModel(root: FileManager.default.temporaryDirectory)
        let actions = FileTreeActions(open: { _ in }, setRoot: { _ in }, changed: { _ in })
        for depth in [0, 3] {
            for size in [10.5, 13.0, 16.0] {
                let name = "2026-10-13 daily note about the plan.md"
                let style = FileTreeStyle(
                    text: .primary, secondary: .secondary, muted: .secondary, accent: .accentColor, selection: .clear,
                    font: { .system(size: size, weight: $0 ? .semibold : .regular) },
                    metrics: .scaled(toText: CGFloat(size))
                )
                let row = FileTreeRow(id: "/root/\(name)", name: name, isFolder: false, depth: depth)
                let host = NSHostingView(rootView: FileTreeRowView(
                    row: row, selected: true, icon: "doc.text", style: style, model: tree, actions: actions
                ))
                let drawn = Double(host.fittingSize.width)

                let line = MarkdownTreeDemand.Line(row: row)
                let model = 2 * Double(FileTreeMetrics.rowInset) + size * line.layout + modelWidth(name, at: size)
                // SwiftUI rounds the text up to a whole point, and may round the scaled gaps too.
                XCTAssertLessThanOrEqual(drawn, model + MarkdownTreeFont.slack, "depth \(depth) at \(size) is cut")
                XCTAssertGreaterThanOrEqual(drawn, model - 0.5, "depth \(depth) at \(size) loses room")
            }
        }
    }

    func testTheSizeChosenForARealListKeepsEveryNameWhole() {
        let rows = names.enumerated().map { FileTreeRow(id: "/root/\($0.element)", name: $0.element, isFolder: false, depth: $0.offset % 3) }
        let demand = MarkdownTreeDemand(lines: rows.map { MarkdownTreeDemand.Line(row: $0) })
        for width in [MarkdownSidebarWidth.minimum, 200, MarkdownSidebarWidth.standard, 300, 420] {
            let size = MarkdownTreeFont.size(base: 13, width: width, scales: true, demand: demand)
            guard size > MarkdownTreeFont.minimum else { continue }
            for row in rows {
                let drawn = NSHostingView(rootView: Text(row.name).font(.system(size: size, weight: .semibold)).lineLimit(1).fixedSize())
                let metrics = FileTreeMetrics.scaled(toText: CGFloat(size))
                let rowWidth = 2 * Double(FileTreeMetrics.rowInset) + Double(metrics.widthBesidesName(depth: row.depth)) + Double(drawn.fittingSize.width)
                XCTAssertLessThanOrEqual(rowWidth, width, "\(row.name) is cut at \(size) pt in \(width)")
            }
        }
    }
}
