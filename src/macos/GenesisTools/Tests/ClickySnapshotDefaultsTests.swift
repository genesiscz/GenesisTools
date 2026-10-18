import XCTest
import GenesisKit
@testable import GenesisToolsClicky

/// A `--features --snapshot` run builds Clicky's model over ReadOnlyDefaults (ClickyPlugin.swift), so drawing the
/// pages never changes the user's Clicky state.
@MainActor
final class ClickySnapshotDefaultsTests: XCTestCase {
    func testASnapshotModelWritesNoRecoveryCopyAndNoMigratedAppearanceKeys() throws {
        let suite = "dev.genesis.clicky.snapshot.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("{\"releaseSounds\": fal".utf8), forKey: "clicky.preferences.v1")
        let before = defaults.persistentDomain(forName: suite)?.keys.sorted()

        let model = ClickyModel(
            defaults: try XCTUnwrap(ReadOnlyDefaults(reading: suite)), previewOnly: true, observeSystemEvents: false)
        defer { model.shutdown() }

        XCTAssertEqual(defaults.persistentDomain(forName: suite)?.keys.sorted(), before)
    }

    func testASnapshotModelStillReadsTheSavedPreferences() throws {
        let suite = "dev.genesis.clicky.snapshot.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var saved = ClickyPreferences()
        saved.releaseSounds = false
        defaults.set(try JSONEncoder().encode(saved), forKey: "clicky.preferences.v1")

        let model = ClickyModel(
            defaults: try XCTUnwrap(ReadOnlyDefaults(reading: suite)), previewOnly: true, observeSystemEvents: false)
        defer { model.shutdown() }

        XCTAssertFalse(model.preferences.releaseSounds)
    }
}
