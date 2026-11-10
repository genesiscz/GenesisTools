import XCTest
@testable import GenesisKit

/// The value rules of `KitNumberField`: what a typed text means, where a step lands, and the words of a unit.
final class KitNumberFieldTests: XCTestCase {
    func testATypedValueOutsideTheRangeLandsOnTheNearestLimit() {
        XCTAssertEqual(KitNumberFieldMath.parsed("500", fallback: 48, in: 1...336), 336)
        XCTAssertEqual(KitNumberFieldMath.parsed("0", fallback: 48, in: 1...336), 1)
        XCTAssertEqual(KitNumberFieldMath.parsed(" 72 ", fallback: 48, in: 1...336), 72)
        XCTAssertEqual(KitNumberFieldMath.parsed("-3", fallback: 0, in: -10...10), -3)
    }

    func testTextThatIsNoNumberPutsTheValueBack() {
        XCTAssertEqual(KitNumberFieldMath.parsed("", fallback: 48, in: 1...336), 48)
        XCTAssertEqual(KitNumberFieldMath.parsed("4h", fallback: 48, in: 1...336), 48)
        XCTAssertEqual(KitNumberFieldMath.parsed("1.5", fallback: 48, in: 1...336), 48)
    }

    func testAStepStopsAtTheLimits() {
        XCTAssertEqual(KitNumberFieldMath.stepped(48, by: 1, step: 1, in: 1...336), 49)
        XCTAssertEqual(KitNumberFieldMath.stepped(336, by: 1, step: 1, in: 1...336), 336)
        XCTAssertEqual(KitNumberFieldMath.stepped(5, by: -10, step: 1, in: 1...336), 1)
        XCTAssertEqual(KitNumberFieldMath.stepped(Int.max - 1, by: 10, step: 1, in: 0...Int.max), Int.max)
    }

    func testAValueOffTheStepGridLandsOnItFirst() {
        // A step of 5 from 0: 7 goes up to 10 and down to 5, never to 12 or 2.
        XCTAssertEqual(KitNumberFieldMath.stepped(7, by: 1, step: 5, in: 0...100), 10)
        XCTAssertEqual(KitNumberFieldMath.stepped(7, by: -1, step: 5, in: 0...100), 5)
        XCTAssertEqual(KitNumberFieldMath.stepped(7, by: 2, step: 5, in: 0...100), 15)
        XCTAssertEqual(KitNumberFieldMath.stepped(10, by: 1, step: 5, in: 0...100), 15)
        // The grid starts at the lower limit.
        XCTAssertEqual(KitNumberFieldMath.stepped(1, by: 1, step: 5, in: 1...100), 6)
    }

    func testTheFieldKeepsRoomForTheLongestValue() {
        XCTAssertEqual(KitNumberFieldMath.digits(in: 1...336), 3)
        XCTAssertEqual(KitNumberFieldMath.digits(in: 0...7200), 4)
        XCTAssertEqual(KitNumberFieldMath.digits(in: -10...10), 3)
    }

    func testACountedUnitFollowsTheNumber() {
        XCTAssertEqual(KitNumberAdornment.counted("day").words(for: 1), "day")
        XCTAssertEqual(KitNumberAdornment.counted("day").words(for: 14), "days")
        XCTAssertEqual(KitNumberAdornment.counted("day").words(for: 0), "days")
        XCTAssertEqual(KitNumberAdornment.counted("person", plural: "people").words(for: 3), "people")
        XCTAssertEqual(KitNumberAdornment.text("min").words(for: 1), "min")
        XCTAssertNil(KitNumberAdornment.symbol("clock").words(for: 1))
        XCTAssertEqual(KitNumberAdornment.counted("day").wordings, ["day", "days"])
    }
}
