import Foundation
import GenesisKitFixtures
import XCTest
@testable import GenesisKit

/// Widget preferences as the hub sends them, for test fixtures: the hub's own defaults (GenesisKitFixtures/Widget
/// `preferences-defaults.json`, written by src/hub/lib/widget/snapshot-golden.test.ts) with a test's changes on top.
/// Every field the hub defaults is non-optional in `WidgetPreferences`, so a fixture carries them all.
enum WidgetTestPreferences {
    static func dictionary(_ changes: [String: Any] = [:]) -> [String: Any] {
        do {
            let data = try KitFixture.data("preferences-defaults.json", in: "Widget")
            let defaults = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            return defaults.merging(changes) { _, new in new }
        } catch {
            XCTFail("preferences-defaults.json: \(error)")
            return changes
        }
    }

    /// One line of JSON: the defaults with the keys of the JSON object `changes` on top.
    static func json(_ changes: String = "{}") -> String {
        do {
            let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(changes.utf8)) as? [String: Any])
            let data = try JSONSerialization.data(withJSONObject: dictionary(object), options: [.sortedKeys])
            return String(decoding: data, as: UTF8.self)
        } catch {
            XCTFail("preferences \(changes): \(error)")
            return changes
        }
    }

    static func decode(_ changes: String = "{}") throws -> WidgetPreferences {
        try JSONDecoder().decode(WidgetPreferences.self, from: Data(json(changes).utf8))
    }
}

/// The preference write pipeline through its own seam: snapshots and writes in, the preferences shown and the patches
/// sent out, with no `WidgetModel`.
@MainActor
final class WidgetPreferencesStoreTests: XCTestCase {
    /// A store over a fake model: `shown` is the screen, `sent` every patch, `reports` every error it reported.
    @MainActor private final class Harness {
        var shown: WidgetPreferences?
        var sent: [[String: WidgetJSON]] = []
        var reports: [String] = []
        var readsAgain = 0
        /// Answers each send: nil completes it, an error fails it.
        var answer: () -> Error? = { nil }
        var store: WidgetPreferencesStore!

        init(stateFile: String = "/fixture/no-state.json", shown: WidgetPreferences? = .hubDefaults) {
            self.shown = shown
            store = WidgetPreferencesStore(stateFile: stateFile, wiring: .init(
                shown: { [unowned self] in self.shown },
                show: { [unowned self] preferences, _ in self.shown = preferences },
                send: { [unowned self] patch, failed, completed in
                    self.sent.append(patch)
                    if self.answer() == nil { completed() } else { failed() }
                },
                readAgain: { [unowned self] in self.readsAgain += 1 },
                report: { [unowned self] error in self.reports.append(error.localizedDescription) },
                stopping: { false }))
        }

        func state(revision: Int, _ changes: String = "{}") throws -> WidgetState {
            try JSONDecoder().decode(WidgetState.self, from: Data(
                #"{"version":1,"revision":\#(revision),"preferences":\#(WidgetTestPreferences.json(changes)),"assets":{},"drafts":{},"outgoing":[]}"#.utf8))
        }
    }

    func testEveryGoldenSnapshotDecodesIntoNonOptionalPreferencesAndTheDefaultsMatchTheHub() throws {
        let names = try KitFixture.names(in: "Widget").filter { $0.hasPrefix("snapshot-") }
        XCTAssertFalse(names.isEmpty)
        for name in names {
            let snapshot = try JSONDecoder().decode(WidgetSnapshot.self, from: KitFixture.data(name, in: "Widget"))
            XCTAssertNil(snapshot.state.preferencesUnreadable, "\(name) lacks a preference the widget reads")
        }
        let defaults = try JSONDecoder().decode(
            WidgetPreferences.self, from: KitFixture.data("preferences-defaults.json", in: "Widget"))
        XCTAssertEqual(defaults, .hubDefaults, "WidgetPreferences.hubDefaults drifted from widgetPreferencesSchema.parse({})")
    }

    func testAWriteSendsOnlyTheKeyItChanged() async throws {
        let harness = Harness()
        harness.store.write { $0.inboxFilter = "inbox" }
        XCTAssertEqual(harness.shown?.inboxFilter, "inbox", "a write shows at once")
        harness.store.flush()
        XCTAssertEqual(harness.sent, [["inboxFilter": .string("inbox")]])

        // A write that changes nothing sends nothing and counts as saved.
        var saved = false
        harness.store.write({ $0.inboxFilter = "inbox" }, saved: { saved = true })
        harness.store.flush()
        XCTAssertTrue(saved)
        XCTAssertEqual(harness.sent.count, 1)

        // An optional set back to nil is sent as null, which the hub's patch schema takes for that key.
        harness.shown?.voiceAccount = "work"
        harness.store.write { $0.voiceAccount = nil }
        harness.store.flush()
        XCTAssertEqual(harness.sent.last, ["voiceAccount": .null])
    }

    func testAnUnreadableSnapshotKeepsTheLastGoodPreferencesAndReportsOnce() throws {
        let harness = Harness()
        let good = try harness.state(revision: 1, #"{"placement":"side"}"#)
        XCTAssertEqual(try harness.store.received(good).placement, "side")
        // A newer hub sends a value this build cannot decode.
        var bad = try JSONDecoder().decode(WidgetState.self, from: Data(
            #"{"version":1,"revision":2,"preferences":{"placement":7},"assets":{},"drafts":{},"outgoing":[]}"#.utf8))
        XCTAssertNotNil(bad.preferencesUnreadable)
        XCTAssertEqual(bad.preferences, .hubDefaults, "the state still decodes; only its preferences are left out")
        XCTAssertEqual(try harness.store.received(bad).placement, "side", "the last good value stays, never a blank")
        bad.revision = 3
        XCTAssertEqual(try harness.store.received(bad).placement, "side")
        XCTAssertEqual(harness.reports.count, 1, "the failure is reported once")
        XCTAssertEqual(try harness.store.received(try harness.state(revision: 4, #"{"placement":"top"}"#)).placement, "top")
        XCTAssertEqual(try harness.store.received(bad).placement, "top")
        XCTAssertEqual(harness.reports.count, 2, "a failure after a good snapshot is reported again")
    }

    /// The live widget's watch builds each snapshot from state it read earlier, so one read before a preference write
    /// can arrive after the write was saved. It must not undo the saved value; a later change made elsewhere still shows.
    func testASnapshotReadBeforeASavedWriteNeverUndoesIt() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("widget-store-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stateFile = directory.appendingPathComponent("state.json")
        try Data(#"{"revision":3}"#.utf8).write(to: stateFile)
        let harness = Harness(stateFile: stateFile.path)
        harness.answer = {
            // `hub widget` stores the preference as revision 5.
            do { try Data(#"{"revision":5}"#.utf8).write(to: stateFile) } catch { return error }
            return nil
        }
        harness.shown = try harness.store.received(try harness.state(revision: 3, #"{"showWidget":true}"#))
        var saved = false
        harness.store.write({ $0.showWidget = false }, saved: { saved = true })
        harness.store.flush()
        XCTAssertTrue(saved)

        // The watch read revision 4 before the write and answers only now; the fence is read off the main actor.
        var deadline = ContinuousClock.now + .seconds(2)
        var shown = true
        while ContinuousClock.now < deadline {
            shown = try harness.store.received(try harness.state(revision: 4, #"{"showWidget":true}"#)).showWidget
            if !shown { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertFalse(shown, "a snapshot read before the write keeps it")
        _ = try harness.store.received(try harness.state(revision: 5, #"{"showWidget":false}"#))
        // Another surface turns it back on afterwards: that shows, the saved patch no longer covers it.
        deadline = ContinuousClock.now + .seconds(2)
        while try harness.store.received(try harness.state(revision: 6, #"{"showWidget":true}"#)).showWidget != true
            && ContinuousClock.now < deadline
        {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(try harness.store.received(try harness.state(revision: 6, #"{"showWidget":true}"#)).showWidget,
                      "a later change made elsewhere shows")
    }

    func testAWriteReportsItsOwnOutcomeSoAPageConfirmsOnlyAStoredValue() {
        let harness = Harness(shown: nil)
        var refuse = true
        harness.answer = { refuse ? ToolsBridgeError.refused("the widget state folder is not writable") : nil }
        var saved = 0
        var failed = 0
        harness.store.write({ $0.voiceLanguage = "cs" }, saved: { saved += 1 }, failed: { failed += 1 })
        harness.store.flush()
        XCTAssertEqual([saved, failed], [0, 1], "a write that failed was reported as saved")
        XCTAssertEqual(harness.readsAgain, 1, "a failed write reads the stored settings again")

        refuse = false
        harness.store.write({ $0.voiceLanguage = "cs" }, saved: { saved += 1 }, failed: { failed += 1 })
        harness.store.flush()
        XCTAssertEqual([saved, failed], [1, 1])
    }

    func testTheSessionFilterControlWritesTheFieldTheSnapshotReads() throws {
        let harness = Harness()
        let added = WidgetSessionFilter.adding("claude:fixture-b", to: WidgetSessionFilter.adding("claude:fixture-a", to: []))
        XCTAssertEqual(added, ["claude:fixture-a", "claude:fixture-b"])
        XCTAssertEqual(WidgetSessionFilter.adding("claude:fixture-a", to: added), added, "adding twice keeps one entry")
        harness.store.write { $0.sessions = added }
        harness.store.flush()
        XCTAssertEqual(harness.sent, [["sessions": .array(added.map(WidgetJSON.string))]])
        XCTAssertEqual(harness.shown?.sessions, added)
        XCTAssertEqual(WidgetSessionFilter.removing("claude:fixture-a", from: added), ["claude:fixture-b"])
    }
}
