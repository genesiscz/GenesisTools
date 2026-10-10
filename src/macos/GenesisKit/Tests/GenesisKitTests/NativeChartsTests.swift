import XCTest
@testable import GenesisKit

final class NativeChartAxisLabelTests: XCTestCase {
    func testHourlyTicksAcrossDaysCarryTheDate() {
        let first = Date(timeIntervalSince1970: 1_700_000_000)
        let nextDay = first.addingTimeInterval(86400)
        let wide = NativeChartSampling.axisLabelFormat(interval: 3600, window: 3 * 86400)
        XCTAssertNotEqual(first.formatted(wide), nextDay.formatted(wide), "same hour on two days must read differently")
        let narrow = NativeChartSampling.axisLabelFormat(interval: 3600, window: 12 * 3600)
        XCTAssertEqual(first.formatted(narrow), nextDay.formatted(narrow), "a sub-day window keeps the short time label")
        let daily = NativeChartSampling.axisLabelFormat(interval: 86400, window: 30 * 86400)
        XCTAssertNotEqual(first.formatted(daily), nextDay.formatted(daily))
    }
}
