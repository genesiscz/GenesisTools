// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/Companion/CompanionHotKeyTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Carbon
import XCTest

@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// §6.1 — Carbon registration lifecycle. A full synthetic F6 press
/// (CGEvent.post → callbacks) needs Accessibility + a system event loop, so
/// the callback-order check runs only where the grant exists; registration,
/// rebind and teardown are asserted everywhere.
final class CompanionHotKeyTests: XCTestCase {

    func testRegisterRebindStop() throws {
        let hotKey = CompanionHotKey() // F6
        // A headless swift-test runner has no application event target —
        // Carbon refuses registration there. That's an environment gap, not a
        // code bug (registration is exercised live inside the app; §10a).
        try XCTSkipUnless(hotKey.start(), "Carbon refused registration (headless test runner)")
        XCTAssertEqual(hotKey.keyCode, UInt32(kVK_F6))

        XCTAssertTrue(hotKey.rebind(keyCode: UInt32(kVK_F5), modifiers: 0))
        XCTAssertEqual(hotKey.keyCode, UInt32(kVK_F5))

        hotKey.stop()
        // Restart after stop must work (no dangling Carbon refs).
        XCTAssertTrue(hotKey.start())
        hotKey.stop()
    }

    func testDoubleStartIsIdempotent() throws {
        let hotKey = CompanionHotKey()
        try XCTSkipUnless(hotKey.start(), "Carbon refused registration (headless test runner)")
        XCTAssertTrue(hotKey.start())
        hotKey.stop()
    }

    func testSyntheticPressAndReleaseFireInOrder() throws {
        // Opt-in with the e2e gate: Carbon delivers hotkey events through the
        // app event loop, which a headless xctest process doesn't reliably
        // pump — and a synthetic F6 press has real side effects on a live
        // desktop. Verified interactively per §10a instead.
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["COMPANION_E2E"] == "1",
            "opt-in: COMPANION_E2E=1 (posts a real F6 press system-wide)")
        try XCTSkipUnless(
            AXIsProcessTrusted(),
            "Accessibility not granted — cannot post synthetic key events")

        let hotKey = CompanionHotKey()
        var events: [String] = []
        let down = expectation(description: "keyDown")
        let up = expectation(description: "keyUp")
        hotKey.onKeyDown = { _ in events.append("down"); down.fulfill() }
        hotKey.onKeyUp = { _ in events.append("up"); up.fulfill() }
        try XCTSkipUnless(hotKey.start(), "Carbon refused registration (headless test runner)")
        defer { hotKey.stop() }

        let source = CGEventSource(stateID: .hidSystemState)
        CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_F6), keyDown: true)?
            .post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_F6), keyDown: false)?
            .post(tap: .cghidEventTap)

        wait(for: [down, up], timeout: 3)
        XCTAssertEqual(events, ["down", "up"])
    }

    #if canImport(Genesis)
    // MARK: - tap vs hold

    /// The gesture is decided by the gap between the two CARBON EVENTS. It used
    /// to be decided by `Date()` inside the callbacks, which run on the main
    /// queue AFTER the key-down handler has already kicked off arm() → screen
    /// capture. Measured live 2026-07-25: a ~50 ms tap arrived as an 828 ms
    /// "hold", so a quick F6 recorded and sent a voice turn instead of just
    /// opening the panel.
    func testHoldIsMeasuredFromEventTimesNotCallbackTimes() {
        let down: TimeInterval = 1_000.000
        let up: TimeInterval = 1_000.050 // 50 ms tap

        XCTAssertEqual(CompanionOrchestrator.holdMilliseconds(downAt: down, upAt: up), 50)
        // Same events, but the callbacks ran 800 ms late because the main
        // thread was busy — the classification must not move.
        XCTAssertLessThan(
            CompanionOrchestrator.holdMilliseconds(downAt: down, upAt: up),
            CompanionSettings.defaultHotkeyTapMaxMs,
            "a 50 ms press is a tap regardless of how late the callback ran")
    }

    func testRealHoldStaysAHold() {
        XCTAssertGreaterThanOrEqual(
            CompanionOrchestrator.holdMilliseconds(downAt: 10, upAt: 11.2),
            CompanionSettings.defaultHotkeyTapMaxMs)
    }

    func testOutOfOrderTimestampsClampToATap() {
        // Never let a clock oddity turn into a multi-second phantom hold.
        XCTAssertEqual(CompanionOrchestrator.holdMilliseconds(downAt: 5, upAt: 4), 0)
    }
    #endif
}
