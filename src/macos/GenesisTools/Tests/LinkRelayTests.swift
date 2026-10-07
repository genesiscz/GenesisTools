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
}
