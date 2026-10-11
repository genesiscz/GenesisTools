import Combine
import SwiftUI
import XCTest

@testable import GenesisKit

/// Fitted panels grow and shrink with what opens inside them: the height they ask for, how the window changes
/// (once, never per frame), and the one motion family every expand and collapse uses.
final class FittedPanelGeometryTests: XCTestCase {
    func testAFittedPanelIsAsTallAsItsContentBetweenItsMinimumAndMaximum() {
        XCTAssertEqual(WidgetClusterGeometry.fittedHeight(measured: 491, minimum: 320, maximum: 900), 491)
        XCTAssertEqual(WidgetClusterGeometry.fittedHeight(measured: 120, minimum: 320, maximum: 900), 320,
            "A nearly empty inbox still reads as a panel")
        XCTAssertEqual(WidgetClusterGeometry.fittedHeight(measured: 2400, minimum: 320, maximum: 900), 900,
            "Only content beyond the maximum scrolls")
        XCTAssertEqual(WidgetClusterGeometry.fittedHeight(measured: nil, minimum: 320, maximum: 900), 900,
            "Before the first measurement the panel takes its maximum")
        XCTAssertEqual(WidgetClusterGeometry.fittedHeight(measured: 500, minimum: 320, maximum: 280), 280,
            "A display too short for the minimum gets what it has")
    }

    func testTheMaximumIsTheScreenLessItsMarginsAndNeverAboveTheOldFixedCeiling() {
        // A 1440 pt display: the old fixed detail size was 875 pt; the cap is its 900 pt ceiling.
        XCTAssertEqual(WidgetClusterGeometry.maximumContentHeight(visible: CGSize(width: 2560, height: 1415)), 900)
        // A laptop: the old 62 % rule stopped at 580 pt; the panel may now use the screen less 18 pt above and below.
        XCTAssertEqual(WidgetClusterGeometry.maximumContentHeight(visible: CGSize(width: 1470, height: 919)), 883)
        XCTAssertGreaterThan(
            WidgetClusterGeometry.maximumContentHeight(visible: CGSize(width: 1470, height: 919)),
            WidgetClusterGeometry.detailSize(visible: CGSize(width: 1470, height: 919)).height)
        XCTAssertEqual(WidgetClusterGeometry.maximumContentHeight(visible: CGSize(width: 800, height: 20)), 0)
    }

    func testAGrowingReshapeTakesItsWindowAtTheStartAndKeepsTheContentWhereItWas() {
        // A side panel centred on its rail grows by 200 pt, 100 pt up and 100 pt down.
        let from = CGRect(x: 1000, y: 400, width: 520, height: 491)
        let to = CGRect(x: 1000, y: 300, width: 520, height: 691)
        let plan = EdgePanelGeometry.reshape(from: from, to: to, window: from)
        XCTAssertEqual(plan.window, to)
        XCTAssertTrue(plan.resizesAtStart)
        XCTAssertFalse(plan.resizesAtEnd, "Growing needs one resize, at the start")
        XCTAssertTrue(plan.growing)
        XCTAssertEqual(plan.startContent, CGRect(x: 0, y: 100, width: 520, height: 491),
            "In the larger window the content starts exactly where it was on screen")
        XCTAssertEqual(plan.endContent, CGRect(x: 0, y: 0, width: 520, height: 691))
    }

    func testAShrinkingReshapeKeepsItsWindowUntilTheEnd() {
        // A top panel closes a card: it shrinks from the bottom, its top edge stays at the bezel.
        let from = CGRect(x: 800, y: 500, width: 560, height: 700)
        let to = CGRect(x: 800, y: 709, width: 560, height: 491)
        let plan = EdgePanelGeometry.reshape(from: from, to: to, window: from)
        XCTAssertEqual(plan.window, from)
        XCTAssertFalse(plan.resizesAtStart)
        XCTAssertTrue(plan.resizesAtEnd, "Shrinking needs one resize, at the end")
        XCTAssertFalse(plan.growing)
        XCTAssertEqual(plan.startContent, CGRect(x: 0, y: 0, width: 560, height: 700))
        XCTAssertEqual(plan.endContent, CGRect(x: 0, y: 0, width: 560, height: 491),
            "The top edge does not move; the bottom edge rises")
    }

    func testAReshapeThatMovesAsWellAsGrowsRunsInTheUnionOfBothFrames() {
        // A side panel clamped at the bottom of the screen: the shorter target sits lower than the old outline.
        let from = CGRect(x: 1000, y: 300, width: 520, height: 500)
        let to = CGRect(x: 1000, y: 200, width: 520, height: 450)
        let plan = EdgePanelGeometry.reshape(from: from, to: to, window: from)
        XCTAssertEqual(plan.window, from.union(to))
        XCTAssertTrue(plan.resizesAtStart)
        XCTAssertTrue(plan.resizesAtEnd)
        XCTAssertEqual(plan.startContent, EdgePanelGeometry.localRect(from, in: plan.window))
        XCTAssertEqual(plan.endContent, EdgePanelGeometry.localRect(to, in: plan.window))
    }

    func testOneMotionFamilyOpensSlowerThanItClosesAndStaysUnderThreeHundredMilliseconds() {
        XCTAssertLessThan(GenMotion.expandDuration, 0.3)
        XCTAssertLessThan(GenMotion.collapseDuration, GenMotion.expandDuration, "Closing gets out of the way")
        XCTAssertLessThan(GenMotion.removalFadeDuration, GenMotion.collapseDuration,
            "Closed content is gone before the rows below reach it")
        for value in [GenMotion.curve.1, GenMotion.curve.3] {
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThanOrEqual(value, 1, "No overshoot")
        }
        XCTAssertEqual(EdgePanelGeometry.motion(to: .expanded, shrinking: false).curve.0, GenMotion.curve.0,
            "The panels open on the same curve as the disclosures inside them")
    }

    func testReduceMotionMakesEveryExpansionInstant() {
        XCTAssertNil(GenMotion.animation(expanding: true, reduceMotion: true))
        XCTAssertNil(GenMotion.animation(expanding: false, reduceMotion: true))
        XCTAssertNotNil(GenMotion.animation(expanding: true, reduceMotion: false))
    }

    @MainActor
    func testADisclosureTellsEveryFittedContainerAroundIt() {
        let outer = GenExpansionHost()
        let inner = GenExpansionHost()
        var heard: [String] = []
        outer.action = { heard.append("outer \($0)") }
        inner.action = { heard.append("inner \($0)") }
        inner.parent = outer
        inner.willChange(true)
        inner.willChange(false)
        XCTAssertEqual(heard, ["inner true", "outer true", "inner false", "outer false"])
    }
}

@MainActor
final class EdgePanelReshapeTests: XCTestCase {
    private func controller(expanded: CGSize) throws -> EdgePanelController<Color> {
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        let value = EdgePanelController(
            placement: .right, screen: screen, compactSize: CGSize(width: 40, height: 100),
            expandedSize: expanded, title: "Hidden reshape test") { Color.black }
        value.panel.alphaValue = 0
        value.panel.level = NSWindow.Level(rawValue: -1000)
        return value
    }

    private func resizes(of panel: NSPanel, during body: () async throws -> Void) async rethrows -> [CGRect] {
        var frames: [CGRect] = []
        let observer = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification, object: panel, queue: .main
        ) { _ in MainActor.assumeIsolated { frames.append(panel.frame) } }
        defer { NotificationCenter.default.removeObserver(observer) }
        try await body()
        return frames
    }

    private func waitForCompletion(_ value: EdgePanelController<Color>, height: CGFloat) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while (value.lastTransitionTiming?.outcome != "completed" || value.panel.frame.height != height
            || value.motion.contentFrame != nil), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    func testOpeningSomethingInsideGrowsTheWindowOnceAndTheContentRidesTheOutline() async throws {
        let value = try controller(expanded: CGSize(width: 340, height: 400))
        defer { value.hide(); value.panel.close() }
        value.setSideCenterY(500)
        value.setPresentation(.expanded, reduceMotion: true)
        value.show()
        let before = value.panel.frame
        var placed: [CGRect?] = []
        let subscription = value.motion.$contentFrame.dropFirst().sink { placed.append($0) }
        defer { subscription.cancel() }
        let frames = try await resizes(of: value.panel) {
            value.setExpandedSize(CGSize(width: 340, height: 600))
            value.setPresentation(.expanded, reduceMotion: false)
            XCTAssertEqual(value.panel.frame.height, 600, "The window takes its larger size at the start")
            XCTAssertEqual(value.motion.presentation, .expanded, "The same content stays")
            XCTAssertLessThan(value.visibleFrame.height, 600, "The outline grows; it does not jump")
            try await waitForCompletion(value, height: 600)
        }
        XCTAssertEqual(placed, [
            CGRect(x: 0, y: 100, width: 340, height: 400),
            CGRect(x: 0, y: 0, width: 340, height: 600),
            nil,
        ], "The content starts where it was on screen, rides the outline to the window's edges, then fills it")
        XCTAssertEqual(frames.count, 1, "One resize for the whole motion, never one per frame")
        XCTAssertNil(value.motion.contentFrame, "Settled, the content fills the window again")
        XCTAssertEqual(value.panel.frame.midY, before.midY, accuracy: 0.5)
        XCTAssertEqual(value.visibleFrame, value.panel.frame)
    }

    func testClosingSomethingInsideKeepsTheWindowUntilTheOutlineIsSmall() async throws {
        let value = try controller(expanded: CGSize(width: 340, height: 600))
        defer { value.hide(); value.panel.close() }
        value.setSideCenterY(500)
        value.setPresentation(.expanded, reduceMotion: true)
        value.show()
        let frames = try await resizes(of: value.panel) {
            value.setExpandedSize(CGSize(width: 340, height: 400))
            value.setPresentation(.expanded, reduceMotion: false)
            XCTAssertEqual(value.panel.frame.height, 600, "The window keeps its size while the outline shrinks")
            let end = try XCTUnwrap(value.motion.contentFrame)
            XCTAssertEqual(end.height, 400, "The content heads for the smaller outline")
            XCTAssertEqual(end.minY, 100, accuracy: 0.5)
            try await waitForCompletion(value, height: 400)
        }
        XCTAssertEqual(frames.count, 1, "One resize, at the end")
        XCTAssertEqual(value.panel.frame.height, 400)
        XCTAssertNil(value.motion.contentFrame)
    }

    func testReduceMotionReshapesAtOnceWithoutAMovingContentFrame() throws {
        let value = try controller(expanded: CGSize(width: 340, height: 400))
        defer { value.hide(); value.panel.close() }
        value.setPresentation(.expanded, reduceMotion: true)
        value.show()
        value.setExpandedSize(CGSize(width: 340, height: 600))
        value.setPresentation(.expanded, reduceMotion: true)
        XCTAssertEqual(value.panel.frame.height, 600)
        XCTAssertNil(value.motion.contentFrame)
        XCTAssertNil(value.lastTransitionTiming, "No motion ran")
    }

    func testAnInterruptedReshapeEndsAtItsLatestSize() async throws {
        let value = try controller(expanded: CGSize(width: 340, height: 400))
        defer { value.hide(); value.panel.close() }
        value.setSideCenterY(500)
        value.setPresentation(.expanded, reduceMotion: true)
        value.show()
        value.setExpandedSize(CGSize(width: 340, height: 650))
        value.setPresentation(.expanded, reduceMotion: false)
        try await Task.sleep(for: .milliseconds(60))
        value.setExpandedSize(CGSize(width: 340, height: 450))
        value.setPresentation(.expanded, reduceMotion: false)
        XCTAssertEqual(value.lastTransitionTiming?.outcome, "interrupted")
        try await waitForCompletion(value, height: 450)
        XCTAssertEqual(value.panel.frame.height, 450)
        XCTAssertNil(value.motion.contentFrame)
        XCTAssertEqual(value.panel.frame.maxX, try XCTUnwrap(NSScreen.screens.first).frame.maxX, accuracy: 0.5)
    }
}
