import XCTest
@testable import GenesisKitBase

/// A click on an approval reminder usually lands in another GenesisTools process, whose host writes a reply file
/// (2026-11-19: the click on a vault card did nothing). The watch is what turns that file into the panel's click.
@MainActor
final class ApprovalReplyWatchTests: XCTestCase {
    private var dir = ""

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("approval-reply-\(UUID().uuidString)").path
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    private func writeReply(_ id: String) throws {
        let path = (dir as NSString).appendingPathComponent("\(id).json")
        try Data(#"{"actionId":"com.apple.UNNotificationDefaultActionIdentifier"}"#.utf8)
            .write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    func testAReplyWrittenLaterRunsTheClickOnceAndRemovesTheFile() throws {
        let clicked = expectation(description: "the click reached the panel")
        var clicks = 0
        let watch = ApprovalReplyWatch(dir: dir, notificationId: "approval.vault-unlock.T1") {
            clicks += 1
            clicked.fulfill()
        }

        try writeReply("approval.vault-unlock.T1")
        wait(for: [clicked], timeout: 5)

        XCTAssertEqual(clicks, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent("approval.vault-unlock.T1.json")))

        try writeReply("approval.vault-unlock.T1")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(clicks, 1, "a second reply after the first must not run the click again")
        watch.stop()
    }

    func testAReplyThatLandedBeforeTheWatchStartedStillCounts() throws {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try writeReply("approval.vault-unlock.T2")
        var clicks = 0

        let watch = ApprovalReplyWatch(dir: dir, notificationId: "approval.vault-unlock.T2") { clicks += 1 }

        XCTAssertEqual(clicks, 1)
        watch.stop()
    }

    func testTheReplyOfAnotherNotificationIsIgnored() throws {
        var clicks = 0
        let watch = ApprovalReplyWatch(dir: dir, notificationId: "approval.vault-unlock.T3") { clicks += 1 }

        try writeReply("approval.vault-unlock.OTHER")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))

        XCTAssertEqual(clicks, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: (dir as NSString).appendingPathComponent("approval.vault-unlock.OTHER.json")))
        watch.stop()
    }
}
