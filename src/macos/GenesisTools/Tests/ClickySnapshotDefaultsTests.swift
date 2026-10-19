import XCTest
import GenesisKit
@testable import GenesisToolsFeatures

/// A `--features --snapshot` run builds its appearance and Clicky's model over ReadOnlyDefaults (FeaturesEntry.swift,
/// ClickyPlugin.swift), so drawing the pages never changes the user's settings, and the two show the same values.
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

    /// Legacy Clicky preferences that were never migrated: the snapshot's shared appearance shows the migrated value,
    /// so General and Clicky agree, and nothing is stored.
    func testALegacyMigrationReachesTheSharedSnapshotAppearanceWithoutAWrite() throws {
        let suite = "dev.genesis.clicky.snapshot.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var legacy = ClickyPreferences()
        legacy.reduceMotion = true
        defaults.set(try JSONEncoder().encode(legacy), forKey: "clicky.preferences.v1")
        let before = defaults.persistentDomain(forName: suite)?.keys.sorted()
        let readOnly = try XCTUnwrap(ReadOnlyDefaults(reading: suite))
        let appearance = NativeSettingsAppearance(
            defaults: readOnly, notificationNamespace: suite, observeExternalChanges: false)

        let model = ClickyModel(defaults: readOnly, previewOnly: true, appearance: appearance, observeSystemEvents: false)
        defer { model.shutdown() }

        XCTAssertTrue(appearance.reduceMotion)
        XCTAssertTrue(model.preferences.reduceMotion)
        XCTAssertEqual(defaults.persistentDomain(forName: suite)?.keys.sorted(), before)
    }

    func testOnlyASnapshotShellLeavesTheSharedAppearanceAndTheStandardDefaults() {
        let snapshot = FeatureSettingsShell(mode: .snapshot)
        XCTAssertFalse(snapshot.appearance === NativeSettingsAppearance.shared)
        XCTAssertTrue(snapshot.defaults is ReadOnlyDefaults)
        for mode in [FeatureSettingsMode.live, .headless] {
            let shell = FeatureSettingsShell(mode: mode)
            XCTAssertTrue(shell.appearance === NativeSettingsAppearance.shared)
            XCTAssertTrue(shell.defaults === UserDefaults.standard)
        }
    }
}
