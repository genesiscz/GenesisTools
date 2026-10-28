import XCTest
@testable import GenesisToolsHost

/// What the `tools rm` approval window (Sources/Host/RmApprove.swift) shows: who asked, the first items, and the rest
/// folded into Details, so a long request never grows the window past the screen.
final class RmApproveTests: XCTestCase {
    func testShowsTheCallerAndFoldsLongLists() {
        let lines = (1...9).map { "/tmp/item-\($0)" }
        let params = RmApproveParams(title: "Delete 9 paths?", lines: lines, caller: "codex · fix-build", folder: "/Users/someone/Projects/app")
        let content = RmWindowContent.build(params, home: "/Users/someone")

        XCTAssertEqual(content.facts.first?.label, "Asked by")
        XCTAssertEqual(content.facts.first?.value, "codex · fix-build")
        XCTAssertEqual(content.facts.filter(\.monospaced).map(\.value), Array(lines.prefix(6)))
        XCTAssertEqual(content.facts.last?.value, "3 more items in Details")
        XCTAssertEqual(content.details.map(\.value), Array(lines.suffix(3)))
        XCTAssertEqual(content.details.map(\.label), ["7", "8", "9"])
        XCTAssertEqual(Set(content.facts.map(\.id)).count, content.facts.count)
    }

    func testAPersonRunHasNoCallerAndNoDetails() {
        let params = RmApproveParams(title: "Set approval to code?", lines: ["approval = code"], caller: nil, folder: nil)
        let content = RmWindowContent.build(params)

        XCTAssertEqual(content.facts.map(\.value), ["approval = code"])
        XCTAssertTrue(content.details.isEmpty)
    }
}
