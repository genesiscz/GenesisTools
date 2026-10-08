// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusOrchestratorTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

@MainActor
final class FocusOrchestratorTests: XCTestCase {
    private var tempDir: URL!
    private var orch: FocusOrchestrator!
    private var openedURLs: [URL] = []

    override func setUp() async throws {
        try await super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("genesis-focus-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        FlowFocusConfiguration.shared = FlowFocusConfiguration(directory: tempDir)
        FlowFocusConfiguration.shared.allowsWrites = true
        FocusOrchestrator.shared = FocusOrchestrator(stateURL: tempDir.appendingPathComponent("shared-focus.json"), openURL: { _ in })
        openedURLs = []
        orch = FocusOrchestrator(
            stateURL: tempDir.appendingPathComponent("focus-snapshot.json"),
            openURL: { [weak self] url in self?.openedURLs.append(url) }
        )
        // Isolate mode label from other tests / host machine defaults.
        orch.setModeLabel(FocusOrchestrator.ModeLabel.off)
    }

    override func tearDown() async throws {
        await FlowFocusConfiguration.shared.flush()
        try? FileManager.default.removeItem(at: tempDir)
        // Restore shared mode label so parallel host runs stay clean.
        FocusOrchestrator.shared.setModeLabel(FocusOrchestrator.ModeLabel.off)
        _ = try? FocusOrchestrator.shared.endSession()
        try await super.tearDown()
    }

    // T1 — begin writes file; end removes
    func testBeginWritesAndEndRemovesSnapshotFile() throws {
        orch.setModeLabel("do-not-disturb")
        let snap = try orch.beginSession(reason: "test")
        XCTAssertEqual(snap.previousMode, "do-not-disturb")
        XCTAssertTrue(FileManager.default.fileExists(atPath: orch.stateURL.path))
        XCTAssertTrue(orch.isActive)
        XCTAssertTrue(orch.suppressesSystemNotifications)

        let ended = try orch.endSession()
        XCTAssertEqual(ended?.previousMode, "do-not-disturb")
        XCTAssertFalse(FileManager.default.fileExists(atPath: orch.stateURL.path))
        XCTAssertFalse(orch.isActive)
        XCTAssertFalse(orch.suppressesSystemNotifications)
        XCTAssertEqual(orch.currentModeLabel(), "do-not-disturb")
    }

    // T2 — previousMode preserved across session
    func testPreviousModePreserved() throws {
        orch.setModeLabel("work")
        _ = try orch.beginSession(reason: "voice")
        XCTAssertEqual(orch.currentModeLabel(), FocusOrchestrator.ModeLabel.genesisListening)
        let ended = try orch.endSession()
        XCTAssertEqual(ended?.previousMode, "work")
        XCTAssertEqual(orch.currentModeLabel(), "work")
    }

    func testEndWithoutBeginReturnsNil() throws {
        XCTAssertNil(try orch.endSession())
        XCTAssertFalse(orch.isActive)
    }

    func testBeginIsIdempotentWhileActive() throws {
        orch.setModeLabel("off")
        let first = try orch.beginSession(reason: "a")
        let second = try orch.beginSession(reason: "b")
        XCTAssertEqual(first.reason, "a")
        XCTAssertEqual(second.reason, "a")
        XCTAssertEqual(first.setAt, second.setAt)
        _ = try orch.endSession()
    }

    func testSnapshotEncodesIntegrationAndSuppression() throws {
        let snap = try orch.beginSession(reason: "encode-check")
        XCTAssertEqual(snap.integration, FocusOrchestrator.Integration.appLocal.rawValue)
        XCTAssertTrue(snap.suppressSystemNotifications)
        let loaded = try orch.loadSnapshot()
        XCTAssertEqual(loaded, snap)
        _ = try orch.endSession()
    }

    // Launch recovery — dangling snapshot cleared + notice set
    func testRecoverIfNeededClearsDanglingSnapshot() throws {
        orch.setModeLabel("personal")
        _ = try orch.beginSession(reason: "crashed-voice")
        // Simulate process death: live state gone, file remains.
        // New orchestrator instance pointing at same file.
        let recovered = FocusOrchestrator(
            stateURL: orch.stateURL,
            openURL: { _ in }
        )
        // Force "stale" live flags off before recovery.
        XCTAssertTrue(FileManager.default.fileExists(atPath: recovered.stateURL.path))
        let snap = recovered.recoverIfNeeded()
        XCTAssertEqual(snap?.previousMode, "personal")
        XCTAssertEqual(snap?.reason, "crashed-voice")
        XCTAssertFalse(FileManager.default.fileExists(atPath: recovered.stateURL.path))
        XCTAssertFalse(recovered.isActive)
        XCTAssertFalse(recovered.suppressesSystemNotifications)
        XCTAssertEqual(recovered.currentModeLabel(), "personal")
        XCTAssertNotNil(recovered.recoveryNotice)
        recovered.clearRecoveryNotice()
        XCTAssertNil(recovered.recoveryNotice)
    }

    func testRecoverIfNeededNoopWhenNoSnapshot() {
        let snap = orch.recoverIfNeeded()
        XCTAssertNil(snap)
        XCTAssertNil(orch.recoveryNotice)
    }

    func testCorruptSnapshotRecoveryClearsFile() throws {
        try Data("not-json".utf8).write(to: orch.stateURL)
        let snap = orch.recoverIfNeeded()
        XCTAssertNil(snap)
        XCTAssertFalse(FileManager.default.fileExists(atPath: orch.stateURL.path))
        XCTAssertNotNil(orch.recoveryNotice)
    }

    func testShortcutURLOpenedWhenConfigured() throws {
        // Write config via ConfigStore so focusShortcutName getter sees it.
        FlowFocusConfiguration.shared.setAppValue("Genesis Voice Focus", forKey: FocusOrchestrator.ConfigKey.focusShortcutName)
        defer {
            FlowFocusConfiguration.shared.setAppValue("", forKey: FocusOrchestrator.ConfigKey.focusShortcutName)
        }
        // Re-read via shared store; our orch uses FlowFocusConfiguration.shared.
        _ = try orch.beginSession(reason: "shortcut-test")
        XCTAssertEqual(openedURLs.count, 1)
        XCTAssertEqual(openedURLs.first?.scheme, "shortcuts")
        XCTAssertTrue(openedURLs.first?.absoluteString.contains("Genesis%20Voice%20Focus") == true
            || openedURLs.first?.absoluteString.contains("Genesis Voice Focus") == true
            || openedURLs.first?.query?.contains("Genesis") == true)
        _ = try orch.endSession()
        XCTAssertEqual(openedURLs.count, 2)
    }

    // Shared static API still works (compat with earlier scaffold tests)
    func testSharedStaticBeginEndLifecycle() throws {
        // Use isolated temp via rewriting shared is dangerous; test label only
        // on a dedicated instance (already covered) + mode helpers.
        FocusOrchestrator.setModeLabel("static-mode")
        XCTAssertEqual(FocusOrchestrator.currentModeLabel(), "static-mode")
        FocusOrchestrator.setModeLabel(FocusOrchestrator.ModeLabel.off)
        XCTAssertEqual(FocusOrchestrator.currentModeLabel(), FocusOrchestrator.ModeLabel.off)
    }

    // T4 — dangling file + !isActive → recover before begin preserves real previousMode
    func testBeginAfterDanglingSnapshotRecoversPreviousMode() throws {
        orch.setModeLabel("work")
        _ = try orch.beginSession(reason: "voice-crash")
        XCTAssertEqual(orch.currentModeLabel(), FocusOrchestrator.ModeLabel.genesisListening)
        // Simulate process death: new instance, live flags false, file remains.
        let next = FocusOrchestrator(
            stateURL: orch.stateURL,
            openURL: { [weak self] url in self?.openedURLs.append(url) }
        )
        XCTAssertFalse(next.isActive)
        XCTAssertTrue(FileManager.default.fileExists(atPath: next.stateURL.path))
        // Without recover-first, begin would snapshot previousMode = genesis-listening.
        let snap = try next.beginSession(reason: "voice-retry")
        XCTAssertEqual(snap.previousMode, "work")
        XCTAssertEqual(next.currentModeLabel(), FocusOrchestrator.ModeLabel.genesisListening)
        // Implicit recover inside beginSession uses skipShortcut — no contradictory
        // "notifications are active" banner while we immediately re-mute.
        XCTAssertNil(next.recoveryNotice)
        _ = try next.endSession()
        XCTAssertEqual(next.currentModeLabel(), "work")
    }

    // T4 — recover with shortcuts integration invokes openURL end phase
    func testRecoverWithShortcutsIntegrationInvokesEndPhase() throws {
        FlowFocusConfiguration.shared.setAppValue("Genesis Voice Focus", forKey: FocusOrchestrator.ConfigKey.focusShortcutName)
        defer {
            FlowFocusConfiguration.shared.setAppValue("", forKey: FocusOrchestrator.ConfigKey.focusShortcutName)
        }
        orch.setModeLabel("personal")
        _ = try orch.beginSession(reason: "shortcut-crash")
        XCTAssertEqual(openedURLs.count, 1) // begin
        openedURLs.removeAll()

        let recovered = FocusOrchestrator(
            stateURL: orch.stateURL,
            openURL: { [weak self] url in self?.openedURLs.append(url) }
        )
        let snap = recovered.recoverIfNeeded()
        XCTAssertEqual(snap?.integration, FocusOrchestrator.Integration.shortcuts.rawValue)
        XCTAssertEqual(openedURLs.count, 1)
        XCTAssertEqual(openedURLs.first?.scheme, "shortcuts")
        let q = openedURLs.first?.query ?? openedURLs.first?.absoluteString ?? ""
        XCTAssertTrue(q.contains("end") || openedURLs.first?.absoluteString.contains("text=end") == true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: recovered.stateURL.path))
        XCTAssertNotNil(recovered.recoveryNotice)
        XCTAssertTrue(recovered.recoveryNotice?.contains("notification-mute") == true)
    }

    // T8 — toggle off → beginForVoiceIfEnabled does not create snapshot
    func testBeginForVoiceIfEnabledRespectsToggleOff() throws {
        let key = FocusOrchestrator.ConfigKey.focusWhileListening
        let prior = FlowFocusConfiguration.shared.app[key] as? Bool
        FlowFocusConfiguration.shared.setAppValue(false, forKey: key)
        defer { FlowFocusConfiguration.shared.setAppValue(prior ?? true, forKey: key) }
        orch.setModeLabel("off")
        orch.beginForVoiceIfEnabled()
        XCTAssertFalse(FileManager.default.fileExists(atPath: orch.stateURL.path))
        XCTAssertFalse(orch.isActive)
        XCTAssertFalse(orch.suppressesSystemNotifications)
    }

    // T8 — toggle on → beginForVoiceIfEnabled writes snapshot
    func testBeginForVoiceIfEnabledWhenToggleOnWritesSnapshot() throws {
        let key = FocusOrchestrator.ConfigKey.focusWhileListening
        let prior = FlowFocusConfiguration.shared.app[key] as? Bool
        FlowFocusConfiguration.shared.setAppValue(true, forKey: key)
        defer { FlowFocusConfiguration.shared.setAppValue(prior ?? true, forKey: key) }
        orch.setModeLabel("off")
        orch.beginForVoiceIfEnabled()
        XCTAssertTrue(FileManager.default.fileExists(atPath: orch.stateURL.path))
        XCTAssertTrue(orch.isActive)
        XCTAssertTrue(orch.suppressesSystemNotifications)
        orch.endForVoiceIfNeeded()
        XCTAssertFalse(FileManager.default.fileExists(atPath: orch.stateURL.path))
    }
}

#if canImport(Genesis)
// MARK: - NotifyCenter mute gate (Spec 17 T8 / G7)

@MainActor
final class NotifyCenterMuteGateTests: XCTestCase {
    func testAllowsSystemDeliveryPureGate() {
        XCTAssertTrue(NotifyCenter.allowsSystemDelivery(suppressing: false))
        XCTAssertFalse(NotifyCenter.allowsSystemDelivery(suppressing: true))
    }

    func testPushSkipsSystemDeliveryWhenSuppressActive() {
        let center = NotifyCenter.shared
        center.resetSystemDeliveryMetrics()
        var delivered: [NotifyItem] = []
        center.systemDeliverHandler = { delivered.append($0) }
        center.isSystemSuppressed = { true }
        defer {
            center.systemDeliverHandler = nil
            center.isSystemSuppressed = { FocusOrchestrator.shared.suppressesSystemNotifications }
            center.resetSystemDeliveryMetrics()
        }

        center.push(NotifyItem(title: "muted", body: "should not reach system", level: .info))
        XCTAssertEqual(center.systemDeliveryCount, 0, "suppress active must short-circuit system delivery")
        XCTAssertTrue(delivered.isEmpty)
        // In-app overlay still receives the item.
        XCTAssertTrue(center.items.contains(where: { $0.title == "muted" }))
    }

    func testPushDeliversSystemWhenNotSuppressed() {
        let center = NotifyCenter.shared
        center.resetSystemDeliveryMetrics()
        var delivered: [NotifyItem] = []
        center.systemDeliverHandler = { delivered.append($0) }
        center.isSystemSuppressed = { false }
        defer {
            center.systemDeliverHandler = nil
            center.isSystemSuppressed = { FocusOrchestrator.shared.suppressesSystemNotifications }
            center.resetSystemDeliveryMetrics()
        }

        center.push(NotifyItem(title: "live", body: "ok", level: .info))
        XCTAssertEqual(center.systemDeliveryCount, 1)
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(delivered.first?.title, "live")
    }
}
#endif
