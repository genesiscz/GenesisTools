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
        XCTAssertEqual(KitNumberFieldMath.stepped(-7, by: 1, step: 5, in: -100...100), -5)
        XCTAssertEqual(KitNumberFieldMath.stepped(-7, by: -1, step: 5, in: -100...100), -10)
    }

    // Each of these trapped on an intermediate sum before the last one was checked.
    func testAStepNearTheEndsOfIntLandsOnTheLimitInsteadOfTrapping() {
        XCTAssertEqual(KitNumberFieldMath.stepped(10, by: 10, step: Int.max, in: 0...Int.max), Int.max,
                       "Shift with a step of Int.max: ten steps")
        XCTAssertEqual(KitNumberFieldMath.stepped(10, by: -10, step: Int.max, in: Int.min...Int.max), Int.min)
        XCTAssertEqual(KitNumberFieldMath.stepped(0, by: 1, step: 5, in: Int.min...Int.max), 2,
                       "the grid starts at Int.min, so 2 is on it; value - lowerBound overflowed")
        XCTAssertEqual(KitNumberFieldMath.stepped(Int.max, by: -1, step: 2, in: Int.min...Int.max), Int.max - 1)
        XCTAssertEqual(KitNumberFieldMath.stepped(Int.max - 1, by: 1, step: 4, in: 0...Int.max), Int.max,
                       "landing on the grid would pass Int.max")
        XCTAssertEqual(KitNumberFieldMath.stepped(Int.min + 1, by: -1, step: 4, in: (Int.min + 3)...0), Int.min + 3,
                       "landing on the grid would pass Int.min")
        XCTAssertEqual(KitNumberFieldMath.stepped(5, by: Int.max, step: 2, in: 0...100), 100)
        XCTAssertEqual(KitNumberFieldMath.stepped(5, by: Int.min, step: 2, in: 0...100), 0)
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
