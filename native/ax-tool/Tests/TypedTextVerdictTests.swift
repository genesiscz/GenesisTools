import XCTest
@testable import SnapshotSupport

final class TypedTextVerdictTests: XCTestCase {
    func testTextThatLandedIsVerified() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField \"Go to\"", before: "~/", after: "~/dist", text: "dist",
                                        replace: false), .verified)
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "old", after: "new", text: "new",
                                        replace: true), .verified)
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

    func testReplacingWithIdenticalTextStillVerifies() {
        XCTAssertEqual(typedTextVerdict(element: "AXTextField", before: "same", after: "same", text: "same",
                                        replace: true), .verified)
    }
}
