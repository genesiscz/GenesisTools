import XCTest
@testable import SnapshotSupport

/// An agent must not take focus or the pointer while the user works (2026-10-23: a test run took the
/// user's focus again and again while they typed in another app).
final class ForegroundGuardTests: XCTestCase {
    func testRecentUserInputMeansTheUserIsActive() {
        XCTAssertTrue(userIsActive(idleSeconds: 0.4, ownInputAgo: nil, threshold: 5))
        XCTAssertTrue(userIsActive(idleSeconds: 4.9, ownInputAgo: 30, threshold: 5))
    }

    func testAQuietUserOrATurnedOffCheckIsNotActive() {
        XCTAssertFalse(userIsActive(idleSeconds: 5, ownInputAgo: nil, threshold: 5))
        XCTAssertFalse(userIsActive(idleSeconds: 60, ownInputAgo: nil, threshold: 5))
        XCTAssertFalse(userIsActive(idleSeconds: 0.1, ownInputAgo: nil, threshold: 0))
        XCTAssertFalse(userIsActive(idleSeconds: .infinity, ownInputAgo: nil, threshold: 5))
    }

    /// The window server counts the agent's own synthetic click as input; it must not read as the user.
    func testTheAgentsOwnLastPostIsNotTheUser() {
        XCTAssertFalse(userIsActive(idleSeconds: 1.0, ownInputAgo: 1.0, threshold: 5))
        XCTAssertFalse(userIsActive(idleSeconds: 0.9, ownInputAgo: 1.1, threshold: 5), "within the 0.3 s slack")
        XCTAssertTrue(userIsActive(idleSeconds: 0.5, ownInputAgo: 2.0, threshold: 5), "the user typed after the agent")
    }

    func testOnlyTheRunnerTurnsTheGuardOnAndATypoKeepsTheDefault() {
        XCTAssertTrue(foregroundGuardEnabled(["GENESIS_CONTROL_FOREGROUND_GUARD": "1"]))
        XCTAssertFalse(foregroundGuardEnabled([:]), "a person running the command is never refused")
        XCTAssertEqual(foregroundIdleThreshold([:]), defaultForegroundIdleSeconds)
        XCTAssertEqual(foregroundIdleThreshold(["GENESIS_CONTROL_FOREGROUND_IDLE": "0"]), 0)
        XCTAssertEqual(foregroundIdleThreshold(["GENESIS_CONTROL_FOREGROUND_IDLE": "2.5"]), 2.5)
        XCTAssertEqual(foregroundIdleThreshold(["GENESIS_CONTROL_FOREGROUND_IDLE": "five"]), defaultForegroundIdleSeconds)
        XCTAssertTrue(foregroundAllowedByEnvironment(["GENESIS_CONTROL_ALLOW_FOREGROUND": "yes"]))
        XCTAssertFalse(foregroundAllowedByEnvironment(["GENESIS_CONTROL_ALLOW_FOREGROUND": "0"]))
    }

    func testTheRefusalNamesTheBackgroundPathsAndTheOverride() {
        let message = UserActiveError(idleSeconds: 1.24, threshold: 5).localizedDescription
        for expected in ["1.2 s ago", "press_key with activate:false", "launch_app with activate:false",
                         "allow_foreground:true", "GENESIS_CONTROL_FOREGROUND_IDLE=0"] {
            XCTAssertTrue(message.contains(expected), "\(expected) in: \(message)")
        }
        XCTAssertEqual(UserActiveError(idleSeconds: 1, threshold: 5).category.rawValue, "user_active")
    }

    func testTheGateReportsEveryPostSoTheAgentsInputIsKnown() throws {
        var reports = 0
        let gate = SyntheticInputGate(tookOver: { false }, onPost: { reports += 1 })
        try gate.post {}
        let held = try gate.press({}, release: {})
        gate.release(held)
        gate.deliver {}
        XCTAssertEqual(reports, 4)
        XCTAssertEqual(gate.posted, 4)
    }
}
