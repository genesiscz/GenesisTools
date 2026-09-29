import XCTest
@testable import SnapshotSupport

final class TypedTextVerdictTests: XCTestCase {
    func testTextThatLandedIsVerified() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField \"Go to\"", before: "~/", after: "~/dist", text: "dist",
                                        replace: false), .verified)
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "old", after: "new", text: "new",
                                        replace: true), .verified)
    }

    /// The readback's stop rule: a field that already held the text has not landed it again yet.
    func testLandedNeedsANewOccurrenceNotContainment() {
        XCTAssertFalse(typedTextLanded(before: "hello", after: "hello", text: "hello"))
        XCTAssertTrue(typedTextLanded(before: "hello", after: "hello hello", text: "hello"))
        XCTAssertTrue(typedTextLanded(before: "", after: "hello", text: "hello"))
        XCTAssertFalse(typedTextLanded(before: "hello", after: nil, text: "hello"))
    }

    /// The observed case: a Go-to-folder field that stayed empty while the command said "typed".
    func testUnchangedFieldIsNotLanded() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField \"Go to\"", before: "", after: "",
                                        text: "/Users/example/dist", replace: false), .notLanded)
    }

    func testNothingReadableIsUnverifiableNeverVerified() {
        XCTAssertEqual(typedTextVerdict(element: nil, before: nil, after: nil, text: "x", replace: false),
                       .unverifiable("the app reports no focused element"))
        XCTAssertEqual(typedTextVerdict(element: "AXWebArea", before: nil, after: nil, text: "x", replace: false),
                       .unverifiable("the focused AXWebArea has no readable value"))
    }

    func testChangedIntoSomethingElseIsReported() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "", after: "aaaa", text: "/tmp",
                                        replace: false), .different("aaaa"))
    }

    /// Autocomplete rewriting a field that already held the text is not the typed text landing.
    func testAnInsertionNeedsANewOccurrence() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "genesis.tools", after: "genesis.tools/t",
                                        text: "genesis", replace: false), .different("genesis.tools/t"))
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "genesis ", after: "genesis genesis",
                                        text: "genesis", replace: false), .verified)
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "x", after: "x", text: "", replace: false), .verified)
    }

    func testReplacingWithIdenticalTextStillVerifies() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "same", after: "same", text: "same",
                                        replace: true), .verified)
    }
}

extension TypedTextVerdictTests {
    func testKeysStopTheMomentAnotherAppTakesTheFront() {
        var front = true
        var posted: [Character] = []
        let count = postWhileFrontmost(Array("abcdef"), isTargetFront: { front }, post: { character in
            posted.append(character)
            if character == "c" { front = false }
        })
        XCTAssertEqual(count, 3)
        XCTAssertEqual(String(posted), "abc")
    }

    func testNothingIsPostedWhenTheTargetIsNotInFront() {
        var posted = 0
        XCTAssertEqual(postWhileFrontmost([1, 2], isTargetFront: { false }, post: { _ in posted += 1 }), 0)
        XCTAssertEqual(posted, 0)
    }
}
