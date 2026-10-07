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
