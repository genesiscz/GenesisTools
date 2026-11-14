import XCTest
@testable import GenesisKitBase

/// Where a step of `KitNumberField` lands.
final class KitNumberFieldTests: XCTestCase {
    func testAValueOffTheStepGridLandsOnItFirst() {
        // A step of 5 from 0: 7 goes up to 10 and down to 5, never to 12 or 2.
        XCTAssertEqual(KitNumberFieldMath.stepped(7, by: 1, step: 5, in: 0...100), 10)
        XCTAssertEqual(KitNumberFieldMath.stepped(7, by: -1, step: 5, in: 0...100), 5)
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
}
