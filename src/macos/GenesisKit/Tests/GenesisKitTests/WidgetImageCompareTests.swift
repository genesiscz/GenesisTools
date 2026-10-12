import XCTest

@testable import GenesisKit

final class WidgetImageCompareTests: XCTestCase {
    private func image(_ id: String, _ width: Int, _ height: Int) -> WidgetImageReference {
        WidgetImageReference(id: id, path: "/fixture/\(id).png", name: "\(id).png", width: width, height: height)
    }

    func testImagesOfDifferentSizesSayWhyTheyAreNotCompared() {
        let reason = WidgetImageDifference.notComparedReason(image("before", 800, 600), image("after", 1024, 768))
        XCTAssertEqual(reason, "These images differ in size (800 × 600 and 1024 × 768), so they are not compared.")
        XCTAssertNotNil(WidgetImageDifference.notComparedReason(image("a", 800, 600), image("b", 800, 601)))
    }

    func testImagesOfOneSizeAreCompared() {
        XCTAssertNil(WidgetImageDifference.notComparedReason(image("before", 800, 600), image("after", 800, 600)))
    }
}
