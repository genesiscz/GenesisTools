import SwiftUI
import XCTest
@testable import GenesisKit

final class ForgeBadgeTests: XCTestCase {
    func testBothMarksSpanTheirSixteenUnitBoxAndStayInIt() {
        for (name, path) in [("github", ForgeMark.github), ("gitlab", ForgeMark.gitlab)] {
            let box = path.boundingRect
            XCTAssertTrue(CGRect(x: -0.1, y: -0.1, width: 16.2, height: 16.2).contains(box), "\(name) \(box)")
            XCTAssertGreaterThan(box.width, 15.5, name)
            XCTAssertGreaterThan(box.height, 13.5, name)
        }
    }

    func testCompactNumbersSplitAtASecondDotAndAMinus() {
        // `.5.5` is 0.5 then 0.5; `-.5` starts a new number.
        let path = SVGPath.parse("M0 0l.5.5-.5.5z")
        XCTAssertEqual(path.boundingRect, CGRect(x: 0, y: 0, width: 0.5, height: 1))
    }

    func testAnUnknownCommandEndsThePathInsteadOfMisdrawing() {
        let path = SVGPath.parse("M0 0L4 4A1 1 0 0 0 9 9")
        XCTAssertEqual(path.boundingRect, CGRect(x: 0, y: 0, width: 4, height: 4))
    }

    func testForgeWordsFollowTheHost() {
        XCTAssertEqual(Forge(kind: "github")?.label(436), "#436")
        XCTAssertEqual(Forge(kind: "GitLab")?.label(7412), "!7412")
        XCTAssertEqual(Forge(kind: "gitlab")?.noun, "MR")
        XCTAssertNil(Forge(kind: "bitbucket"))
        XCTAssertNil(Forge(kind: nil))
    }
}
