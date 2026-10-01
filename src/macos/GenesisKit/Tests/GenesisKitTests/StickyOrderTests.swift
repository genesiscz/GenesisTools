import Foundation
import XCTest
@testable import GenesisKit

final class StickyOrderTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func item(_ id: String, _ active: Bool, _ age: TimeInterval) -> StickyOrder<String>.Item {
        .init(id: id, active: active, lastAt: t0.addingTimeInterval(-age))
    }

    func testFirstUpdateSortsActiveFirstThenRecent() {
        var order = StickyOrder<String>()
        let result = order.update([item("a", false, 10), item("b", true, 50), item("c", false, 5)], now: t0)
        XCTAssertEqual(result, ["b", "c", "a"])
    }

    func testRecencyChangesInsideABucketDoNotReorder() {
        var order = StickyOrder<String>()
        order.update([item("a", true, 10), item("b", true, 20)], now: t0)
        // b wrote more recently now; it must not jump above a.
        let result = order.update([item("a", true, 30), item("b", true, 1)], now: t0.addingTimeInterval(5))
        XCTAssertEqual(result, ["a", "b"])
    }

    func testNewRowGoesToTheTopOfItsBucket() {
        var order = StickyOrder<String>()
        order.update([item("a", true, 10), item("x", false, 100), item("y", false, 200)], now: t0)
        let result = order.update([item("a", true, 10), item("x", false, 100), item("y", false, 200), item("n", false, 300)], now: t0)
        XCTAssertEqual(result, ["a", "n", "x", "y"])
    }

    func testActiveRowStaysUntilHoldExpires() {
        var order = StickyOrder<String>(hold: 120)
        order.update([item("a", true, 0), item("x", false, 100)], now: t0)
        let soon = order.update([item("a", false, 60), item("x", false, 100)], now: t0.addingTimeInterval(60))
        XCTAssertEqual(soon, ["a", "x"])
        XCTAssertTrue(order.isActive("a"))
        let later = order.update([item("a", false, 200), item("x", false, 100)], now: t0.addingTimeInterval(200))
        XCTAssertFalse(order.isActive("a"))
        XCTAssertEqual(later, ["a", "x"], "a mover goes to the top of the inactive bucket")
    }

    func testRowTurningActiveMovesUpAtOnce() {
        var order = StickyOrder<String>()
        order.update([item("a", true, 0), item("x", false, 10), item("y", false, 20)], now: t0)
        let result = order.update([item("a", true, 0), item("x", false, 10), item("y", true, 0)], now: t0)
        XCTAssertEqual(result, ["y", "a", "x"])
    }

    func testHoldFreezesMovesAndAppendsNewRows() {
        var order = StickyOrder<String>()
        order.update([item("a", true, 0), item("x", false, 10), item("y", false, 20)], now: t0)
        let held = order.update([item("a", true, 0), item("x", false, 10), item("y", true, 0), item("n", true, 0)], now: t0, hold: true)
        XCTAssertEqual(held, ["a", "x", "y", "n"])
        let released = order.update([item("a", true, 0), item("x", false, 10), item("y", true, 0), item("n", true, 0)], now: t0)
        XCTAssertEqual(released.first.map { ["y", "n"].contains($0) }, true)
        XCTAssertEqual(Set(released.prefix(3)), ["a", "y", "n"])
        XCTAssertEqual(released.last, "x")
    }

    func testResortSortsEverythingAgain() {
        var order = StickyOrder<String>()
        order.update([item("a", true, 10), item("b", true, 20)], now: t0)
        let result = order.update([item("a", true, 30), item("b", true, 1)], now: t0, resort: true)
        XCTAssertEqual(result, ["b", "a"])
    }

    func testGoneRowsDrop() {
        var order = StickyOrder<String>()
        order.update([item("a", true, 0), item("b", false, 5)], now: t0)
        XCTAssertEqual(order.update([item("b", false, 5)], now: t0), ["b"])
    }
}
