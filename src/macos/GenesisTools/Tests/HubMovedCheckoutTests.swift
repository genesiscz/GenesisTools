import XCTest
@testable import GenesisTools

/// A session's folder that holds no repository resolves to the checkout of the same name one level
/// down. A miss is not remembered: a checkout that appears later (a move still in progress) is found.
final class HubMovedCheckoutTests: XCTestCase {
    private var root = ""

    override func setUpWithError() throws {
        root = (NSTemporaryDirectory() as NSString).appendingPathComponent("hub-moved-checkout-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: root)
    }

    private func makeRepository(_ path: String) throws {
        let git = (path as NSString).appendingPathComponent(".git")
        try FileManager.default.createDirectory(atPath: git, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: (git as NSString).appendingPathComponent("HEAD"), contents: Data("ref: refs/heads/main\n".utf8))
    }

    func testAMissIsNotRememberedOnceTheCheckoutArrives() throws {
        let folder = (root as NSString).appendingPathComponent("App")
        XCTAssertNil(MovedCheckout.resolve(folder), "nothing moved yet")

        let moved = (root as NSString).appendingPathComponent("Group/App")
        try makeRepository(moved)

        XCTAssertEqual(MovedCheckout.resolve(folder), moved)
    }

    func testAMovedCheckoutThatLeavesAgainIsNotAnsweredFromTheCache() throws {
        let folder = (root as NSString).appendingPathComponent("Tool")
        let moved = (root as NSString).appendingPathComponent("Group/Tool")
        try makeRepository(moved)
        XCTAssertEqual(MovedCheckout.resolve(folder), moved)

        try FileManager.default.removeItem(atPath: moved)

        XCTAssertNil(MovedCheckout.resolve(folder))
    }
}
