import XCTest
@testable import SnapshotSupport

final class IdentifierTargetTests: XCTestCase {
    private func row(_ index: Int, _ identifier: String?, role: String = "AXButton",
                     title: String? = nil) -> [String: Any] {
        var row: [String: Any] = ["index": index, "role": role]
        if let identifier { row["AXIdentifier"] = identifier }
        if let title { row["AXTitle"] = title }

        return row
    }

    private func window(_ index: Int, _ title: String, _ rows: [[String: Any]]) -> IdentifierWindow {
        IdentifierWindow(index: index, title: title, rows: rows)
    }

    func testAUniqueIdentifierResolvesToItsWindowAndRow() throws {
        let windows = [
            window(0, "Main", [row(0, nil, role: "AXWindow"), row(1, "focus-hud-primary", title: "Start")]),
            window(1, "Settings", [row(0, nil, role: "AXWindow"), row(1, "settings-close")]),
        ]

        XCTAssertEqual(try resolveIdentifierTarget("focus-hud-primary", app: "Genesis", depth: 20, windows: windows),
                       IdentifierTarget(window: 0, element: 1))
    }

    func testAnIdentifierInTheSecondWindowIsStillFound() throws {
        let windows = [
            window(0, "Main", [row(0, nil, role: "AXWindow")]),
            window(1, "Settings", [row(0, nil, role: "AXWindow"), row(1, "settings-close")]),
        ]

        XCTAssertEqual(try resolveIdentifierTarget("settings-close", app: "Genesis", depth: 20, windows: windows),
                       IdentifierTarget(window: 1, element: 1))
    }

    func testAnUnknownIdentifierNamesTheSearchItPerformed() {
        let windows = [window(0, "Main", [row(0, "focus-hud-primary")])]

        XCTAssertThrowsError(try resolveIdentifierTarget("nope", app: "Genesis", depth: 20, windows: windows)) { error in
            guard let refusal = error as? SnapshotError else { return XCTFail("expected a SnapshotError") }
            XCTAssertEqual(refusal.category, .missingTarget)
            let message = refusal.errorDescription ?? ""
            XCTAssertTrue(message.contains("no element in Genesis carries the AXIdentifier \"nope\""), message)
            XCTAssertTrue(message.contains("searched 1 of 1 window(s) to depth 20"), message)
        }
    }

    // The failure this diagnostic exists for: the identifier is correct in the app's source, and
    // every element reports the container's one instead.
    func testAPropagatedIdentifierIsNamedWhenTheLookupFindsNothing() {
        let rows = (0..<6).map { row($0, "focus-studio") }

        XCTAssertThrowsError(try resolveIdentifierTarget("focus-hud-primary", app: "Genesis", depth: 20,
                                                         windows: [window(0, "Main", rows)])) { error in
            let message = (error as? SnapshotError)?.errorDescription ?? ""
            XCTAssertTrue(message.contains("6 elements in this app all report the identifier \"focus-studio\""), message)
            XCTAssertTrue(message.contains(".accessibilityElement(children: .contain)"), message)
        }
    }

    // 🛑 Two matches must never be narrowed to the first one. Acting on it is how the wrong
    // control is pressed and the run still reports success.
    func testTwoMatchesInOneWindowRefuseAndListBoth() {
        let windows = [window(0, "Main", [row(0, "row-delete", title: "Alpha"), row(1, "row-delete", title: "Beta")])]

        XCTAssertThrowsError(try resolveIdentifierTarget("row-delete", app: "Genesis", depth: 20, windows: windows)) { error in
            let message = (error as? SnapshotError)?.errorDescription ?? ""
            XCTAssertTrue(message.contains("matches 2 elements in Genesis"), message)
            XCTAssertTrue(message.contains("element 0 AXButton \"Alpha\""), message)
            XCTAssertTrue(message.contains("element 1 AXButton \"Beta\""), message)
            // Every match is in window 0, so naming a window cannot narrow anything.
            XCTAssertFalse(message.contains("--window-index"), message)
        }
    }

    func testMatchesInDifferentWindowsOfferTheWindowFlag() {
        let windows = [
            window(0, "Main", [row(0, "row-delete")]),
            window(1, "Second", [row(0, "row-delete")]),
        ]

        XCTAssertThrowsError(try resolveIdentifierTarget("row-delete", app: "Genesis", depth: 20, windows: windows)) { error in
            let message = (error as? SnapshotError)?.errorDescription ?? ""
            XCTAssertTrue(message.contains("Name one with --window-index"), message)
            XCTAssertTrue(message.contains("window 0 \"Main\""), message)
            XCTAssertTrue(message.contains("window 1 \"Second\""), message)
        }
    }

    func testAnEmptyIdentifierIsRefusedBeforeAnySearch() {
        XCTAssertThrowsError(try resolveIdentifierTarget("", app: "Genesis", depth: 20, windows: [])) { error in
            XCTAssertEqual((error as? SnapshotError)?.category, .refused)
        }
    }

    // A row without an AXIdentifier must never match the empty-string case by accident, and a
    // row whose identifier merely CONTAINS the needle is not that element.
    func testMatchingIsExactNeverASubstring() {
        let windows = [window(0, "Main", [row(0, nil), row(1, "focus-hud-primary-label")])]

        XCTAssertTrue(identifierMatches("focus-hud-primary", in: windows).isEmpty)
    }
}

extension IdentifierTargetTests {
    // The failure the count alone cannot express: the element may well exist, in the window that
    // could not be read.
    func testAWindowThatCouldNotBeObservedIsNamedInTheRefusal() {
        let windows = [IdentifierWindow(index: 1, title: "Main", rows: [["index": 0, "role": "AXWindow"]])]

        XCTAssertThrowsError(try resolveIdentifierTarget("focus-hud-primary", app: "Genesis", depth: 20,
                                                         windows: windows,
                                                         skipped: ["0: window is minimized"])) { error in
            let message = (error as? SnapshotError)?.errorDescription ?? ""
            XCTAssertTrue(message.contains("searched 1 of 2 window(s)"), message)
            XCTAssertTrue(message.contains("0: window is minimized"), message)
        }
    }
}
