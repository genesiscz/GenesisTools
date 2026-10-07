import XCTest

@testable import GenesisKit

final class AgentWidgetKeyboardTests: XCTestCase {
    func testPhysicalNumberRowWorksWithNonNumericLayoutCharacters() {
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x12, characters: "+"), 1)
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x13, characters: "ě"), 2)
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x14, characters: "š"), 3)
    }

    func testNumericKeypadAndUnrelatedKeys() {
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x54, characters: "2"), 2)
        XCTAssertNil(AgentWidgetKeyboard.choiceNumber(keyCode: 0, characters: "a"))
        XCTAssertNil(AgentWidgetKeyboard.choiceNumber(keyCode: 0, characters: "0"))
    }
}
