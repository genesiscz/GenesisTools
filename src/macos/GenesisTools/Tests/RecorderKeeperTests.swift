import XCTest
@testable import GenesisToolsRecorder

final class RecorderKeeperTests: XCTestCase {
    @MainActor
    func testStartsOnceAndBacksOffAfterAnExit() throws {
        var processes: [pid_t] = []
        var starts = 0
        var launched: ((Result<pid_t, Error>) -> Void)?
        var exited: ((Int32) -> Void)?
        var retries: [(TimeInterval, () -> Void)] = []
        let keeper = RecorderKeeper(owner: { processes.first }, launch: { completion in
            starts += 1
            launched = completion
        }, watch: { _, completion in
            exited = completion
            return {}
        }, later: { delay, run in
            retries.append((delay, run))
            return {}
        })
        keeper.setEnabled(true)
        keeper.setEnabled(true)
        XCTAssertEqual(starts, 1)
        processes = [42]
        launched?(.success(42))
        keeper.setEnabled(true)
        XCTAssertEqual(starts, 1)
        processes = []
        exited?(15)
        keeper.setEnabled(true)
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(retries.map(\.0), [1])
        let firstRetry = try XCTUnwrap(retries.first)
        retries.removeAll()
        firstRetry.1()
        XCTAssertEqual(starts, 2)
        launched?(.success(43))
        exited?(9)
        XCTAssertEqual(retries.map(\.0), [2])
        keeper.setEnabled(false)
        try XCTUnwrap(retries.first).1()
        XCTAssertEqual(starts, 2)
    }

    @MainActor
    func testAdoptsARunningRecorderWithoutStartingAnother() {
        var watched: [pid_t] = []
        let keeper = RecorderKeeper(owner: { 17 }, launch: { _ in XCTFail("Already running") }, watch: { pid, _ in
            watched.append(pid)
            return {}
        }, later: { _, _ in XCTFail("A healthy recorder needs no timer"); return {} })
        keeper.setEnabled(true)
        keeper.setEnabled(true)
        XCTAssertEqual(watched, [17])
        XCTAssertEqual(RecorderKeeper.exitReason(9), "signal 9")
        XCTAssertEqual(RecorderKeeper.exitReason(7 << 8), "code 7")
    }
}
