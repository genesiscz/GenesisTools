import XCTest
@testable import GenesisTools

/// `HubFormat.date` parses each string once and answers repeats from its cache, so it must give the
/// same answer the second time, a miss included.
final class HubFormatTests: XCTestCase {
    func testDatesParseWithAndWithoutFractionsAndRepeatsMatch() throws {
        let fractional = try XCTUnwrap(HubFormat.date("2026-03-02T13:00:00.250Z"))
        XCTAssertEqual(fractional.timeIntervalSince1970, 1_772_456_400.25, accuracy: 0.001)
        let plain = try XCTUnwrap(HubFormat.date("2026-03-02T13:00:00Z"))
        XCTAssertEqual(plain.timeIntervalSince1970, 1_772_456_400, accuracy: 0.001)

        XCTAssertEqual(HubFormat.date("2026-03-02T13:00:00.250Z"), fractional, "a cached hit is the same moment")
        XCTAssertNil(HubFormat.date("not a date"))
        XCTAssertNil(HubFormat.date("not a date"), "a cached miss stays a miss")
        XCTAssertNil(HubFormat.date(nil))
    }
}
