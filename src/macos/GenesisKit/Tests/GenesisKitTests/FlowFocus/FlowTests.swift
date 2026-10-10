// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FlowTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import AVFoundation
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// Flow (dictation) — the pure text and bookkeeping logic.
///
/// Everything here runs without a microphone, without Accessibility, and
/// without touching the user's real `~/.genesis/flow`. The audio and injection
/// paths need a live machine and are covered by the UI harness instead.
final class FlowTests: XCTestCase {

    @MainActor
    func testDeletingHistoryAlsoRemovesTheRawTranscriptEvents() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-retention-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let store = FlowStore(directory: root)
        let first = FlowEntry(text: "First output", rawText: "First raw fixture", targetBundleId: nil,
                              targetAppName: nil, durationSeconds: 2, injected: false, wordCount: 2)
        let second = FlowEntry(text: "Second output", rawText: "Second raw fixture", targetBundleId: nil,
                               targetAppName: nil, durationSeconds: 3, injected: false, wordCount: 2)
        store.saveHistory([first, second])
        FlowEvents.publish(first)
        FlowEvents.publish(second)
        let session = FlowSession(store: store)
        session.deleteEntry(first.id)
        let remaining = try String(contentsOf: FlowEvents.logURL, encoding: .utf8)
        XCTAssertFalse(remaining.contains(first.rawText))
        XCTAssertTrue(remaining.contains(second.rawText), "deleting one turn preserves other event consumers' data")
        session.clearHistory()
        XCTAssertTrue(try Data(contentsOf: FlowEvents.logURL).isEmpty)
        XCTAssertTrue(store.loadHistory().isEmpty)
    }

    @MainActor
    func testFailedEventRetentionKeepsHistoryRetryableAfterRepair() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-retention-retry-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let store = FlowStore(directory: root)
        let entry = FlowEntry(text: "Retry fixture", rawText: "Raw retry fixture", targetBundleId: nil,
                              targetAppName: nil, durationSeconds: 2, injected: false, wordCount: 2)
        let kept = FlowEntry(text: "Kept fixture", rawText: "Raw kept fixture", targetBundleId: nil,
                             targetAppName: nil, durationSeconds: 1, injected: false, wordCount: 2)
        store.saveHistory([entry, kept])
        FlowEvents.publish(entry)
        FlowEvents.publish(kept)
        let saved = try Data(contentsOf: FlowEvents.logURL)
        FlowStore(directory: root, writesEnabled: false).saveHistory([])
        XCTAssertEqual(try Data(contentsOf: FlowEvents.logURL), saved, "a passive writer cannot compact the event log")
        XCTAssertEqual(store.loadHistory().map(\.id), [entry.id, kept.id])
        try FileManager.default.removeItem(at: FlowEvents.logURL)
        try FileManager.default.createDirectory(at: FlowEvents.logURL, withIntermediateDirectories: false)
        let session = FlowSession(store: store)
        session.configure(store: store)
        XCTAssertThrowsError(try store.verifyingWrites { session.deleteEntry(entry.id) })
        XCTAssertEqual(store.loadHistory().map(\.id), [entry.id, kept.id], "failed compaction keeps the primary history and its retry identity")
        XCTAssertEqual(session.history.map(\.id), [entry.id, kept.id])
        XCTAssertNotNil(session.lastError)
        try FileManager.default.removeItem(at: FlowEvents.logURL)
        try saved.write(to: FlowEvents.logURL)
        try store.verifyingWrites { session.deleteEntry(entry.id) }
        XCTAssertEqual(store.loadHistory().map(\.id), [kept.id])
        let remaining = try String(contentsOf: FlowEvents.logURL, encoding: .utf8)
        XCTAssertFalse(remaining.contains(entry.rawText))
        XCTAssertTrue(remaining.contains(kept.rawText))
    }

    @MainActor
    func testAppendingAnEventHardensAnExistingLogAndDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-event-mode-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        try Data().write(to: FlowEvents.logURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: FlowEvents.logURL.path)
        FlowEvents.publish(FlowEntry(text: "Fixture", rawText: "Fixture", targetBundleId: nil,
                                     targetAppName: nil, durationSeconds: 1, injected: false, wordCount: 1))
        let file = try FileManager.default.attributesOfItem(atPath: FlowEvents.logURL.path)
        let folder = try FileManager.default.attributesOfItem(atPath: root.path)
        XCTAssertEqual((file[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((folder[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertFalse(try Data(contentsOf: FlowEvents.logURL).isEmpty)
    }

    @MainActor
    func testDeletingAndClearingHistoryAdjustsLifetimeInsights() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-insights-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        let older = FlowEntry(text: "Older fixture", rawText: "Older fixture", targetBundleId: nil,
                              targetAppName: nil, createdAt: Date(timeIntervalSince1970: 1_800_000_000),
                              durationSeconds: 2, injected: false, wordCount: 2)
        let newer = FlowEntry(text: "Newer fixture words", rawText: "Newer fixture words", targetBundleId: nil,
                              targetAppName: nil, createdAt: older.createdAt.addingTimeInterval(86_400),
                              durationSeconds: 3, injected: false, wordCount: 3)
        store.saveHistory([newer, older])
        store.saveStats(FlowStats(totalWords: 5, totalSeconds: 5, sessionCount: 2, dayStreak: 2, lastDictationAt: newer.createdAt))
        let session = FlowSession(store: store)
        session.deleteEntry(older.id)
        XCTAssertEqual(session.stats.totalWords, 3)
        XCTAssertEqual(session.stats.totalSeconds, 3)
        XCTAssertEqual(session.stats.sessionCount, 1)
        XCTAssertEqual(session.stats.dayStreak, 1)
        session.clearHistory()
        XCTAssertEqual(session.stats, FlowStats())
        XCTAssertEqual(store.loadStats(), FlowStats())
    }

    @MainActor
    func testAutomaticRetentionAndReloadPreserveAgedOutLifetimeCounters() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-lifetime-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        let retained = FlowEntry(text: "Retained fixture words", rawText: "Retained fixture words", targetBundleId: nil,
                                 targetAppName: nil, createdAt: Date(timeIntervalSince1970: 1_800_000_000),
                                 durationSeconds: 3, injected: false, wordCount: 3)
        let agedOut = FlowEntry(text: "Older fixture", rawText: "Older fixture", targetBundleId: nil,
                                targetAppName: nil, createdAt: retained.createdAt.addingTimeInterval(-86_400),
                                durationSeconds: 2, injected: false, wordCount: 2)
        let lifetime = FlowStats(totalWords: 1_000, totalSeconds: 100, sessionCount: 500,
                                 dayStreak: 12, lastDictationAt: retained.createdAt)
        store.saveHistory([retained, agedOut])
        store.saveStats(lifetime)
        let session = FlowSession(store: store)
        XCTAssertEqual(session.stats, lifetime)
        store.saveHistory([retained])
        session.reloadStoredState()
        XCTAssertEqual(session.stats, lifetime, "trimming old transcript text is not an Insights reset")
        session.deleteEntry(retained.id)
        XCTAssertEqual(session.stats.totalWords, 997)
        XCTAssertEqual(session.stats.totalSeconds, 97)
        XCTAssertEqual(session.stats.sessionCount, 499)
        session.clearHistory()
        XCTAssertEqual(session.stats, FlowStats())
    }

    @MainActor
    func testHistoryAndStatsRecoverTogetherAfterEveryPersistenceBoundary() throws {
        for operation in ["append", "delete", "clear"] {
            for boundary in ["history-pending.json", "history.json", "stats.json", "history-revision", "journal-removal"] {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-transaction-\(UUID())")
                defer { try? FileManager.default.removeItem(at: root) }
                let store = FlowStore(directory: root)
                let first = FlowEntry(text: "First fixture", rawText: "First fixture", targetBundleId: nil,
                                      targetAppName: nil, createdAt: Date(timeIntervalSince1970: 1_800_000_000),
                                      durationSeconds: 2, injected: false, wordCount: 2)
                let second = FlowEntry(text: "Second fixture", rawText: "Second fixture", targetBundleId: nil,
                                       targetAppName: nil, createdAt: first.createdAt.addingTimeInterval(5),
                                       durationSeconds: 3, injected: false, wordCount: 2)
                let oldHistory = [first]
                let oldStats = FlowStats(totalWords: 1_002, totalSeconds: 102, sessionCount: 501,
                                         dayStreak: 1, lastDictationAt: first.createdAt)
                store.saveHistory(oldHistory)
                store.saveStats(oldStats)
                let session = FlowSession(store: store)
                var changeNotifications = 0
                store.didWrite = { changeNotifications += 1 }
                let nextHistory = operation == "append" ? [second, first] : []
                let nextStats: FlowStats
                if operation == "append" {
                    nextStats = FlowStats(totalWords: 1_004, totalSeconds: 105, sessionCount: 502,
                                          dayStreak: 1, lastDictationAt: second.createdAt)
                } else if operation == "delete" {
                    nextStats = oldStats.removing(first, remainingHistory: [])
                } else {
                    nextStats = FlowStats()
                }
                let blocked = root.appendingPathComponent(boundary)
                let backup = root.appendingPathComponent("original-\(boundary)")
                if boundary == "journal-removal" {
                    store.beforeHistoryJournalRemoval = { throw CocoaError(.fileWriteNoPermission) }
                } else {
                    var obstructed = false
                    store.beforeOwnedWrite = { name in
                        guard name == boundary, !obstructed else { return }
                        obstructed = true
                        if FileManager.default.fileExists(atPath: blocked.path) {
                            try FileManager.default.moveItem(at: blocked, to: backup)
                        }
                        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: false)
                    }
                }
                func mutate() {
                    switch operation {
                    case "delete": session.deleteEntry(first.id)
                    case "clear": session.clearHistory()
                    default: store.saveHistoryAndStats(history: nextHistory, stats: nextStats)
                    }
                }
                XCTAssertThrowsError(try store.verifyingWrites { mutate() }, "\(operation) / \(boundary)")
                XCTAssertEqual(changeNotifications, 0, "failed multi-file updates do not publish partial snapshots")
                if boundary != "history-pending.json" {
                    let pendingURL = root.appendingPathComponent("history-pending.json")
                    let savedPending = try Data(contentsOf: pendingURL)
                    XCTAssertFalse(store.saveHistoryAndStats(history: [], stats: FlowStats()), "an unrepaired pending update cannot be replaced")
                    XCTAssertEqual(try Data(contentsOf: pendingURL), savedPending)
                    let attrs = try FileManager.default.attributesOfItem(atPath: pendingURL.path)
                    XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
                }
                let passiveRestart = FlowStore(directory: root, writesEnabled: false)
                XCTAssertEqual(passiveRestart.loadHistory(), oldHistory, "pending readers see the prior complete pair")
                XCTAssertEqual(passiveRestart.loadStats(), oldStats)
                if boundary != "history-pending.json" {
                    let pair = try passiveRestart.loadHistoryAndStats()
                    XCTAssertEqual(pair.history, oldHistory)
                    XCTAssertEqual(pair.stats, oldStats)
                    let passiveSession = FlowSession(store: passiveRestart)
                    XCTAssertEqual(passiveSession.history, oldHistory)
                    XCTAssertEqual(passiveSession.stats, oldStats)
                    XCTAssertNil(passiveSession.lastError)
                }
                if boundary == "journal-removal" {
                    store.beforeHistoryJournalRemoval = nil
                } else {
                    try FileManager.default.removeItem(at: blocked)
                    if FileManager.default.fileExists(atPath: backup.path) {
                        try FileManager.default.moveItem(at: backup, to: blocked)
                    }
                }
                store.beforeOwnedWrite = nil
                if boundary == "history-pending.json" {
                    try store.verifyingWrites { mutate() }
                }
                let restarted = FlowSession(store: FlowStore(directory: root))
                XCTAssertEqual(restarted.history, nextHistory, "\(operation) / \(boundary)")
                XCTAssertEqual(restarted.stats, nextStats, "\(operation) / \(boundary)")
                XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("history-pending.json").path))
                if operation == "delete" {
                    restarted.deleteEntry(first.id)
                    XCTAssertEqual(restarted.stats, nextStats, "retry never subtracts the same turn twice")
                }
                if operation == "clear" {
                    restarted.clearHistory()
                    XCTAssertEqual(restarted.stats, nextStats)
                }
            }
        }
    }

    @MainActor
    func testSuccessfulHistoryPairPublishesOnceAndKeepsLegacyFilesReadable() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-pair-success-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        let entry = FlowEntry(text: "Fixture", rawText: "Fixture", targetBundleId: nil,
                              targetAppName: nil, createdAt: Date(timeIntervalSince1970: 1_800_000_000),
                              durationSeconds: 2, injected: false, wordCount: 1)
        let stats = FlowStats(totalWords: 101, totalSeconds: 102, sessionCount: 51,
                              dayStreak: 1, lastDictationAt: entry.createdAt)
        var notifications = 0
        store.didWrite = { notifications += 1 }
        XCTAssertTrue(store.saveHistoryAndStats(history: [entry], stats: stats))
        XCTAssertEqual(notifications, 1)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        XCTAssertEqual(try decoder.decode([FlowEntry].self, from: Data(contentsOf: root.appendingPathComponent("history.json"))), [entry])
        XCTAssertEqual(try decoder.decode(FlowStats.self, from: Data(contentsOf: root.appendingPathComponent("stats.json"))), stats)
    }

    @MainActor
    func testPairedReadRetriesWhenOwnerSettlesBetweenTheLegacyReads() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-coherent-read-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = FlowStore(directory: root)
        let first = FlowEntry(text: "Old fixture", rawText: "Old fixture", targetBundleId: nil,
                              targetAppName: nil, createdAt: Date(timeIntervalSince1970: 1_800_000_000),
                              durationSeconds: 2, injected: false, wordCount: 2)
        let next = FlowEntry(text: "Next fixture", rawText: "Next fixture", targetBundleId: nil,
                             targetAppName: nil, createdAt: first.createdAt.addingTimeInterval(5),
                             durationSeconds: 3, injected: false, wordCount: 2)
        let oldStats = FlowStats(totalWords: 1_002, totalSeconds: 102, sessionCount: 501)
        let newStats = FlowStats(totalWords: 1_004, totalSeconds: 105, sessionCount: 502)
        XCTAssertTrue(owner.saveHistoryAndStats(history: [first], stats: oldStats))
        let reader = FlowStore(directory: root, writesEnabled: false)
        var reads = 0
        reader.betweenHistoryAndStatsRead = {
            reads += 1
            if reads == 1 { XCTAssertTrue(owner.saveHistoryAndStats(history: [next, first], stats: newStats)) }
        }
        let snapshot = try reader.loadHistoryAndStats()
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(snapshot.history, [next, first])
        XCTAssertEqual(snapshot.stats, newStats)
        XCTAssertTrue(owner.saveHistoryAndStats(history: [first], stats: oldStats))
        reads = 0
        let session = FlowSession(store: reader)
        XCTAssertEqual(session.history, [next, first], "initialization uses the paired read")
        XCTAssertEqual(session.stats, newStats)
        XCTAssertTrue(owner.saveHistoryAndStats(history: [first], stats: oldStats))
        reads = 0
        session.reloadStoredState()
        XCTAssertEqual(session.history, [next, first], "reload uses the paired read")
        XCTAssertEqual(session.stats, newStats)
        reads = 0
        reader.betweenHistoryAndStatsRead = {
            reads += 1
            XCTAssertTrue(owner.saveHistoryAndStats(history: [first], stats: oldStats))
        }
        XCTAssertThrowsError(try reader.loadHistoryAndStats())
        XCTAssertEqual(reads, 4, "contention has a fixed read budget, never a wait loop")
        session.reloadStoredState()
        XCTAssertEqual(session.history, [next, first], "an exhausted snapshot preserves the previously complete UI pair")
        XCTAssertEqual(session.stats, newStats)
        XCTAssertNotNil(session.lastError)
    }

    // MARK: - Starting a turn

    /// eve on PR #85 t3: the menu bar and the palette reached `beginTurn` with Flow's own Enabled
    /// switch off, and it opened the microphone. Every entry point starts a turn through this.
    func testATurnDoesNotStartWhileDictationIsOff() {
        XCTAssertEqual(
            FlowSession.turnStart(phase: .idle, labEnabled: true, enabled: false),
            .off("Dictation is off in Dictation → Settings.")
        )
        XCTAssertEqual(
            FlowSession.turnStart(phase: .error, labEnabled: false, enabled: true),
            .off("Dictation is off in Settings → Labs.")
        )
        XCTAssertEqual(FlowSession.turnStart(phase: .idle, labEnabled: true, enabled: true), .begin)
        XCTAssertEqual(FlowSession.turnStart(phase: .error, labEnabled: true, enabled: true), .begin)
        XCTAssertEqual(FlowSession.turnStart(phase: .listening, labEnabled: true, enabled: false), .busy, "a press during a turn starts nothing")
        XCTAssertNil(FlowSession.offReason(labEnabled: true, enabled: true))
    }

    @MainActor
    func testThePasteIsReportedOnlyWhenTheTargetIsStillFrontmost() async {
        var pasted = 0
        let moved = await FlowInjector.pasteAfterActivation(target: 42, written: 3, changeCount: { 3 }, frontmost: { 7 },
                                                            paste: { pasted += 1 })
        XCTAssertEqual(moved, .focusMoved)
        XCTAssertEqual(pasted, 0, "no keystroke reaches another app")
        let replaced = await FlowInjector.pasteAfterActivation(target: 42, written: 3, changeCount: { 4 },
                                                               frontmost: { 42 }, paste: { pasted += 1 })
        XCTAssertEqual(replaced, .clipboardChanged, "a copy made during the wait is never pasted in the transcript's place")
        XCTAssertEqual(pasted, 0)
        let landed = await FlowInjector.pasteAfterActivation(target: 42, written: 3, changeCount: { 3 },
                                                             frontmost: { 42 }, paste: { pasted += 1 })
        XCTAssertEqual(landed, .injected)
        XCTAssertEqual(pasted, 1)
    }

    @MainActor
    func testATurnsTranscriptEventGoesToItsOwnStoreNotTheProcessDefault() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-scoped-events-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        // Another runtime in this process points the default somewhere else.
        FlowEvents.logURL = root.appendingPathComponent("other/events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let store = FlowStore(directory: root.appendingPathComponent("mine"))
        let session = FlowSession(store: store)
        session.injectEffect = { _ in .copiedOnly }
        await session.completeTurn(raw: "scoped fixture")
        XCTAssertTrue(try String(contentsOf: store.eventsURL, encoding: .utf8).contains("scoped fixture"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: FlowEvents.logURL.path))
        session.clearHistory()
        XCTAssertTrue(try Data(contentsOf: store.eventsURL).isEmpty, "deleting history reaches the events it wrote")
    }

    @MainActor
    func testRemovingTheLatestTurnAlsoRemovesItFromTheLiveSnapshot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-clear-live-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = FlowSession(store: FlowStore(directory: root))
        session.injectEffect = { _ in .copiedOnly }
        await session.completeTurn(raw: "older fixture")
        await session.completeTurn(raw: "private fixture")
        session.recognizer.applyRemote(partialText: "private fixture", micLevel: 0)
        let older = try XCTUnwrap(session.history.last)
        session.deleteEntry(older.id)
        XCTAssertEqual(session.liveSnapshot.lastInjected, "private fixture", "deleting an older turn leaves the latest shown")
        session.deleteEntry(try XCTUnwrap(session.history.first).id)
        XCTAssertNil(session.liveSnapshot.lastInjected)
        XCTAssertEqual(session.liveSnapshot.partialText, "")

        await session.completeTurn(raw: "another private fixture")
        session.recognizer.applyRemote(partialText: "another private fixture", micLevel: 0)
        session.clearHistory()
        XCTAssertNil(session.liveSnapshot.lastInjected, "the published snapshot no longer carries the cleared text")
        XCTAssertEqual(session.liveSnapshot.partialText, "")
    }

    @MainActor
    func testTrailingGraceOutsideItsRangeIsRefusedBeforeItIsStored() throws {
        func decode(_ grace: String) throws -> FlowConfig {
            try JSONDecoder().decode(FlowConfig.self, from: Data("{\"trailingGraceMs\": \(grace), \"localeIdentifier\": \"cs-CZ\"}".utf8))
        }
        // A configuration saved before the range existed is migrated into it, keeping every other setting.
        XCTAssertEqual(try decode("18446744073710").trailingGraceMs, 2_000, "a value that would trap on key release")
        XCTAssertEqual(try decode("5000").trailingGraceMs, 2_000)
        XCTAssertEqual(try decode("5000").localeIdentifier, "cs-CZ", "the rest of the stored configuration survives")
        XCTAssertEqual(try decode("-1").trailingGraceMs, 0)
        XCTAssertEqual(try decode("2000").trailingGraceMs, 2_000)

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-grace-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = FlowSession(store: FlowStore(directory: root))
        session.config.trailingGraceMs = 60_000
        XCTAssertEqual(session.config.trailingGraceMs, 350, "the owner's setter keeps the previous value")
        XCTAssertNotNil(session.lastError)
    }

    @MainActor
    func testACopyMadeWhileTheTargetActivatesIsNeverPasted() async {
        let board = NSPasteboard(name: NSPasteboard.Name("flow-test-\(UUID().uuidString)"))
        defer { board.releaseGlobally() }
        var pasted = 0
        let target = FlowFocusTarget(bundleIdentifier: "test.target", localizedName: "Target", processIdentifier: 4242)
        var seams = FlowInjector.Seams()
        seams.pasteboard = board
        // Another process copies something while the target is being activated.
        seams.reactivate = { _ in
            board.clearContents()
            board.setString("copied meanwhile", forType: .string)
            return true
        }
        seams.trusted = { true }
        seams.frontmost = { 4242 }
        seams.paste = { pasted += 1 }
        let replaced = await FlowInjector.inject("fixture transcript", into: target, usePaste: true,
                                                 restoreClipboard: false, seams: seams)
        XCTAssertEqual(replaced, .clipboardChanged)
        XCTAssertEqual(pasted, 0, "the copy made during activation is never pasted as the transcript")

        seams.reactivate = { _ in true }
        let landed = await FlowInjector.inject("fixture transcript", into: target, usePaste: true,
                                               restoreClipboard: false, seams: seams)
        XCTAssertEqual(landed, .injected, "an untouched clipboard still pastes")
        XCTAssertEqual(pasted, 1)
    }

    @MainActor
    func testAPasteWithheldForAChangedClipboardIsNotShownAsInserted() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-clipboard-changed-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let session = FlowSession(store: FlowStore(directory: root))
        session.injectEffect = { _ in .clipboardChanged }
        await session.completeTurn(raw: "withheld fixture")
        XCTAssertNil(session.lastInjected, "nothing was pasted and nothing is on the clipboard")
        XCTAssertEqual(session.history.first?.text, "withheld fixture", "history keeps the transcript")
        XCTAssertEqual(session.history.first?.injected, false)
    }

    @MainActor
    func testAWithheldPasteIsRecordedAsCopiedNotInserted() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-withheld-paste-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let session = FlowSession(store: FlowStore(directory: root))
        session.injectEffect = { _ in .focusMoved }
        await session.completeTurn(raw: "hello there")
        XCTAssertEqual(session.history.first?.injected, false)
        XCTAssertTrue(session.lastError?.contains("copied to the clipboard") == true)
        session.injectEffect = { _ in .injected }
        await session.completeTurn(raw: "hello again")
        XCTAssertEqual(session.history.first?.injected, true, "a paste that was sent is still recorded as inserted")
        XCTAssertNil(session.lastError)
    }

    @MainActor
    func testACompletionResumingAfterItsTurnWasCancelledChangesNothing() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-stale-completion-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let previousURL = FlowEvents.logURL
        FlowEvents.logURL = root.appendingPathComponent("events.jsonl")
        defer { FlowEvents.logURL = previousURL }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = false
        store.saveConfig(config)
        let session = FlowSession(store: store)
        session.preRollEffect = { _ in }
        session.hotkeyBindingEffect = {}
        session.recognitionStartEffect = {}
        session.start()
        defer { session.stop() }
        var release: CheckedContinuation<FlowInjectOutcome, Never>?
        session.injectEffect = { _ in await withCheckedContinuation { release = $0 } }
        let completing = Task { await session.completeTurn(raw: "the cancelled turn") }
        for _ in 0..<1_000 where release == nil { await Task.yield() }
        let paste = try XCTUnwrap(release, "the completion waits in the paste")
        session.cancelTurn()
        session.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(session.phase, .listening)
        paste.resume(returning: .injected)
        await completing.value
        XCTAssertEqual(session.phase, .listening, "the new turn keeps listening")
        XCTAssertTrue(session.history.isEmpty, "the cancelled transcript is not recorded")
        XCTAssertNil(session.lastInjected)
    }

    @MainActor
    func testPreRollReachesATurnWhenDictationWasOffAtLaunch() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-preroll-enabled-later-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = false
        config.preRoll = true
        config.enabled = false
        store.saveConfig(config)
        let session = FlowSession(store: store)
        var rolling = false
        session.preRollEffect = { rolling = $0 }
        session.hotkeyBindingEffect = {}
        session.start()
        defer { session.stop() }
        XCTAssertFalse(rolling)
        session.config.enabled = true
        XCTAssertTrue(rolling)
        session.preRoll.record(try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!, frameCapacity: 16)))
        var handed = -1
        session.recognitionStartEffect = { [weak session] in
            handed = session?.recognizer.preRollProvider?().count ?? -1
        }
        session.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(handed, 1, "the audio held before the press reaches the recogniser")
    }

    func testTheWidgetShowsWhatWasInsertedOnceTheTurnEnds() {
        // The recogniser keeps the raw partial text after finish(); the rewritten text is what landed.
        let shown = FlowWidgetTranscript.shown(phase: .idle, partial: "brb", last: "be right back")
        XCTAssertEqual(shown?.text, "be right back")
        XCTAssertEqual(FlowWidgetTranscript.shown(phase: .listening, partial: "brb", last: "earlier")?.text, "brb",
                       "a running turn shows what is being heard")
        XCTAssertNil(FlowWidgetTranscript.shown(phase: .transcribing, partial: "", last: "earlier"),
                     "a new turn never shows the previous turn's text")
        XCTAssertNil(FlowWidgetTranscript.shown(phase: .error, partial: "stale", last: nil))
    }

    @MainActor
    func testTurningThePillOffMidTurnHidesThePillOnScreen() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flow-pill-setting-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FlowStore(directory: root)
        var config = FlowConfig()
        config.showPill = true
        store.saveConfig(config)
        let session = FlowSession(store: store)
        var shown: [Bool] = []
        session.pillEffect = { shown.append($0) }
        session.preRollEffect = { _ in }
        session.hotkeyBindingEffect = {}
        session.recognitionStartEffect = {}
        session.start()
        defer { session.stop() }
        session.beginTurn(captureCurrentTarget: false)
        XCTAssertEqual(session.phase, .listening)
        XCTAssertEqual(shown, [true])
        session.config.showPill = false
        XCTAssertEqual(shown, [true, false], "the pill must not stay on screen until the runtime stops")
        session.cancelTurn()
        XCTAssertFalse(shown.dropFirst().contains(true), "with the setting off, later phases never show it again")
    }

    // MARK: - Dictionary replacement

    func testAppliesReplacementOnWordBoundary() {
        let rules = [FlowDictionaryRule(from: "next js", to: "Next.js")]
        XCTAssertEqual(
            FlowDictionary.apply(rules, to: "I used next js for this"),
            "I used Next.js for this"
        )
    }

    func testReplacementIsCaseInsensitiveButOutputIsVerbatim() {
        let rules = [FlowDictionaryRule(from: "bridge mind", to: "BridgeMind")]
        XCTAssertEqual(
            FlowDictionary.apply(rules, to: "Bridge Mind and bridge mind"),
            "BridgeMind and BridgeMind"
        )
    }

    func testReplacementDoesNotMatchInsideAWord() {
        let rules = [FlowDictionaryRule(from: "js", to: "JS")]
        // "jsonify" must survive: a bare substring replace would maul it.
        XCTAssertEqual(FlowDictionary.apply(rules, to: "jsonify the js file"), "jsonify the JS file")
    }

    /// The ordering guarantee that makes overlapping rules usable: the longest
    /// `from` wins, so a short rule cannot eat a longer rule's match first.
    func testLongestRuleWinsOverOverlappingShorterOne() {
        let rules = [
            FlowDictionaryRule(from: "js", to: "JS"),
            FlowDictionaryRule(from: "next js", to: "Next.js"),
        ]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "next js rocks"), "Next.js rocks")
    }

    func testDisabledRuleIsIgnored() {
        let rules = [FlowDictionaryRule(from: "cat", to: "dog", enabled: false)]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "the cat"), "the cat")
    }

    func testReplacementTreatsSpecialCharactersLiterally() {
        // A regex-flavoured `from` must not be compiled as a pattern.
        let rules = [FlowDictionaryRule(from: "c++", to: "C++")]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "I write c++ daily"), "I write C++ daily")
    }

    func testDollarInReplacementIsNotATemplateReference() {
        // NSRegularExpression templates treat `$1` as a capture reference;
        // a literal price must survive intact.
        let rules = [FlowDictionaryRule(from: "the price", to: "$1000")]
        XCTAssertEqual(FlowDictionary.apply(rules, to: "the price today"), "$1000 today")
    }

    // MARK: - Snippets

    func testSnippetExpands() {
        let snippets = [FlowSnippet(trigger: "my address", body: "1 Infinite Loop")]
        XCTAssertEqual(
            FlowDictionary.expand(snippets, in: "send it to my address please"),
            "send it to 1 Infinite Loop please"
        )
    }

    // MARK: - Snippet variables

    func testSnippetResolvesDateAndTimeVariables() {
        var components = DateComponents()
        components.year = 2026; components.month = 7; components.day = 29
        components.hour = 14; components.minute = 32
        let fixed = Calendar.current.date(from: components)!

        let snippets = [FlowSnippet(trigger: "log stamp", body: "[{{datetime}}]")]
        XCTAssertEqual(
            FlowDictionary.expand(snippets, in: "log stamp done", now: fixed),
            "[2026-07-29 14:32] done"
        )
    }

    func testSnippetNewlineVariableBecomesARealLineBreak() {
        let snippets = [FlowSnippet(trigger: "sign off", body: "Thanks,{{newline}}Martin")]
        XCTAssertEqual(
            FlowDictionary.expand(snippets, in: "sign off"),
            "Thanks,\nMartin"
        )
    }

    func testUnknownVariableIsLeftVisibleRatherThanBlanked() {
        // A typo must be obvious in the output, not silently delete text.
        let resolved = FlowDictionary.resolveVariables(in: "a {{nope}} b")
        XCTAssertEqual(resolved, "a {{nope}} b")
    }

    func testBodyWithoutVariablesIsUntouched() {
        XCTAssertEqual(FlowDictionary.resolveVariables(in: "plain body"), "plain body")
    }

    // MARK: - Tokenizing

    func testTokenizeDropsPunctuationShortWordsAndDigits() {
        let tokens = FlowDictionary.tokenize("The API, v2, handles OAuth — really.")
        XCTAssertTrue(tokens.contains("api"))
        XCTAssertTrue(tokens.contains("handles"))
        XCTAssertTrue(tokens.contains("oauth"))
        XCTAssertFalse(tokens.contains("v2"), "digits are not terms")
        XCTAssertFalse(tokens.contains("v"), "single letters are dropped")
        // "the" survives tokenizing on length; it is the common-word filter,
        // not the tokenizer, that keeps it out of suggestions.
        XCTAssertTrue(tokens.contains("the"))
        XCTAssertTrue(FlowDictionary.isCommonWord("the"))
    }

    // MARK: - Technical-term heuristic

    func testCommonWordsAreNotTechnical() {
        for word in ["because", "something", "really", "think"] {
            XCTAssertFalse(FlowDictionary.isLikelyTechnical(word), "\(word) should read as common")
        }
    }

    func testLowVowelDensityAndHyphensReadAsTechnical() {
        XCTAssertTrue(FlowDictionary.isLikelyTechnical("nginx"))
        XCTAssertTrue(FlowDictionary.isLikelyTechnical("read-only"))
        XCTAssertTrue(FlowDictionary.isLikelyTechnical("kubernetes"), "long and uncommon is enough")
    }

    func testVeryShortTokensAreNeverTechnical() {
        XCTAssertFalse(FlowDictionary.isLikelyTechnical("cat"))
    }

    // MARK: - Learning

    func testSuggestionIsRaisedOnlyAtTheOccurrenceThreshold() {
        var stats: [String: FlowDictionary.WordStats] = [:]
        var raised: [FlowSuggestion] = []
        for _ in 0..<2 {
            raised += FlowDictionary.learn(
                from: "deploy to kubernetes",
                stats: &stats,
                existingRules: [],
                dismissed: []
            )
        }
        XCTAssertTrue(raised.isEmpty, "two hearings is not yet a pattern")

        raised += FlowDictionary.learn(
            from: "deploy to kubernetes",
            stats: &stats,
            existingRules: [],
            dismissed: []
        )
        XCTAssertEqual(raised.map(\.heard), ["kubernetes"])
    }

    func testSuggestionIsNotRaisedTwiceForTheSameWord() {
        var stats: [String: FlowDictionary.WordStats] = [:]
        var raised: [FlowSuggestion] = []
        for _ in 0..<6 {
            raised += FlowDictionary.learn(
                from: "kubernetes again",
                stats: &stats,
                existingRules: [],
                dismissed: []
            )
        }
        XCTAssertEqual(raised.count, 1, "the threshold fires exactly once, not on every hearing after it")
    }

    func testAlreadyRuledAndDismissedWordsAreNeverSuggested() {
        var stats: [String: FlowDictionary.WordStats] = [:]
        var raised: [FlowSuggestion] = []
        for _ in 0..<4 {
            raised += FlowDictionary.learn(
                from: "kubernetes and postgres",
                stats: &stats,
                existingRules: [FlowDictionaryRule(from: "kubernetes", to: "Kubernetes")],
                dismissed: ["postgres"]
            )
        }
        XCTAssertTrue(raised.isEmpty)
    }

    // MARK: - Streak

    func testStreakStartsAtOneWithNoHistory() {
        XCTAssertEqual(FlowSession.streak(endingAt: Date(), previous: nil, current: 0), 1)
    }

    func testStreakIsUnchangedWithinTheSameDay() {
        // Anchored to midday, not to `Date()`: an hour before "now" is the PREVIOUS day for
        // the first hour after midnight, so this test was red between 00:00 and 01:00 and
        // green for the other 23 hours.
        let now = Calendar.current.startOfDay(for: Date()).addingTimeInterval(12 * 3600)
        let earlier = now.addingTimeInterval(-3600)
        XCTAssertEqual(FlowSession.streak(endingAt: now, previous: earlier, current: 4), 4)
    }

    func testStreakIncrementsOnConsecutiveDays() {
        let now = Date()
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: now)!
        XCTAssertEqual(FlowSession.streak(endingAt: now, previous: yesterday, current: 4), 5)
    }

    func testStreakResetsAfterAGap() {
        let now = Date()
        let threeDaysAgo = Calendar.current.date(byAdding: .day, value: -3, to: now)!
        XCTAssertEqual(FlowSession.streak(endingAt: now, previous: threeDaysAgo, current: 9), 1)
    }

    // MARK: - Entry maths

    func testWordsPerMinuteIsNilForTurnsTooShortToMeanAnything() {
        let entry = FlowEntry(
            text: "yes", rawText: "yes", targetBundleId: nil, targetAppName: nil,
            durationSeconds: 0.4, injected: true, wordCount: 1
        )
        XCTAssertNil(entry.wordsPerMinute, "a 0.4s 'yes' reads as 150 wpm and would skew the average")
    }

    func testWordsPerMinuteComputesForARealTurn() {
        let entry = FlowEntry(
            text: "one two three four", rawText: "one two three four",
            targetBundleId: nil, targetAppName: nil,
            durationSeconds: 60, injected: true, wordCount: 60
        )
        XCTAssertEqual(entry.wordsPerMinute ?? 0, 60, accuracy: 0.001)
    }
}
