import XCTest
@testable import GenesisTools

/// Which faces keep the link relay in front of them (LinkRelay.swift).
final class LinkRelayTests: XCTestCase {
    func testEveryWindowFaceEnsuresTheRelayAndScriptedRunsDoNot() {
        XCTAssertTrue(LinkRelay.shouldEnsure([]))
        XCTAssertTrue(LinkRelay.shouldEnsure(["--hub"]))
        XCTAssertTrue(LinkRelay.shouldEnsure(["--review", "--proposal", "/tmp/p.json"]))
        XCTAssertFalse(LinkRelay.shouldEnsure(["--hub", "--snapshot", "/tmp/x.png"]))
        XCTAssertFalse(LinkRelay.shouldEnsure([LinkRelay.argument]))
        XCTAssertFalse(LinkRelay.shouldEnsure(["--rpc", "{}"]))
        XCTAssertFalse(LinkRelay.shouldEnsure(["https://example.org/"]))
    }

    func testABareLaunchIsNotRunAgainBecauseItMayCarryABannerClick() {
        XCTAssertTrue(LinkRelay.mayRunAgain(["--hub", "--pr", "7"]))
        XCTAssertTrue(LinkRelay.mayRunAgain(["--review"]))
        XCTAssertTrue(LinkRelay.mayRunAgain(["--window"]))
        XCTAssertFalse(LinkRelay.mayRunAgain([]))
        XCTAssertFalse(LinkRelay.mayRunAgain(["-psn_0_12345"]))
    }

    func testTheNextRelayNamesACrashButNotACleanEndOrALiveRelay() {
        let started = Date(timeIntervalSinceNow: -600)
        let crashed = RelayJournal.State(pid: 4242, startedAt: started, heartbeatAt: Date(timeIntervalSinceNow: -120), cleanExit: false)
        let line = RelayJournal.previousEnd(crashed, isAlive: { _ in false }, crashReport: { _ in "/reports/GenesisTools-1.ips" })
        XCTAssertNotNil(line)
        XCTAssertTrue(line!.contains("pid=4242 ended without a clean exit"))
        XCTAssertTrue(line!.contains("crash report /reports/GenesisTools-1.ips"))
        XCTAssertTrue(RelayJournal.previousEnd(crashed, isAlive: { _ in false }, crashReport: { _ in nil })!.contains("no crash report"))

        var clean = crashed
        clean.cleanExit = true
        XCTAssertNil(RelayJournal.previousEnd(clean, isAlive: { _ in false }, crashReport: { _ in nil }))
        XCTAssertNil(RelayJournal.previousEnd(crashed, isAlive: { _ in true }, crashReport: { _ in nil }), "it still runs")
        XCTAssertNil(RelayJournal.previousEnd(nil, isAlive: { _ in false }, crashReport: { _ in nil }))
    }

    func testAStartingRelayRetriesATransientProbeLock() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-lock-\(UUID())")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let probe = open(file.path, O_RDWR)
        let relay = open(file.path, O_RDWR)
        defer { close(probe); close(relay); try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(flock(probe, LOCK_SH | LOCK_NB), 0)
        let released = DispatchSemaphore(value: 0)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            flock(probe, LOCK_UN)
            released.signal()
        }
        XCTAssertTrue(LinkRelay.acquireLock(relay))
        XCTAssertEqual(released.wait(timeout: .now() + 1), .success)
    }

    func testAnotherRelayStillExcludesASecondClaim() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-lock-\(UUID())")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        let first = open(file.path, O_RDWR)
        let second = open(file.path, O_RDWR)
        defer { close(first); close(second); try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(flock(first, LOCK_EX | LOCK_NB), 0)
        XCTAssertFalse(LinkRelay.acquireLock(second))
    }

    func testAClaimCannotSucceedWithoutAnOpenedAndExclusiveDescriptor() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("relay-claim-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        XCTAssertNil(LinkRelay.claimDescriptor(directory), "a directory cannot open as a writable lock file")
        let file = directory.appendingPathComponent("relay.lock")
        let descriptor = try XCTUnwrap(LinkRelay.claimDescriptor(file))
        defer { close(descriptor) }
        XCTAssertNil(LinkRelay.claimDescriptor(file), "the normal first claim excludes a second relay")
        XCTAssertNil(LinkRelay.claimDescriptor(directory.appendingPathComponent("missing/relay.lock")))
    }

    func testTheStateFileRoundTrips() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("relay-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let state = RelayJournal.State(pid: 7, startedAt: Date(timeIntervalSince1970: 100), heartbeatAt: Date(timeIntervalSince1970: 160), cleanExit: true)
        RelayJournal.writeState(state, to: file)
        XCTAssertEqual(RelayJournal.readState(file), state)
    }

    func testAJournalLineKeepsTheLinkButNotItsQuery() {
        XCTAssertEqual(RelayJournal.describe("https://example.org/md/open?path=/secret&token=x"), "https://example.org/md/open?…")
        XCTAssertEqual(RelayJournal.describe("genesis-tools://hub"), "genesis-tools://hub")
    }
}
