import XCTest
@testable import SnapshotSupport

/// An agent must not take focus or the pointer while the user works (2026-10-23: a test run took the
/// user's focus again and again while they typed in another app).
final class ForegroundGuardTests: XCTestCase {
    func testRecentUserInputMeansTheUserIsActive() {
        XCTAssertTrue(userIsActive(idleSeconds: 0.4, threshold: 5))
        XCTAssertTrue(userIsActive(idleSeconds: 4.9, threshold: 5))
    }

    func testAQuietUserOrATurnedOffCheckIsNotActive() {
        XCTAssertFalse(userIsActive(idleSeconds: 5, threshold: 5))
        XCTAssertFalse(userIsActive(idleSeconds: 60, threshold: 5))
        XCTAssertFalse(userIsActive(idleSeconds: 0.1, threshold: 0))
        XCTAssertFalse(userIsActive(idleSeconds: .infinity, threshold: 5))
    }

    func testSyntheticInputNeverClearsRecentHumanActivity() {
        // Human input at t=0, then a background synthetic post at t=1. The server reports
        // the latter's age, which must not erase the human activity still inside the quiet time.
        XCTAssertTrue(userIsActive(idleSeconds: 0.01, threshold: 5))
        XCTAssertTrue(userIsActive(idleSeconds: 0.1, threshold: 5), "human input just after a post is active too")
        XCTAssertFalse(userIsActive(idleSeconds: 5, threshold: 5), "a full quiet period still permits foreground work")
    }

    func testTheOverrideIsAFlagTheCommandParsedNeverAValue() {
        let act = ["ax-tool", "act", "--app", "Notes", "--snapshot", "s1", "--element", "3", "--action", "type"]
        XCTAssertTrue(foregroundAllowedByArguments(act + ["--text", "hi", "--allow-foreground"]))
        XCTAssertFalse(foregroundAllowedByArguments(act + ["--text", "--allow-foreground"]),
                       "text that reads --allow-foreground is typed, not obeyed")
        XCTAssertFalse(foregroundAllowedByArguments(act + ["--value", "--allow-foreground"]))
        XCTAssertFalse(foregroundAllowedByArguments(["ax-tool", "see", "--app", "Notes", "--allow-foreground"]),
                       "see takes no such flag, so its parser refuses the line")
        XCTAssertTrue(foregroundAllowedByArguments(["ax-tool", "launch-app", "--bundle-id", "example.fixture", "--allow-foreground"]))
        XCTAssertFalse(foregroundAllowedByArguments(["ax-tool", "launch-app", "--path", "--allow-foreground"]))
        XCTAssertFalse(foregroundAllowedByArguments(["ax-tool", "type", "--text", "--allow-foreground"]),
                       "a command the runner never gives the flag does not honour it")
        XCTAssertFalse(foregroundAllowedByArguments(act + ["--text", "hi"]))
    }

    func testGlobalDispatchRefusesEvenWhenTheTargetIsAlreadyFrontmost() throws {
        var sent = 0
        var checked = 0
        let gate = ForegroundInputGate(check: {
            checked += 1
            throw UserActiveError(idleSeconds: 0.1, threshold: 5)
        })
        XCTAssertThrowsError(try gate.dispatch(background: false) { sent += 1 })
        XCTAssertEqual(checked, 1)
        XCTAssertEqual(sent, 0)
        try gate.dispatch(background: true) { sent += 1 }
        XCTAssertEqual(checked, 1, "contained background input is allowed while the user works")
        XCTAssertEqual(sent, 1)
        XCTAssertThrowsError(try gate.dispatch(background: false) { sent += 1 })
        XCTAssertEqual(sent, 1, "a background post must not admit a later global post")
    }

    func testAnAdmittedCommandCanFinishItsDoubleClickOrKeyChord() throws {
        var checked = 0
        var sent = 0
        let gate = ForegroundInputGate(check: {
            checked += 1
            if checked > 1 {
                throw UserActiveError(idleSeconds: 0.01, threshold: 5)
            }
        })
        try gate.dispatch(background: false) { sent += 1 }
        try gate.dispatch(background: false) { sent += 1 }
        XCTAssertEqual(checked, 1, "the first post resets the server's idle counter")
        XCTAssertEqual(sent, 2)
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
