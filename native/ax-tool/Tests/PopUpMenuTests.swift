import XCTest
@testable import SnapshotSupport

final class PopUpMenuTests: XCTestCase {
    private func row(_ depth: Int, _ role: String) -> [String: Any] {
        ["depth": depth, "role": role]
    }

    func testOnlyMenuPresentingRolesOpenAMenuOnPress() {
        XCTAssertTrue(pressOpensMenu(role: "AXMenuButton", axAction: "AXPress"))
        XCTAssertTrue(pressOpensMenu(role: "AXPopUpButton", axAction: "AXPress"))
        XCTAssertFalse(pressOpensMenu(role: "AXButton", axAction: "AXPress"))
        XCTAssertFalse(pressOpensMenu(role: nil, axAction: "AXPress"))
    }

    func testShowMenuAlwaysOpensAMenuWhateverTheRole() {
        XCTAssertTrue(pressOpensMenu(role: "AXButton", axAction: "AXShowMenu"))
        XCTAssertFalse(pressOpensMenu(role: "AXMenuButton", axAction: "AXPick"))
    }

    func testAnOpenMenuIsFoundInsideItsOwnerSpan() {
        let rows = [row(0, "AXWindow"), row(1, "AXGroup"), row(2, "AXMenuButton"), row(3, "AXMenu"),
                    row(4, "AXMenuItem")]

        XCTAssertEqual(openMenuIndex(owner: 2, rows: rows), 3)
    }

    func testAClosedMenuButtonOwnsNoMenu() {
        let rows = [row(0, "AXWindow"), row(1, "AXMenuButton"), row(1, "AXButton")]

        XCTAssertNil(openMenuIndex(owner: 1, rows: rows))
    }

    // 🛑 The question is "is THIS control's menu open", never "is a menu open". A second menu
    // button's open menu is a sibling, outside the span, and must not answer for the first.
    func testASiblingsOpenMenuIsNotThisControlsMenu() {
        let rows = [row(0, "AXWindow"), row(1, "AXMenuButton"), row(1, "AXMenuButton"), row(2, "AXMenu")]

        XCTAssertNil(openMenuIndex(owner: 1, rows: rows))
        XCTAssertEqual(openMenuIndex(owner: 2, rows: rows), 3)
    }

    func testAnOutOfRangeOwnerIsNotAnOpenMenu() {
        XCTAssertNil(openMenuIndex(owner: 9, rows: [row(0, "AXWindow")]))
    }

    func testTheWaitedForConditionIsTheMenuItself() {
        XCTAssertFalse(treeCarriesOpenMenu([row(0, "AXWindow"), row(1, "AXMenuButton")]))
        XCTAssertTrue(treeCarriesOpenMenu([row(0, "AXWindow"), row(1, "AXMenuButton"), row(2, "AXMenu")]))
    }
}
