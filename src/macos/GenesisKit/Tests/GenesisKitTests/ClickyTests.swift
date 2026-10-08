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
        var reenables = 0
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
        func reenable() {
            reenables += 1
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
    func testUserInputDisablingTheEventTapStopsAndReportsTheFailure() throws {
        let monitor = InputMonitorStub()
        monitor.granted = true
        let (model, defaults, suite) = monitorFixture(monitor)
        defer {
            model.shutdown()
            defaults.removePersistentDomain(forName: suite)
        }
        model.activate()
        let event = try XCTUnwrap(CGEvent(source: nil))
        monitor.handler?(.tapDisabledByUserInput, event)
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(monitor.stops, 1)
        XCTAssertEqual(monitor.reenables, 0)
        XCTAssertTrue(model.error?.contains("macOS paused input monitoring") == true)
    }

    @MainActor
    func testTimedOutEventTapIsTurnedBackOnAndClickyStaysEnabled() throws {
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
        XCTAssertTrue(model.enabled)
        XCTAssertEqual(monitor.reenables, 1)
        XCTAssertEqual(monitor.stops, 0)
        XCTAssertNil(model.error)
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

final class ClickyPackTests: XCTestCase {
    private struct Fixture {
        let root: URL
        let entry: ClickyPackEntry
        let wav: Data
        var manifest: [String: Any]

        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("clicky-pack-tests-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root.appendingPathComponent("fixture"), withIntermediateDirectories: true)
            entry = ClickyPackEntry(
                id: "fixture", name: "Fixture", kind: "original-procedural", author: "Example Author",
                licence: "Fixture-Licence", manifest: "fixture/manifest.json", licenceFile: "fixture/LICENCE.txt")
            wav = ClickyPackTests.wav([0, 16_384, -16_384, 32_767, -32_768], oddChunk: true)
            let files = ["press-a.wav", "press-b.wav", "release-a.wav", "release-b.wav"]
            let variants = ["press": ["press-a.wav", "press-b.wav"], "release": ["release-a.wav", "release-b.wav"]]
            let hash = ClickyPackLoader.sha256(wav)
            manifest = [
                "formatVersion": 1, "id": "fixture", "name": "Authoritative fixture",
                "kind": "original-procedural", "author": "Example Author", "licence": "Fixture-Licence",
                "attribution": "Fixture audio by Example Author", "attributionRequired": true,
                "permissions": ["personal": true, "modification": true, "redistribution": true, "commercialRedistribution": false],
                "source": ["generator": "generator.swift", "generatorVersion": "1", "generatorSha256": String(repeating: "a", count: 64),
                           "baseSeed": 42, "externalSamples": false, "qualityNote": "Synthetic fixture", "repository": "https://example.com/audio"],
                "audio": ["sampleRate": 48_000, "channels": 1, "bitsPerSample": 16],
                "playback": ["defaultCategory": "letter", "categories": Dictionary(uniqueKeysWithValues: ClickyPackPlayback.categoryNames.map { ($0, variants) }),
                             "keyCodes": ["KeyA": "letter", "Digit1": "digit", "Numpad1": "digit", "Space": "space", "Enter": "enter",
                                          "NumpadEnter": "enter", "Backspace": "backspace", "Delete": "backspace", "ShiftLeft": "modifier"],
                             "gain": 0.65, "keyupGain": 0.75, "pitchVariation": 0],
                "files": files.map { ["filename": $0, "sha256": hash, "frames": 5] as [String: Any] },
            ]
            for name in files {
                try wav.write(to: root.appendingPathComponent("fixture/\(name)"))
            }
            try Data("Fixture licence. Permission granted to use these synthetic test samples.\n".utf8)
                .write(to: root.appendingPathComponent("fixture/LICENCE.txt"))
            try writeManifest()
            try writeRegistry([entry])
        }

        func writeManifest() throws {
            try JSONSerialization.data(withJSONObject: manifest).write(to: root.appendingPathComponent("fixture/manifest.json"))
        }

        func writeRegistry(_ entries: [ClickyPackEntry], version: Int = 1) throws {
            struct Registry: Encodable {
                let formatVersion: Int
                let sets: [ClickyPackEntry]
            }
            try JSONEncoder().encode(Registry(formatVersion: version, sets: entries)).write(to: root.appendingPathComponent("registry.json"))
        }

        func dispose() { try? FileManager.default.removeItem(at: root) }
    }

    private static func wav(_ samples: [Int16], oddChunk: Bool = false) -> Data {
        func le16(_ value: UInt16) -> [UInt8] { [UInt8(truncatingIfNeeded: value), UInt8(truncatingIfNeeded: value >> 8)] }
        func le32(_ value: Int) -> [UInt8] { le16(UInt16(truncatingIfNeeded: value)) + le16(UInt16(truncatingIfNeeded: value >> 16)) }
        var chunks = [UInt8]()
        if oddChunk {
            chunks += Array("JUNK".utf8) + le32(3) + [1, 2, 3, 0]
        }
        chunks += Array("fmt ".utf8) + le32(16) + le16(1) + le16(1) + le32(48_000) + le32(96_000) + le16(2) + le16(16)
        let pcm = samples.flatMap { le16(UInt16(bitPattern: $0)) }
        chunks += Array("data".utf8) + le32(pcm.count) + pcm
        return Data(Array("RIFF".utf8) + le32(chunks.count + 4) + Array("WAVE".utf8) + chunks)
    }

    private func assertPrepareFails(_ fixture: Fixture, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
            XCTFail("Malformed pack prepared successfully", file: file, line: line)
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty, file: file, line: line)
        }
    }

    func testValidCatalogueAndPreparedPCMKeepMetadataAndDeduplicateVerifiedSamples() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let loader = ClickyPackLoader()
        let entries = try await loader.catalogue(at: fixture.root)
        XCTAssertEqual(entries.map(\.id), ["fixture"])
        XCTAssertNil(entries[0].availabilityError)
        let prepared = try await loader.prepare(at: fixture.root, entry: entries[0])
        XCTAssertEqual(prepared.entry.name, "Authoritative fixture")
        XCTAssertEqual(prepared.samples.count, 4)
        XCTAssertEqual(prepared.decodedFrameCount, 5)
        XCTAssertEqual(prepared.samples["press-a.wav"]?.frames, [0, 0.5, -0.5, Float(32_767) / 32768, -1])
        XCTAssertEqual(prepared.manifestHash.count, 64)
        XCTAssertEqual(prepared.source.baseSeed, 42)
        XCTAssertEqual(prepared.source.sourceURL?.absoluteString, "https://example.com/audio")
        XCTAssertEqual(prepared.source.qualityNote, "Synthetic fixture")
        XCTAssertTrue(prepared.attributionRequired)
        XCTAssertFalse(prepared.permissions.commercialRedistribution)
        XCTAssertTrue(prepared.licenceText.contains("Permission granted"))
        XCTAssertEqual(prepared.playback.gain, 0.65)
        XCTAssertEqual(prepared.playback.keyupGain, 0.75)
    }

    func testPhysicalMappingsOverridesAndPairedReleaseVariants() async throws {
        var fixture = try Fixture()
        defer { fixture.dispose() }
        var playback = try XCTUnwrap(fixture.manifest["playback"] as? [String: Any])
        var codes = try XCTUnwrap(playback["keyCodes"] as? [String: String])
        codes["KeyA"] = "space"
        playback["keyCodes"] = codes
        fixture.manifest["playback"] = playback
        try fixture.writeManifest()
        let prepared = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let mapping: [(UInt16, String)] = [(0, "space"), (18, "digit"), (83, "digit"), (49, "space"), (36, "enter"),
                                          (76, "enter"), (51, "backspace"), (117, "backspace"), (56, "modifier"), (65535, "letter")]
        for (code, category) in mapping {
            XCTAssertEqual(prepared.playback.category(for: code), category)
        }
        var state = ClickyPackSelectionState()
        XCTAssertNil(state.next(playback: prepared.playback, keyCode: 49, release: true))
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 49, release: false)?.filename, "press-a.wav")
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 0, release: false)?.filename, "press-b.wav")
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 49, release: true)?.filename, "release-a.wav")
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 0, release: true)?.filename, "release-b.wav")
        _ = state.next(playback: prepared.playback, keyCode: 0, release: false)
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 0, release: false)?.filename, "press-b.wav")
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 0, release: true)?.filename, "release-b.wav")
        _ = state.next(playback: prepared.playback, keyCode: 0, release: false)
        state.clear()
        XCTAssertNil(state.next(playback: prepared.playback, keyCode: 0, release: true))
        XCTAssertEqual(state.next(playback: prepared.playback, keyCode: 0, release: false)?.variant, 0)
    }

    func testReleaseUsesPressIndexModuloReleaseCount() async throws {
        var fixture = try Fixture()
        defer { fixture.dispose() }
        var playback = try XCTUnwrap(fixture.manifest["playback"] as? [String: Any])
        var categories = try XCTUnwrap(playback["categories"] as? [String: [String: [String]]])
        categories["letter"] = ["press": ["press-a.wav", "press-b.wav"], "release": ["release-a.wav"]]
        playback["categories"] = categories
        fixture.manifest["playback"] = playback
        try fixture.writeManifest()
        let prepared = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        var state = ClickyPackSelectionState()
        _ = state.next(playback: prepared.playback, keyCode: 0, release: false)
        _ = state.next(playback: prepared.playback, keyCode: 0, release: false)
        let release = state.next(playback: prepared.playback, keyCode: 0, release: true)
        XCTAssertEqual(release?.variant, 1)
        XCTAssertEqual(release?.filename, "release-a.wav")
    }

    func testCatalogueRejectsAmbiguousIdentityAndVersionsButRetainsUnavailableRows() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let loader = ClickyPackLoader()
        for entries in [[fixture.entry, fixture.entry], [ClickyPackEntry(id: "../escape", name: "Fixture", kind: "fixture", author: "Example", licence: "Fixture", manifest: "../manifest.json", licenceFile: "../LICENCE.txt")]] {
            try fixture.writeRegistry(entries)
            do {
                _ = try await loader.catalogue(at: fixture.root)
                XCTFail("Ambiguous catalogue was accepted")
            } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        }
        try fixture.writeRegistry([fixture.entry], version: 2)
        do {
            _ = try await loader.catalogue(at: fixture.root)
            XCTFail("Unsupported catalogue was accepted")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        let bad = ClickyPackEntry(id: "other", name: "Other", kind: "fixture", author: "Example", licence: "Fixture", manifest: "../manifest.json", licenceFile: "other/LICENCE.txt")
        try fixture.writeRegistry([fixture.entry, bad])
        let entries = try await loader.catalogue(at: fixture.root)
        XCTAssertNil(entries[0].availabilityError)
        XCTAssertNotNil(entries[1].availabilityError)
        _ = try await loader.prepare(at: fixture.root, entry: entries[0])
        let validRow = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.entry)) as? [String: Any])
        var malformedRow = validRow
        malformedRow["id"] = "broken"
        malformedRow["author"] = false
        try JSONSerialization.data(withJSONObject: ["formatVersion": 1, "sets": [validRow, malformedRow]])
            .write(to: fixture.root.appendingPathComponent("registry.json"))
        let partial = try await loader.catalogue(at: fixture.root)
        XCTAssertEqual(partial.count, 2)
        XCTAssertNil(partial[0].availabilityError)
        XCTAssertNotNil(partial[1].availabilityError)
    }

    func testManifestRejectsMalformedDeclarationsAndPlaybackAlongsideNormalControl() async throws {
        let mutations: [(inout [String: Any]) -> Void] = [
            { $0["formatVersion"] = 2 }, { $0["id"] = "other" },
            { $0["audio"] = ["sampleRate": 44_100, "channels": 1, "bitsPerSample": 16] },
            { $0["files"] = [] },
            { manifest in
                if var files = manifest["files"] as? [[String: Any]] { files.append(files[0]); manifest["files"] = files }
            },
            { manifest in
                if var files = manifest["files"] as? [[String: Any]] { files[0]["frames"] = 12_001; manifest["files"] = files }
            },
            { manifest in
                if var playback = manifest["playback"] as? [String: Any] { playback["gain"] = 1.1; manifest["playback"] = playback }
            },
            { manifest in
                if var playback = manifest["playback"] as? [String: Any] { playback["pitchVariation"] = 0.1; manifest["playback"] = playback }
            },
            { manifest in
                if var playback = manifest["playback"] as? [String: Any] { playback["keyCodes"] = ["UnsupportedKey": "letter"]; manifest["playback"] = playback }
            },
            { manifest in
                if var playback = manifest["playback"] as? [String: Any] { playback["categories"] = ["letter": ["press": ["missing.wav"], "release": []]]; manifest["playback"] = playback }
            },
        ]
        for mutation in mutations {
            var fixture = try Fixture()
            defer { fixture.dispose() }
            mutation(&fixture.manifest)
            try fixture.writeManifest()
            await assertPrepareFails(fixture)
        }
        let normal = try Fixture()
        defer { normal.dispose() }
        _ = try await ClickyPackLoader().prepare(at: normal.root, entry: normal.entry)
    }

    func testTraversalHashMismatchAndDuplicateHashDoNotBypassValidation() async throws {
        for filename in ["../escape.wav", "/escape.wav", "sub/file.wav", "sub\\file.wav", "%2e%2e.wav", "bad\0.wav", "https:sample.wav"] {
            var fixture = try Fixture()
            defer { fixture.dispose() }
            var files = try XCTUnwrap(fixture.manifest["files"] as? [[String: Any]])
            files[0]["filename"] = filename
            fixture.manifest["files"] = files
            try fixture.writeManifest()
            await assertPrepareFails(fixture)
        }
        let fixture = try Fixture()
        defer { fixture.dispose() }
        _ = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        try Data("changed".utf8).write(to: fixture.root.appendingPathComponent("fixture/press-b.wav"))
        await assertPrepareFails(fixture)
    }

    func testSymlinksNonregularFilesMissingLicenceAndPayloadLimits() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        _ = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let licence = fixture.root.appendingPathComponent("fixture/LICENCE.txt")
        let originalLicence = try Data(contentsOf: licence)
        try FileManager.default.removeItem(at: licence)
        await assertPrepareFails(fixture)
        try FileManager.default.createSymbolicLink(at: licence, withDestinationURL: fixture.root.appendingPathComponent("registry.json"))
        await assertPrepareFails(fixture)
        try FileManager.default.removeItem(at: licence)
        try FileManager.default.createDirectory(at: licence, withIntermediateDirectories: false)
        await assertPrepareFails(fixture)
        try FileManager.default.removeItem(at: licence)
        XCTAssertEqual(mkfifo(licence.path, 0o600), 0)
        await assertPrepareFails(fixture)
        try FileManager.default.removeItem(at: licence)
        try Data(repeating: 65, count: 256 * 1024 + 1).write(to: licence)
        await assertPrepareFails(fixture)
        try originalLicence.write(to: licence)
        let wavURL = fixture.root.appendingPathComponent("fixture/press-a.wav")
        try FileManager.default.removeItem(at: wavURL)
        try FileManager.default.createSymbolicLink(at: wavURL, withDestinationURL: fixture.root.appendingPathComponent("fixture/press-b.wav"))
        await assertPrepareFails(fixture)
        try FileManager.default.removeItem(at: wavURL)
        try Data(repeating: 0, count: 64 * 1024 + 1).write(to: wavURL)
        await assertPrepareFails(fixture)
        try fixture.wav.write(to: wavURL)
        _ = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let pack = fixture.root.appendingPathComponent("fixture")
        let moved = fixture.root.appendingPathComponent("moved")
        try FileManager.default.moveItem(at: pack, to: moved)
        try FileManager.default.createSymbolicLink(at: pack, withDestinationURL: moved)
        await assertPrepareFails(fixture)
    }

    func testPCMDecoderRejectsMalformedHeadersChunksFormatAndSilentData() throws {
        let good = Self.wav([16_384, -16_384])
        XCTAssertEqual(try ClickyPackLoader.decodePCM16(good, expectedFrames: 2), [0.5, -0.5])
        var corruptions = [Data(), Data(good.dropLast()), Self.wav([0, 0]), Self.wav([1])]
        for (index, byte): (Int, UInt8) in [(0, 0), (4, 0), (20, 3), (22, 2), (24, 0), (28, 1), (32, 4), (34, 8), (40, 3)] {
            var modified = good
            modified[index] = byte
            corruptions.append(modified)
        }
        for malformed in corruptions {
            XCTAssertThrowsError(try ClickyPackLoader.decodePCM16(malformed, expectedFrames: 2))
        }
        XCTAssertEqual(try ClickyPackLoader.decodePCM16(Self.wav([16_384, -16_384], oddChunk: true), expectedFrames: 2), [0.5, -0.5])
    }

    func testPinnedDirectorySurvivesPathReplacementAndRejectsRootSymlinks() throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let root = try ClickyPackDirectory(root: fixture.root)
        let pinned = try root.child("fixture")
        let expected = try pinned.read("LICENCE.txt", limit: 256 * 1024)
        let pack = fixture.root.appendingPathComponent("fixture")
        let moved = fixture.root.appendingPathComponent("moved")
        try FileManager.default.moveItem(at: pack, to: moved)
        try FileManager.default.createSymbolicLink(at: pack, withDestinationURL: moved)
        XCTAssertEqual(try pinned.read("LICENCE.txt", limit: 256 * 1024), expected)
        XCTAssertThrowsError(try root.child("fixture"))
        XCTAssertThrowsError(try ClickyPackDirectory(root: pack))
        XCTAssertThrowsError(try pinned.read("../registry.json", limit: 256 * 1024))
        XCTAssertEqual(try root.child("moved").read("LICENCE.txt", limit: 256 * 1024), expected)
    }

    func testCatalogueAndManifestSizeLimitsAndCatalogueSymlink() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let loader = ClickyPackLoader()
        let registry = fixture.root.appendingPathComponent("registry.json")
        try Data(repeating: 32, count: 2 * 1024 * 1024 + 1).write(to: registry)
        do {
            _ = try await loader.catalogue(at: fixture.root)
            XCTFail("Oversized catalogue accepted")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        try FileManager.default.removeItem(at: registry)
        try FileManager.default.createSymbolicLink(at: registry, withDestinationURL: fixture.root.appendingPathComponent("fixture/manifest.json"))
        do {
            _ = try await loader.catalogue(at: fixture.root)
            XCTFail("Catalogue symlink accepted")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        try FileManager.default.removeItem(at: registry)
        try fixture.writeRegistry([fixture.entry])
        let entries = try await loader.catalogue(at: fixture.root)
        XCTAssertEqual(entries.count, 1)
        try Data(repeating: 32, count: 256 * 1024 + 1).write(to: fixture.root.appendingPathComponent("fixture/manifest.json"))
        await assertPrepareFails(fixture)
        try fixture.writeManifest()
        _ = try await loader.prepare(at: fixture.root, entry: fixture.entry)
    }

    func testOptionalAttributionAndPreparedSelectionNeedNoFiles() async throws {
        var fixture = try Fixture()
        fixture.manifest["attribution"] = nil
        try fixture.writeManifest()
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        XCTAssertEqual(pack.attribution, "")
        XCTAssertTrue(pack.attributionRequired)
        XCTAssertTrue(pack.licenceText.contains("Permission granted"))
        fixture.dispose()
        var state = ClickyPackSelectionState()
        for _ in 0..<100 {
            let press = try XCTUnwrap(state.next(playback: pack.playback, keyCode: 0, release: false))
            let release = try XCTUnwrap(state.next(playback: pack.playback, keyCode: 0, release: true))
            XCTAssertNotNil(pack.samples[press.filename])
            XCTAssertNotNil(pack.samples[release.filename])
            XCTAssertEqual(press.variant, release.variant)
        }
    }

    func testCancelledLoadAndUnsafeSourceLinks() async throws {
        var fixture = try Fixture()
        defer { fixture.dispose() }
        fixture.manifest["source"] = ["repository": "https://user:secret@example.com/audio", "licenceEvidence": "file:///etc/passwd"]
        try fixture.writeManifest()
        let loader = ClickyPackLoader()
        let prepared = try await loader.prepare(at: fixture.root, entry: fixture.entry)
        XCTAssertNil(prepared.source.sourceURL)
        let root = fixture.root
        let entry = fixture.entry
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await loader.prepare(at: root, entry: entry)
        }
        do {
            _ = try await task.value
            XCTFail("Cancelled preparation succeeded")
        } catch is CancellationError {
        } catch {
            XCTFail("Expected CancellationError, got \(error)")
        }
        _ = try await loader.prepare(at: fixture.root, entry: fixture.entry)
    }
}
