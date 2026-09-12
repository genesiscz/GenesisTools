import Foundation
import XCTest
@testable import SnapshotSupport

final class SnapshotSelectionTests: XCTestCase {
    func testExplicitUTF16RangeSelectsTheRequestedCharacters() throws {
        let selection = try snapshotSelection(in: "A😀BC", text: nil, range: "1,2", prefix: nil, suffix: nil, mode: "text")

        XCTAssertEqual(selection, NSRange(location: 1, length: 2))
    }

    func testLiteralSelectionUsesImmediatePrefixAndSuffixToFindOneOccurrence() throws {
        let selection = try snapshotSelection(
            in: "one hello! two hello?",
            text: "hello",
            range: nil,
            prefix: "one ",
            suffix: "!",
            mode: "text"
        )

        XCTAssertEqual(selection, NSRange(location: 4, length: 5))
    }

    func testLiteralSelectionRejectsOverlappingMatches() {
        XCTAssertThrowsError(
            try snapshotSelection(in: "aaaa", text: "aa", range: nil, prefix: nil, suffix: nil, mode: "text")
        )
    }

    func testExplicitRangeRejectsAnIndexInsideASurrogatePair() {
        XCTAssertThrowsError(
            try snapshotSelection(in: "A😀B", text: nil, range: "2,1", prefix: nil, suffix: nil, mode: "text")
        )
    }

    func testCursorAfterAnExplicitRangeUsesTheRangeEnd() throws {
        let selection = try snapshotSelection(
            in: "A😀BC",
            text: nil,
            range: "1,2",
            prefix: nil,
            suffix: nil,
            mode: "cursor_after"
        )

        XCTAssertEqual(selection, NSRange(location: 3, length: 0))
    }

    func testLiteralSelectionRejectsAbsentText() {
        XCTAssertThrowsError(
            try snapshotSelection(in: "visible", text: "missing", range: nil, prefix: nil, suffix: nil, mode: "text")
        )
    }

    func testSelectionRejectsBothLiteralTextAndAnExplicitRange() {
        XCTAssertThrowsError(
            try snapshotSelection(in: "visible", text: "visible", range: "0,7", prefix: nil, suffix: nil, mode: "text")
        )
    }
}
