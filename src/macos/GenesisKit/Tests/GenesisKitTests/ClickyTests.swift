import AVFoundation
import Combine
import Foundation
import SwiftUI
import XCTest

@testable import GenesisKit

final class ClickyTests: XCTestCase {
    @MainActor
    private final class InputMonitorStub: ClickyInputMonitoring {
        var granted = false
        var grantOnRequest = false
        var result: ClickyInputStartResult = .started
        var permissionChecks = 0
        var requests = 0
        var starts = 0
        var stops = 0
        var handler: (@MainActor (CGEventType, CGEvent) -> Void)?
        var hasPermission: Bool {
            permissionChecks += 1
            return granted
        }
        func requestPermission() -> Bool {
            requests += 1
            granted = grantOnRequest
            return granted
        }
        func start(handler: @escaping @MainActor (CGEventType, CGEvent) -> Void) -> ClickyInputStartResult {
            starts += 1
            self.handler = handler
            return result
        }
        func stop() {
            stops += 1
            handler = nil
        }
    }

    @MainActor
    private func monitorFixture(_ monitor: InputMonitorStub, snapshot: Bool = false) -> (
        ClickyModel, UserDefaults, String
    ) {
        let suite = "dev.genesis.clicky.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let appearance = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        return (
            ClickyModel(
                defaults: defaults, previewOnly: snapshot, appearance: appearance,
                inputMonitor: monitor, observeSystemEvents: false), defaults, suite
        )
    }

    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(identifier: "Europe/Prague")!
        return value
    }

    private func date(_ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 8, hour: hour, minute: minute))!
    }

    func testQuietHoursCrossMidnightAndEndIsExclusive() {
        var preferences = ClickyPreferences()
        preferences.quietHours = true
        XCTAssertFalse(preferences.isQuiet(at: date(21, 59), calendar: calendar))
        XCTAssertTrue(preferences.isQuiet(at: date(22), calendar: calendar))
        XCTAssertTrue(preferences.isQuiet(at: date(0), calendar: calendar))
        XCTAssertTrue(preferences.isQuiet(at: date(7, 59), calendar: calendar))
        XCTAssertFalse(preferences.isQuiet(at: date(8), calendar: calendar))
    }

    func testDaytimeAndDisabledQuietHours() {
        var preferences = ClickyPreferences()
        preferences.quietHours = true
        preferences.quietStart = 9 * 60
        preferences.quietEnd = 17 * 60
        XCTAssertFalse(preferences.isQuiet(at: date(8, 59), calendar: calendar))
        XCTAssertTrue(preferences.isQuiet(at: date(9), calendar: calendar))
        XCTAssertFalse(preferences.isQuiet(at: date(17), calendar: calendar))
        preferences.quietEnd = preferences.quietStart
        XCTAssertFalse(preferences.isQuiet(at: date(9), calendar: calendar))
        XCTAssertNil(preferences.nextQuietBoundary(after: date(9), calendar: calendar))
        preferences.quietEnd = 17 * 60
        preferences.quietHours = false
        XCTAssertFalse(preferences.isQuiet(at: date(10), calendar: calendar))
    }

    func testBoundarySchedulesAtActualNextChange() {
        var preferences = ClickyPreferences()
        preferences.quietHours = true
        XCTAssertEqual(preferences.nextQuietBoundary(after: date(21), calendar: calendar), date(22))
        XCTAssertEqual(preferences.nextQuietBoundary(after: date(7), calendar: calendar), date(8))
        let next = preferences.nextQuietBoundary(after: date(23), calendar: calendar)!
        XCTAssertEqual(calendar.component(.day, from: next), 9)
        XCTAssertEqual(calendar.component(.hour, from: next), 8)
    }

    func testEveryMuteGateSuppressesAndNormalInputPasses() {
        func accepts(
            enabled: Bool = true, secure: Bool = false, sleeping: Bool = false,
            quiet: Bool = false, excluded: Bool = false, repeated: Bool = false,
            repeats: Bool = false
        ) -> Bool {
            ClickyEventPolicy.accepts(
                enabled: enabled, secureInput: secure, sleeping: sleeping,
                quiet: quiet, excluded: excluded, repeated: repeated, repeatSounds: repeats)
        }
        XCTAssertTrue(accepts())
        XCTAssertFalse(accepts(enabled: false))
        XCTAssertFalse(accepts(secure: true))
        XCTAssertFalse(accepts(sleeping: true))
        XCTAssertFalse(accepts(quiet: true))
        XCTAssertFalse(accepts(excluded: true))
        XCTAssertFalse(accepts(repeated: true))
        XCTAssertTrue(accepts(repeated: true, repeats: true))
        XCTAssertFalse(accepts(secure: true, repeated: true, repeats: true))
    }

    func testPhysicalKeyboardPanningAndUnknownKeys() {
        XCTAssertLessThan(ClickyEventPolicy.pan(keyCode: 0), 0)
        XCTAssertGreaterThan(ClickyEventPolicy.pan(keyCode: 37), 0)
        XCTAssertEqual(ClickyEventPolicy.pan(keyCode: 49), 0)
        XCTAssertEqual(ClickyEventPolicy.pan(keyCode: UInt16.max), 0)
    }

    func testOriginalSoundsAreDeterministicDistinctFiniteAndBounded() {
        var signatures: Set<[Float]> = []
        for profile in ClickySwitch.allCases {
            let down = ClickySynthesis.samples(profile: profile, release: false, variant: 1)
            let up = ClickySynthesis.samples(profile: profile, release: true, variant: 1)
            XCTAssertEqual(down, ClickySynthesis.samples(profile: profile, release: false, variant: 1))
            XCTAssertNotEqual(down, up)
            XCTAssertNotEqual(down, ClickySynthesis.samples(profile: profile, release: false, variant: 2))
            XCTAssertTrue(down.allSatisfy { $0.isFinite && abs($0) <= 1 })
            XCTAssertTrue(up.allSatisfy { $0.isFinite && abs($0) <= 1 })
            XCTAssertGreaterThan(down.map(abs).max() ?? 0, 0.05)
            XCTAssertLessThan(abs(down.last ?? 1), 0.03)
            signatures.insert(Array(down.prefix(100)))
        }
        XCTAssertEqual(signatures.count, 7)
    }

    @MainActor
    func testRenderedAudioActuallyPansAndRespectsVolume() throws {
        func render(pan: Float, volume: Double, spatial: Bool = true) throws -> (Double, Double) {
            let engine = AVAudioEngine()
            let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
            try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 8192)
            let audio = ClickyAudio(engine: engine)
            defer { audio.stop() }
            var preferences = ClickyPreferences()
            preferences.volume = volume
            preferences.randomizedPitch = false
            preferences.spatialAudio = spatial
            try audio.play(profile: .basalt, release: false, preferences: preferences, pan: pan)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192)!
            let status = try engine.renderOffline(8192, to: buffer)
            XCTAssertEqual(status, .success)
            let left = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
            let right = UnsafeBufferPointer(start: buffer.floatChannelData![1], count: Int(buffer.frameLength))
            return (left.reduce(0) { $0 + Double($1 * $1) }, right.reduce(0) { $0 + Double($1 * $1) })
        }
        let left = try render(pan: -0.75, volume: 1)
        let right = try render(pan: 0.75, volume: 1)
        let quiet = try render(pan: -0.75, volume: 0.25)
        let centered = try render(pan: -0.75, volume: 1, spatial: false)
        XCTAssertGreaterThan(left.0, left.1 * 3)
        XCTAssertGreaterThan(right.1, right.0 * 3)
        XCTAssertGreaterThan(left.0, quiet.0 * 10)
        XCTAssertGreaterThan(centered.0, 0)
        XCTAssertEqual(centered.0, centered.1, accuracy: 0.00001)
    }

    func testPhysicalTransitionsRejectUnmatchedAndDuplicateEvents() {
        var input = ClickyInputState()
        XCTAssertNil(input.transition(keyCode: 56, release: true, repeated: false, repeatSounds: true))
        XCTAssertEqual(
            input.transition(keyCode: 56, release: false, repeated: false, repeatSounds: true),
            ClickyKeyTransition(release: false, countsPress: true))
        XCTAssertNil(input.transition(keyCode: 56, release: false, repeated: false, repeatSounds: true))
        XCTAssertNotNil(input.transition(keyCode: 60, release: false, repeated: false, repeatSounds: true))
        XCTAssertNotNil(input.transition(keyCode: 56, release: true, repeated: false, repeatSounds: true))
        XCTAssertNotNil(input.transition(keyCode: 60, release: true, repeated: false, repeatSounds: true))
        XCTAssertNil(input.transition(keyCode: 60, release: true, repeated: false, repeatSounds: true))
    }

    func testSuppressedRepeatsPreserveThePhysicalReleaseAndDoNotInflateCounts() {
        var input = ClickyInputState()
        XCTAssertNil(input.transition(keyCode: 0, release: false, repeated: true, repeatSounds: true))
        XCTAssertNotNil(input.transition(keyCode: 0, release: false, repeated: false, repeatSounds: false))
        XCTAssertNil(input.transition(keyCode: 0, release: false, repeated: true, repeatSounds: false))
        XCTAssertEqual(
            input.transition(keyCode: 0, release: false, repeated: true, repeatSounds: true),
            ClickyKeyTransition(release: false, countsPress: false))
        XCTAssertEqual(
            input.transition(keyCode: 0, release: true, repeated: false, repeatSounds: false),
            ClickyKeyTransition(release: true, countsPress: false))
    }

    func testClearingAtAMuteBoundaryDiscardsOldReleasesAndRepeats() {
        var input = ClickyInputState()
        XCTAssertNotNil(input.transition(keyCode: 0, release: false, repeated: false, repeatSounds: true))
        input.clear()
        XCTAssertNil(input.transition(keyCode: 0, release: true, repeated: false, repeatSounds: true))
        XCTAssertNil(input.transition(keyCode: 0, release: false, repeated: true, repeatSounds: true))
        XCTAssertNotNil(input.transition(keyCode: 0, release: false, repeated: false, repeatSounds: true))
    }

    func testQuietHourClockUsesWallTimeAcrossDaylightSavingChanges() {
        for components in [
            DateComponents(year: 2026, month: 3, day: 29, hour: 12),
            DateComponents(year: 2026, month: 10, day: 25, hour: 12),
        ] {
            let day = calendar.date(from: components)!
            let clock = ClickyPreferences.clockTime(minute: 22 * 60 + 15, on: day, calendar: calendar)
            XCTAssertEqual(calendar.component(.hour, from: clock), 22)
            XCTAssertEqual(calendar.component(.minute, from: clock), 15)
        }
    }

    @MainActor
    func testInteractiveActivationUsesExistingGrantAndDisablesTheMonitor() {
        let monitor = InputMonitorStub()
        monitor.granted = true
        let (model, defaults, suite) = monitorFixture(monitor)
        defer {
            model.shutdown()
            defaults.removePersistentDomain(forName: suite)
        }
        XCTAssertFalse(model.enabled)
        model.activate()
        XCTAssertTrue(model.enabled)
        XCTAssertNil(model.error)
        XCTAssertEqual(model.status, "Listening for key presses")
        XCTAssertEqual(monitor.requests, 0)
        XCTAssertEqual(monitor.starts, 1)
        XCTAssertEqual(model.statistics.sessions, 1)
        model.activate()
        XCTAssertEqual(monitor.starts, 1)
        model.deactivate()
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(monitor.stops, 1)
        XCTAssertEqual(model.status, "Clicky is off")
    }

    @MainActor
    func testDeniedActivationDoesNotStartAndCanRecoverAfterPermissionIsGranted() {
        let monitor = InputMonitorStub()
        let (model, defaults, suite) = monitorFixture(monitor)
        defer {
            model.shutdown()
            defaults.removePersistentDomain(forName: suite)
        }
        model.activate()
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(monitor.requests, 1)
        XCTAssertEqual(monitor.starts, 0)
        XCTAssertEqual(model.statistics.sessions, 0)
        XCTAssertEqual(model.status, "Input Monitoring permission needed")
        XCTAssertTrue(model.error?.contains(model.applicationName) == true)
        monitor.grantOnRequest = true
        model.activate()
        XCTAssertTrue(model.enabled)
        XCTAssertNil(model.error)
        XCTAssertEqual(monitor.requests, 2)
        XCTAssertEqual(monitor.starts, 1)
    }

    @MainActor
    func testTapFailureAndPermissionRevocationNeverClaimListening() {
        for result in [ClickyInputStartResult.unavailable, .permissionRequired] {
            let monitor = InputMonitorStub()
            monitor.granted = true
            monitor.result = result
            let (model, defaults, suite) = monitorFixture(monitor)
            model.activate()
            XCTAssertFalse(model.enabled)
            XCTAssertNotEqual(model.status, "Listening for key presses")
            XCTAssertNotNil(model.error)
            XCTAssertEqual(model.statistics.sessions, 0)
            XCTAssertEqual(monitor.requests, 0)
            XCTAssertEqual(monitor.starts, 1)
            model.shutdown()
            defaults.removePersistentDomain(forName: suite)
        }
    }

    @MainActor
    func testSnapshotActivationCannotReachThePermissionOrMonitorPrimitives() {
        let monitor = InputMonitorStub()
        monitor.granted = true
        let (model, defaults, suite) = monitorFixture(monitor, snapshot: true)
        defer {
            model.shutdown()
            defaults.removePersistentDomain(forName: suite)
        }
        model.activate()
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(monitor.permissionChecks, 0)
        XCTAssertEqual(monitor.requests, 0)
        XCTAssertEqual(monitor.starts, 0)
    }

    @MainActor
    func testSystemDisablingTheEventTapStopsAndReportsTheFailure() throws {
        let monitor = InputMonitorStub()
        monitor.granted = true
        let (model, defaults, suite) = monitorFixture(monitor)
        defer {
            model.shutdown()
            defaults.removePersistentDomain(forName: suite)
        }
        model.activate()
        let event = try XCTUnwrap(CGEvent(source: nil))
        monitor.handler?(.tapDisabledByTimeout, event)
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(monitor.stops, 1)
        XCTAssertTrue(model.error?.contains("macOS paused input monitoring") == true)
    }

    @MainActor
    private func settingsSection(_ id: String, pages: [String], order: Int = 50) -> NativeSettingsSection {
        NativeSettingsSection(
            id: id, title: id,
            pages: pages.map { page in
                NativeSettingsPage(id: page, title: page, symbol: "gearshape", tint: .gray) { Text(page) }
            }, order: order)
    }

    @MainActor
    func testSettingsRegistrationPreservesPendingRequestsAndPersistsSelection() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let appearance = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        let initial = settingsSection("general", pages: ["general"], order: 0)
        let store = NativeSettingsStore(sections: [initial], defaults: defaults, appearance: appearance)
        XCTAssertFalse(store.select(pageID: "widgets.general"))
        XCTAssertEqual(store.pendingPageID, "widgets.general")
        XCTAssertEqual(store.selectedPageID, "general")
        XCTAssertTrue(store.register(section: settingsSection("widgets", pages: ["widgets.general"], order: 30)))
        XCTAssertEqual(store.selectedPageID, "widgets.general")
        XCTAssertNil(store.pendingPageID)
        let restored = NativeSettingsStore(sections: [initial], defaults: defaults, appearance: appearance)
        XCTAssertEqual(restored.pendingPageID, "widgets.general")
        XCTAssertTrue(restored.register(section: settingsSection("widgets", pages: ["widgets.general"], order: 30)))
        XCTAssertEqual(restored.selectedPageID, "widgets.general")
    }

    @MainActor
    func testSettingsRejectDuplicatePageIDsWithoutChangingTheCatalog() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let appearance = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        let store = NativeSettingsStore(
            sections: [settingsSection("first", pages: ["general"])],
            defaults: defaults, appearance: appearance)
        XCTAssertFalse(store.register(section: settingsSection("second", pages: ["general"])))
        XCTAssertEqual(store.catalogError, .duplicatePageID("general"))
        XCTAssertEqual(store.sections.map(\.id), ["first"])
        XCTAssertEqual(store.selectedPageID, "general")
        XCTAssertTrue(store.register(section: settingsSection("first", pages: ["replacement"])))
        XCTAssertEqual(store.selectedPageID, "replacement")
        XCTAssertNil(store.catalogError)
        XCTAssertEqual(
            NativeSettingsStore.validate([settingsSection("same", pages: []), settingsSection("same", pages: [])]),
            .duplicateSectionID("same"))
        XCTAssertEqual(NativeSettingsStore.validate([settingsSection("", pages: [])]), .emptySectionID)
        XCTAssertEqual(NativeSettingsStore.validate([settingsSection("section", pages: [""])]), .emptyPageID)
    }

    @MainActor
    func testSettingsOrderPlacesLateRegisteredFeaturesBeforeAbout() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let appearance = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        let store = NativeSettingsStore(
            sections: [
                settingsSection("about", pages: ["about"], order: 90),
                settingsSection("general", pages: ["general"], order: 0),
            ],
            defaults: defaults, appearance: appearance)
        XCTAssertEqual(store.sections.map(\.id), ["general", "about"])
        XCTAssertTrue(store.register(section: settingsSection("widgets", pages: ["widgets.general"], order: 30)))
        XCTAssertEqual(store.sections.map(\.id), ["general", "widgets", "about"])
    }

    @MainActor
    func testSharedAppearanceIsDurableIndependentAndMigrationDoesNotOverwrite() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        first.migrateIfNeeded(reduceMotion: true, reduceTransparency: false)
        XCTAssertTrue(first.reduceMotion)
        XCTAssertFalse(first.reduceTransparency)
        first.reduceTransparency = true
        XCTAssertTrue(first.reduceMotion)
        first.migrateIfNeeded(reduceMotion: false, reduceTransparency: false)
        XCTAssertTrue(first.reduceMotion)
        XCTAssertTrue(first.reduceTransparency)
        let second = NativeSettingsAppearance(
            defaults: UserDefaults(suiteName: suite)!, notificationNamespace: suite,
            observeExternalChanges: false)
        XCTAssertTrue(second.reduceMotion)
        XCTAssertTrue(second.reduceTransparency)
        first.reduceMotion = false
        second.reloadFromDefaults()
        XCTAssertFalse(second.reduceMotion)
        XCTAssertTrue(second.reduceTransparency)
    }

    @MainActor
    func testThemeChoiceSurvivesIndependentTransparencyOverrides() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let appearance = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        appearance.theme = .gradient
        appearance.reduceMotion = true
        appearance.reduceTransparency = true
        XCTAssertEqual(appearance.theme, .gradient)
        XCTAssertEqual(appearance.theme.effective(reduceTransparency: true, systemReduceTransparency: false), .solid)
        XCTAssertEqual(appearance.theme.effective(reduceTransparency: false, systemReduceTransparency: true), .solid)
        appearance.reduceTransparency = false
        XCTAssertEqual(
            appearance.theme.effective(reduceTransparency: false, systemReduceTransparency: false), .gradient)
        XCTAssertTrue(appearance.reduceMotion)
        let restored = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        XCTAssertEqual(restored.theme, .gradient)
        XCTAssertFalse(restored.reduceTransparency)
        XCTAssertTrue(restored.reduceMotion)
    }

    @MainActor
    func testIndependentAppearanceWritesDoNotOverwriteAnotherInstancesChanges() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        let stale = NativeSettingsAppearance(
            defaults: UserDefaults(suiteName: suite)!, notificationNamespace: suite, observeExternalChanges: false)
        first.theme = .gradient
        first.reduceMotion = true
        stale.reduceTransparency = true
        first.reloadFromDefaults()
        stale.reloadFromDefaults()
        XCTAssertEqual(stale.theme, .gradient)
        XCTAssertTrue(stale.reduceMotion)
        XCTAssertTrue(first.reduceTransparency)
        XCTAssertEqual(first.theme, .gradient)
    }

    @MainActor
    func testSharedAppearanceReceivesDistributedChanges() async {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let writer = NativeSettingsAppearance(defaults: defaults, notificationNamespace: suite)
        let reader = NativeSettingsAppearance(defaults: UserDefaults(suiteName: suite)!, notificationNamespace: suite)
        let changed = expectation(description: "Distributed appearance notification")
        let subscription = reader.$reduceTransparency.dropFirst().filter { $0 }.prefix(1).sink { _ in changed.fulfill()
        }
        writer.reduceTransparency = true
        await fulfillment(of: [changed], timeout: 2)
        XCTAssertTrue(reader.reduceTransparency)
        XCTAssertFalse(reader.reduceMotion)
        withExtendedLifetime(subscription) {}
    }

    @MainActor
    func testClickyLegacyAppearanceAndSharedStoreRemainConnected() async throws {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var legacy = ClickyPreferences()
        legacy.reduceMotion = true
        defaults.set(try JSONEncoder().encode(legacy), forKey: "clicky.preferences.v1")
        let appearance = NativeSettingsAppearance(
            defaults: defaults, notificationNamespace: suite, observeExternalChanges: false)
        let model = ClickyModel(defaults: defaults, previewOnly: true, appearance: appearance)
        XCTAssertTrue(appearance.reduceMotion)
        XCTAssertTrue(model.preferences.reduceMotion)
        let changed = expectation(description: "Shared appearance reaches existing Clicky preference")
        let subscription = model.$preferences.filter { !$0.reduceMotion }.prefix(1).sink { _ in changed.fulfill() }
        appearance.reduceMotion = false
        await fulfillment(of: [changed], timeout: 2)
        XCTAssertFalse(model.preferences.reduceMotion)
        model.preferences.reduceTransparency = true
        XCTAssertTrue(appearance.reduceTransparency)
        XCTAssertFalse(appearance.reduceMotion)
        model.shutdown()
        withExtendedLifetime(subscription) {}
    }

    @MainActor
    func testSettingsTaxonomyRetainsOneClickyModelWithoutEnablingInput() {
        let suite = "dev.genesis.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = ClickyModel(defaults: defaults, previewOnly: true)
        let sections = ClickySettingsPages.sections(model: model)
        XCTAssertEqual(sections.map(\.id), ["general", "settings", "clicky", "about"])
        XCTAssertEqual(sections[1].pages.map(\.id), ["clicky.sound", "clicky.sleep", "clicky.notifications"])
        XCTAssertEqual(sections[2].pages.map(\.id), ["clicky.stats", "clicky.visualizer"])
        XCTAssertFalse(model.enabled)
        let controller = ClickyWindowController(model: model)
        XCTAssertTrue(controller.model === model)
        XCTAssertTrue(controller.settings.store.appearance === model.appearance)
        XCTAssertNil(controller.window)
        model.shutdown()
    }

    func testRestoredSettingsGeometryKeepsReachableWindowsAcrossDisplays() {
        let screens = [NSRect(x: 0, y: 0, width: 1440, height: 900),
            NSRect(x: -1920, y: 100, width: 1920, height: 1080)]
        XCTAssertTrue(NativeSettingsWindowGeometry.hasReachableTitlebar(
            frame: NSRect(x: 100, y: 100, width: 960, height: 760), visibleScreens: screens))
        XCTAssertTrue(NativeSettingsWindowGeometry.hasReachableTitlebar(
            frame: NSRect(x: -1600, y: 200, width: 960, height: 760), visibleScreens: screens))
        XCTAssertFalse(NativeSettingsWindowGeometry.hasReachableTitlebar(
            frame: NSRect(x: 3000, y: 100, width: 960, height: 760), visibleScreens: screens))
        XCTAssertFalse(NativeSettingsWindowGeometry.hasReachableTitlebar(
            frame: NSRect(x: 100, y: 850, width: 960, height: 760), visibleScreens: screens))
        XCTAssertFalse(NativeSettingsWindowGeometry.hasReachableTitlebar(
            frame: .zero, visibleScreens: screens))
    }

    func testPreferenceSanitizationAndRoundTrip() throws {
        var preferences = ClickyPreferences()
        preferences.volume = .nan
        preferences.quietStart = -1
        preferences.quietEnd = 2000
        preferences.excludedApplications = ["com.example.editor", "", "com.example.editor"]
        preferences.normalize()
        XCTAssertEqual(preferences.volume, 0.45)
        XCTAssertEqual(preferences.quietStart, 0)
        XCTAssertEqual(preferences.quietEnd, 1439)
        XCTAssertEqual(preferences.excludedApplications, ["com.example.editor"])
        let encoded = try JSONEncoder().encode(preferences)
        XCTAssertEqual(try JSONDecoder().decode(ClickyPreferences.self, from: encoded), preferences)
    }

    @MainActor
    func testPreviewCannotActivateInputAndStartsOff() {
        let suite = "dev.genesis.clicky.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = ClickyModel(defaults: defaults, previewOnly: true)
        XCTAssertFalse(model.enabled)
        model.activate()
        XCTAssertFalse(model.enabled)
        XCTAssertNotNil(model.error)
        model.preferences.selectedSwitch = .paper
        let second = ClickyModel(defaults: defaults, previewOnly: true)
        XCTAssertEqual(second.preferences.selectedSwitch, .paper)
        XCTAssertFalse(second.enabled)
        model.snooze(minutes: 15)
        XCTAssertTrue(model.isPaused)
        model.resume()
        XCTAssertFalse(model.isPaused)
        model.shutdown()
        second.shutdown()
    }
}
