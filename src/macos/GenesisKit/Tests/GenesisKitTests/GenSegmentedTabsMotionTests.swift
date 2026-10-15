import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The selection pill of `GenSegmentedTabs` slides to the new segment and takes its width on the GenMotion curve,
/// one pill the whole way (no fade between two), and moves at once under Reduce Motion. Read from pictures of a
/// hosted window that is never ordered front: the pill is a SwiftUI shape, not a view with a frame to ask.
@MainActor
final class GenSegmentedTabsMotionTests: XCTestCase {
    final class Box: ObservableObject {
        @Published var selection = "inbox"
    }

    struct Tabs: View {
        @ObservedObject var box: Box

        var body: some View {
            GenSegmentedTabs("View", items: [.init("inbox", "Inbox"), .init("sessions", "Sessions"), .init("conversation", "Conversation")],
                             selection: $box.selection)
        }
    }

    /// The tabs at (10, 10) on a dark panel: the track's 2 pt padding, then 24 pt segments.
    static let origin = CGPoint(x: 10, y: 10)
    static let size = CGSize(width: 420, height: 48)
    /// A row 3 pt into the segments: above the text, inside the pill's straight top edge.
    static let row: CGFloat = origin.y + 2 + 3

    private func host(_ box: Box, reduceMotion: Bool) -> (NSWindow, NSView) {
        HostedShot.host(
            Tabs(box: box)
                .padding(.leading, Self.origin.x)
                .padding(.top, Self.origin.y)
                .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
                .background(Color(white: 0.11))
                .environment(\.colorScheme, .dark)
                .environment(\.widgetReduceMotion, reduceMotion),
            size: Self.size)
    }

    /// The runs of pill colour along the row, in points: every column that differs clearly from the track.
    private func pill(_ view: NSView) throws -> [ClosedRange<CGFloat>] {
        let rep = try XCTUnwrap(HostedShot.bitmap(view))
        let scale = CGFloat(rep.pixelsWide) / rep.size.width
        let y = Int(Self.row * scale)
        func color(_ x: Int) -> (CGFloat, CGFloat, CGFloat) {
            guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return (0, 0, 0) }
            return (c.redComponent, c.greenComponent, c.blueComponent)
        }
        // Inside the track's left padding, beside the first segment.
        let track = color(Int((Self.origin.x + 1) * scale))
        var runs: [ClosedRange<CGFloat>] = []
        var start: Int?
        let last = Int((Self.size.width - 1) * scale)
        for x in Int(Self.origin.x * scale)...last {
            let c = color(x)
            let differs = abs(c.0 - track.0) + abs(c.1 - track.1) + abs(c.2 - track.2) > 0.25
            if differs, start == nil { start = x }
            if !differs || x == last, let begin = start {
                runs.append(CGFloat(begin) / scale...CGFloat(differs ? x : x - 1) / scale)
                start = nil
            }
        }
        return runs
    }

    private func sample(_ box: Box, reduceMotion: Bool) throws -> (before: ClosedRange<CGFloat>, frames: [[ClosedRange<CGFloat>]]) {
        let (window, view) = host(box, reduceMotion: reduceMotion)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let before = try XCTUnwrap(try pill(view).first, "no pill on Inbox")
        box.selection = "conversation"
        let start = Date()
        var frames: [[ClosedRange<CGFloat>]] = []
        while Date().timeIntervalSince(start) < 0.5 {
            RunLoop.main.run(until: Date().addingTimeInterval(1.0 / 60))
            frames.append(try pill(view))
        }
        return (before, frames)
    }

    /// An empty identifier used to be written for a nil one, which replaces an identifier set outside the control.
    func testTabsOmitAnEmptyAccessibilityIdentifier() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GenesisKit/Controls/GenSegmentedTabs.swift"), encoding: .utf8)
        XCTAssertFalse(source.contains("identifier ?? \"\""))
        XCTAssertTrue(source.contains("chartAccessibilityIdentifier(identifier)"))
        XCTAssertTrue(source.contains("chartAccessibilityIdentifier(identifier.map"))
    }

    func testThePillSlidesToTheNewSegmentAndTakesItsWidth() throws {
        let (before, frames) = try sample(Box(), reduceMotion: false)
        let after = try XCTUnwrap(frames.last?.first)
        XCTAssertGreaterThan(after.lowerBound, before.upperBound, "the pill ends on Conversation, right of Inbox")
        XCTAssertGreaterThan(abs((after.upperBound - after.lowerBound) - (before.upperBound - before.lowerBound)), 4,
                             "Conversation is wider than Inbox: the pill must take the new width")
        XCTAssertTrue(frames.allSatisfy { $0.count == 1 }, "one pill the whole way, never two fading: \(frames)")

        let spans = frames.compactMap(\.first)
        print("pill from \(before) to \(after), every 1/60 s: \(spans.map { "\(Int($0.lowerBound))…\(Int($0.upperBound))" }.joined(separator: " "))")
        let between = spans.filter { $0.lowerBound > before.lowerBound + 2 && $0.lowerBound < after.lowerBound - 2 }
        XCTAssertGreaterThanOrEqual(between.count, 3, "the pill jumped instead of sliding: \(spans)")
        let lows = spans.map(\.lowerBound)
        XCTAssertEqual(lows, lows.sorted(), "the pill only moves toward its target: \(lows)")
        let widths = (before.upperBound - before.lowerBound, after.upperBound - after.lowerBound)
        for span in between {
            let width = span.upperBound - span.lowerBound
            XCTAssertTrue((min(widths.0, widths.1) - 1)...(max(widths.0, widths.1) + 1) ~= width,
                          "a pill \(width) pt wide on the way: it reshapes between \(widths)")
        }
        // GenMotion's 0.24 s: settled well before the half second the samples cover.
        let settledAt = spans.firstIndex { abs($0.lowerBound - after.lowerBound) < 0.5 && abs($0.upperBound - after.upperBound) < 0.5 }
        XCTAssertLessThan(try XCTUnwrap(settledAt), spans.count - 5, "the pill had not settled by the end: \(spans)")
    }

    func testUnderReduceMotionThePillMovesAtOnce() throws {
        let (before, frames) = try sample(Box(), reduceMotion: true)
        let after = try XCTUnwrap(frames.last?.first)
        XCTAssertGreaterThan(after.lowerBound, before.upperBound)
        let first = try XCTUnwrap(frames.first?.first)
        XCTAssertEqual(first.lowerBound, after.lowerBound, accuracy: 0.5, "Reduce Motion: the first frame is the last")
        XCTAssertEqual(first.upperBound, after.upperBound, accuracy: 0.5)
    }
}
