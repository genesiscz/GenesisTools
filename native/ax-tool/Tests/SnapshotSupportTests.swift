import XCTest
@testable import SnapshotSupport

final class SnapshotSupportTests: XCTestCase {
    func testSnapshotRejectsWrongProcessExpiredStateAndInvalidIndices() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        for input in [(Int32(43), 123.0, 2, 1001.0), (42, 124, 2, 1001),
                      (42, 123, 2, 1121), (42, 123, 2, 999),
                      (42, 123, -1, 1001), (42, 123, 4, 1001)] {
            XCTAssertThrowsError(try token.validate(pid: input.0, launch: input.1, digest: "original",
                                                    element: input.2, count: 4, now: input.3))
        }
    }

    func testUnchangedSnapshotResolvesAnonymousElement() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        XCTAssertEqual(try token.validate(pid: 42, launch: 123, digest: "original",
                                          element: 2, count: 4, now: 1001), 2)
    }

    func testSnapshotRejectsReplacedWindowBeforeReturningElementIndex() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        XCTAssertThrowsError(try token.validate(pid: 42, launch: 123, digest: "replaced",
                                                element: 2, count: 4, now: 1001))
    }
}
