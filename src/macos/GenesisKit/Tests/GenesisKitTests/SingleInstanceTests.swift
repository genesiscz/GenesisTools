import Foundation
@testable import GenesisKitBase
import XCTest

final class SingleInstanceTests: XCTestCase {
    private func instance(_ lock: URL) -> SingleInstance {
        SingleInstance(name: "test", lockFile: lock, notificationPrefix: "test.single.\(UUID().uuidString)", retryHint: "", log: { _ in })
    }

    func testTheProbeDescriptorClosesWhenTheWatcherIsDestroyed() throws {
        let lock = FileManager.default.temporaryDirectory.appendingPathComponent("single-\(UUID().uuidString).lock")
        defer { try? FileManager.default.removeItem(at: lock) }
        FileManager.default.createFile(atPath: lock.path, contents: nil)
        var watcher: SingleInstance? = instance(lock)
        XCTAssertFalse(watcher!.isRunningElsewhere)
        let descriptor = watcher!.probeDescriptor
        XCTAssertGreaterThanOrEqual(descriptor, 0)
        XCTAssertNotEqual(fcntl(descriptor, F_GETFD), -1)
        watcher = nil
        XCTAssertEqual(fcntl(descriptor, F_GETFD), -1)
    }

    /// The probe keeps its handle open, so it must not keep the shared lock it tests with: a later launch would
    /// lose its exclusive claim to it.
    func testTheProbeSeesAHolderAndNeverBlocksALaterClaim() throws {
        let lock = FileManager.default.temporaryDirectory.appendingPathComponent("single-\(UUID().uuidString).lock")
        defer { try? FileManager.default.removeItem(at: lock) }
        FileManager.default.createFile(atPath: lock.path, contents: nil)

        let watcher = instance(lock)
        XCTAssertFalse(watcher.isRunningElsewhere, "nobody holds the lock yet")
        XCTAssertFalse(watcher.isRunningElsewhere, "a second probe on the kept handle answers the same")

        let holder = instance(lock)
        XCTAssertTrue(holder.claim(), "a probe that kept its shared lock would refuse this claim")
        XCTAssertTrue(watcher.isRunningElsewhere, "the holder's exclusive lock is seen through the kept handle")
        XCTAssertFalse(holder.isRunningElsewhere, "the holder itself is not elsewhere")
    }
}
