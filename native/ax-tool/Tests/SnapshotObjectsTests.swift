import Foundation
import XCTest
@testable import SnapshotSupport

private final class CollidingObject: NSObject {
    let value: Int
    init(_ value: Int) { self.value = value }
    override var hash: Int { 7 }
    override func isEqual(_ object: Any?) -> Bool { (object as? CollidingObject)?.value == value }
}

final class SnapshotObjectsTests: XCTestCase {
    func testSharedReferencesAreVisitedOnceWithoutDroppingHashCollisions() {
        // Regression: real Brave AX inspection refused a repeated object/hash.
        var objects = SnapshotObjectSet()
        let first = CollidingObject(1)
        let second = CollidingObject(2)
        XCTAssertEqual(CFHash(first), CFHash(second))
        XCTAssertTrue(objects.insert(first))
        XCTAssertTrue(objects.insert(second))
        XCTAssertFalse(objects.insert(first))
        XCTAssertFalse(objects.insert(CollidingObject(1)))
    }

    func testChromeScopeSurvivesSnapshotEncoding() throws {
        let token = SnapshotToken(pid: 42, launch: 1, window: 5, depth: 20, digest: "tree", created: 100, scope: "chrome")
        let decoded = try JSONDecoder().decode(SnapshotToken.self, from: JSONEncoder().encode(token))
        XCTAssertEqual(decoded.effectiveScope, "chrome")
        XCTAssertEqual(try decoded.validate(pid: 42, launch: 1, window: 5, digest: "tree", element: 0, count: 1, now: 101), 0)
    }
}
