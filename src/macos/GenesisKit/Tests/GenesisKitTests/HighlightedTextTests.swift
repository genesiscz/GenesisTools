import Foundation
import XCTest
@testable import GenesisKitBase

/// `HighlightedText` cuts its text at the ranges it is given and marks exactly those characters. The ranges count
/// UTF-16 code units, as NSString and the meetings engine count them, so a word after an emoji or a Czech letter
/// keeps its place.
@MainActor
final class HighlightedTextTests: XCTestCase {
    private func cut(_ text: String, _ ranges: [NSRange]) -> [HighlightedText.Segment] {
        HighlightedText.segments(text, ranges: ranges)
    }

    func testTheRangesAreTheMarkedCharactersAndNothingElse() {
        XCTAssertEqual(cut("Hoho. Pochop.", [NSRange(location: 0, length: 4)]),
                       [.init("Hoho", marked: true), .init(". Pochop.", marked: false)])
        XCTAssertEqual(cut("jenom Hoho řekl", [NSRange(location: 6, length: 4)]),
                       [.init("jenom ", marked: false), .init("Hoho", marked: true), .init(" řekl", marked: false)])
    }

    func testTheRangesCountUTF16CodeUnits() {
        // "Řekl 👍 " is 8 code units: the emoji takes two.
        XCTAssertEqual(cut("Řekl 👍 Hoho", [NSRange(location: 8, length: 4)]),
                       [.init("Řekl 👍 ", marked: false), .init("Hoho", marked: true)])
    }

    func testSeveralRangesInAnyOrderMergeWhereTheyOverlapOrTouch() {
        let text = "a Hoho b Hoho c"
        XCTAssertEqual(cut(text, [NSRange(location: 9, length: 4), NSRange(location: 2, length: 4), NSRange(location: 3, length: 2)]),
                       [.init("a ", marked: false), .init("Hoho", marked: true), .init(" b ", marked: false),
                        .init("Hoho", marked: true), .init(" c", marked: false)])
        XCTAssertEqual(cut("HoHo", [NSRange(location: 0, length: 2), NSRange(location: 2, length: 2)]),
                       [.init("HoHo", marked: true)], "two ranges that touch are one marked run")
    }

    func testARangeOutsideTheTextIsCutToItAndAnEmptyOneMarksNothing() {
        XCTAssertEqual(cut("Hoho", [NSRange(location: 2, length: 10)]),
                       [.init("Ho", marked: false), .init("ho", marked: true)])
        XCTAssertEqual(cut("Hoho", [NSRange(location: 9, length: 2), NSRange(location: 1, length: 0),
                                    NSRange(location: NSNotFound, length: 0)]),
                       [.init("Hoho", marked: false)])
        XCTAssertEqual(cut("Hoho", []), [.init("Hoho", marked: false)])
        XCTAssertEqual(cut("", [NSRange(location: 0, length: 3)]), [])
    }

    func testTheViewKeepsItsTextRangesAndStyle() {
        let ranges = [NSRange(location: 0, length: 4)]
        let view = HighlightedText("Hoho. Pochop.", ranges: ranges)
        XCTAssertEqual(view.text, "Hoho. Pochop.")
        XCTAssertEqual(view.ranges, ranges)
        XCTAssertEqual(view.style, .sparkle, "sparkle is the default style")
        XCTAssertEqual(HighlightedText("Hoho", ranges: ranges, style: .accent).style, .accent)
    }

    /// The sheen's gradient stops stay in order at every point of the sweep, its ends included: SwiftUI draws a
    /// gradient whose stops go backwards as a hard edge.
    func testTheSheenStopsStayInOrderOverTheWholeSweep() {
        for step in 0...40 {
            let phase = HighlightedText.sweepPhase(progress: Double(step) / 40)
            let locations = HighlightedText.sheenLocations(phase: phase)
            XCTAssertEqual(locations, locations.sorted(), "stops out of order at phase \(phase)")
            XCTAssertEqual(locations.first, 0)
            XCTAssertEqual(locations.last, 1)
        }
        XCTAssertLessThan(HighlightedText.sweepPhase(progress: 0), 0, "the sheen enters from before the text")
        XCTAssertGreaterThan(HighlightedText.sweepPhase(progress: 1), 1, "and leaves after it")
    }
}
