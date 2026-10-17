import XCTest
@testable import SnapshotSupport

final class BrowserTabInfoTests: XCTestCase {
    func testURLIsOmittedWhenTheTitleReadDidNotComplete() {
        XCTAssertNil(BrowserTabInfo.checked(
            url: "https://example.test", title: nil, appName: "Safari", axWindowTitles: ["Example"]
        ))
        XCTAssertNil(BrowserTabInfo.checked(
            url: "https://example.test", title: "", appName: "Safari", axWindowTitles: ["Example"]
        ))
    }

    func testMatchingTitleVerifiesTheTabAgainstTheProcess() {
        let tab = BrowserTabInfo.checked(
            url: "https://example.test", title: "example", appName: "Safari", axWindowTitles: ["Example - Safari"]
        )

        XCTAssertEqual(tab?["url"] as? String, "https://example.test")
        XCTAssertEqual(tab?["title"] as? String, "example")
        XCTAssertEqual(tab?["pidMatch"] as? Bool, true)
        XCTAssertNil(tab?["warning"])
    }

    func testMismatchingTitleKeepsTheExistingWarning() {
        let tab = BrowserTabInfo.checked(
            url: "https://example.test", title: "Other instance", appName: "Safari", axWindowTitles: ["Example"]
        )

        XCTAssertEqual(tab?["pidMatch"] as? Bool, false)
        XCTAssertTrue((tab?["warning"] as? String ?? "").contains("do not trust for this process"))
    }
}
