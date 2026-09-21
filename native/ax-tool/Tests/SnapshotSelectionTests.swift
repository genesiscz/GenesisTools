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

final class QueryRankingTests: XCTestCase {
    private func group(_ label: String?) -> QueryCandidate {
        QueryCandidate(title: nil, label: label, identifier: "focus-studio", actions: ["AXShowMenu"])
    }

    private func button(_ label: String) -> QueryCandidate {
        QueryCandidate(title: nil, label: label, identifier: "focus-studio", actions: ["AXPress"])
    }

    func testAContainerNeverWinsAPressQuery() {
        // The reported bug, as data. The container arrives FIRST because the walk is pre-order,
        // and it matched because it aggregates its children's labels. It cannot press.
        let candidates = [group("Previous range Next range"), button("Previous range")]
        let ranked = rankedQueryMatches(candidates, query: "Previous range", requiredAction: "AXPress")

        XCTAssertEqual(ranked, [1], "the button must win, not the group that merely contains its words")
    }

    func testAnExactLabelBeatsAPressableElementThatOnlyContainsTheWords() {
        // Exact match runs BEFORE the action filter on purpose: reversing them would let any
        // pressable row outrank the control the caller actually named.
        let candidates = [button("Previous range and more"), button("Previous range")]

        XCTAssertEqual(rankedQueryMatches(candidates, query: "Previous range", requiredAction: "AXPress"), [1])
    }

    func testNarrowingNeverEmptiesTheSet() {
        // When NOTHING can perform the verb, keep every match so the caller gets an honest
        // ambiguity or a named refusal, never a silent "no such element".
        let candidates = [group("Previous range"), group("Previous range")]

        XCTAssertEqual(rankedQueryMatches(candidates, query: "Previous range", requiredAction: "AXPress"), [0, 1])
    }

    // The other half: with no verb and no exact hit, ranking must not reorder or drop anything.
    func testWithoutAVerbTheMatchesAreUntouched() {
        let candidates = [group("alpha"), button("beta")]

        XCTAssertEqual(rankedQueryMatches(candidates, query: nil, requiredAction: nil), [0, 1])
    }
}
