import AVFoundation
import Combine
import Foundation
import SwiftUI
import UserNotifications
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

    func testLegacyStatisticsGainHistoryWithoutInventingOldEvents() throws {
        let legacy = Data("{\"presses\":250,\"releases\":240,\"sessions\":4,\"startedAt\":700000000}".utf8)
        var statistics = try JSONDecoder().decode(ClickyStatistics.self, from: legacy)
        XCTAssertEqual(statistics.presses, 250)
        XCTAssertNil(statistics.historyStartedAt)
        XCTAssertTrue(statistics.minutes.isEmpty)
        statistics.record(keyCode: 12, release: false, at: date(14, 32), calendar: calendar)
        statistics.record(keyCode: 12, release: true, at: date(14, 32), calendar: calendar)
        XCTAssertEqual(statistics.presses, 251)
        XCTAssertEqual(statistics.releases, 241)
        XCTAssertEqual(statistics.keys, [12: 1])
        XCTAssertEqual(statistics.minutes.count, 1)
        XCTAssertEqual(statistics.minutes.values.first?.presses, 1)
        XCTAssertEqual(statistics.minutes.values.first?.releases, 1)
        XCTAssertEqual(try JSONDecoder().decode(ClickyStatistics.self, from: JSONEncoder().encode(statistics)), statistics)
    }

    func testAnalyticsRetentionPreservesLifetimeCountsAndLongerCoarseHistory() {
        var statistics = ClickyStatistics()
        let start = date(12)
        for day in 0...731 {
            statistics.record(keyCode: 0, release: false,
                at: calendar.date(byAdding: .day, value: day, to: start)!, calendar: calendar)
        }
        XCTAssertEqual(statistics.presses, 732)
        XCTAssertEqual(statistics.keys[0], 732)
        XCTAssertLessThanOrEqual(statistics.minutes.count, 32)
        XCTAssertLessThanOrEqual(statistics.hours.count, 368)
        XCTAssertLessThanOrEqual(statistics.days.count, 731)
        XCTAssertGreaterThan(statistics.days.count, statistics.hours.count)
        XCTAssertGreaterThan(statistics.hours.count, statistics.minutes.count)
    }

    func testChartBinningBoundsWorkWithoutLosingCounts() {
        let points = (0..<10000).map { NativeTimePoint(date: Date(timeIntervalSince1970: Double($0) * 60), value: 1) }
        let bins = NativeChartSampling.bins(points: points, start: Date(timeIntervalSince1970: 0),
            end: Date(timeIntervalSince1970: 600000), step: 60)
        XCTAssertLessThanOrEqual(bins.count, 1201)
        XCTAssertEqual(bins.reduce(0) { $0 + $1.value }, 10000)
        let narrow = NativeChartSampling.bins(points: points, start: Date(timeIntervalSince1970: 300000),
            end: Date(timeIntervalSince1970: 300600), step: 60)
        XCTAssertEqual(narrow.count, 10)
        XCTAssertEqual(narrow.reduce(0) { $0 + $1.value }, 10)
    }

    func testExampleStatisticsHaveConsistentTotalsAndRecentDataWithoutStorage() {
        let example = ClickyStatistics.example(now: date(23, 30), calendar: calendar)
        XCTAssertEqual(example.keys.values.reduce(0, +), example.presses)
        XCTAssertEqual(example.minutes.values.reduce(0) { $0 + $1.presses }, example.presses)
        XCTAssertEqual(example.hours.values.reduce(0) { $0 + $1.presses }, example.presses)
        XCTAssertEqual(example.days.values.reduce(0) { $0 + $1.presses }, example.presses)
        let recent = Int(date(23).timeIntervalSince1970 / 60)
        XCTAssertGreaterThan(example.minutes.filter { $0.key >= recent }.values.reduce(0) { $0 + $1.presses }, 0)
    }

    func testCivilTimeHeatmapAndDailyChartHandleRepeatedDSTHour() {
        let parser = ISO8601DateFormatter()
        var statistics = ClickyStatistics()
        statistics.record(keyCode: 0, release: false, at: parser.date(from: "2026-10-25T00:15:00Z")!, calendar: calendar)
        statistics.record(keyCode: 0, release: false, at: parser.date(from: "2026-10-25T01:15:00Z")!, calendar: calendar)
        XCTAssertEqual(statistics.hours.count, 2)
        XCTAssertEqual(statistics.days.count, 1)
        let heat = statistics.weekdayHeatmap(calendar: calendar)
        XCTAssertEqual(heat.first { $0.row == 6 && $0.column == 2 }?.value, 2)
        let start = calendar.startOfDay(for: parser.date(from: "2026-10-25T00:15:00Z")!)
        let end = calendar.date(byAdding: .day, value: 2, to: start)!
        let bins = NativeChartSampling.bins(points: statistics.timeline(.day), start: start, end: end,
            step: 86400, calendar: calendar)
        XCTAssertEqual(bins.count, 2)
        XCTAssertEqual(bins[1].date.timeIntervalSince(bins[0].date), 25 * 3600)
        XCTAssertEqual(bins.reduce(0) { $0 + $1.value }, 2)
    }

    @MainActor
    func testAnalyticsPublisherCoalescesInputWithoutCopyingEachEventSnapshot() {
        let store = ClickyAnalyticsStore()
        var reads = 0
        var statistics = ClickyStatistics()
        for _ in 0..<100 {
            statistics.record(keyCode: 1, release: false, at: date(13), calendar: calendar)
            store.stage { reads += 1; return statistics }
        }
        XCTAssertEqual(reads, 0, "The input callback must not build a chart snapshot for every key")
        store.flush(statistics)
        XCTAssertEqual(store.snapshot.presses, 100)
        XCTAssertEqual(store.snapshot.keys[1], 100)
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
        XCTAssertEqual(sections.map(\.id), ["general", "clicky", "about"])
        XCTAssertEqual(sections[1].title, "Clicky")
        XCTAssertEqual(sections[1].pages.map(\.id),
            ["clicky.sound", "clicky.sleep", "clicky.notifications", "clicky.stats", "clicky.visualizer"])
        XCTAssertFalse(model.enabled)
        let controller = ClickyWindowController(model: model)
        XCTAssertTrue(controller.model === model)
        XCTAssertTrue(controller.settings.store.appearance === model.appearance)
        XCTAssertNil(controller.window)
        model.shutdown()
    }

    @MainActor
    func testNotificationPermissionRoutesDeniedToSettingsAndRetainsActivationPreference() async {
        let suite = "dev.genesis.clicky.notifications.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var authorization: UNAuthorizationStatus = .denied
        var requests = 0
        var settingsOpens = 0
        let client = NativeNotificationClient(status: { authorization }, request: {
            requests += 1
            authorization = .authorized
            return true
        }, openSettings: { settingsOpens += 1; return true })
        let model = ClickyModel(defaults: defaults, observeSystemEvents: false, notificationClient: client)
        defer { model.shutdown() }
        await model.refreshNotificationPermission()
        model.setActivationNotifications(true)
        XCTAssertTrue(model.preferences.notifications, "Blocked permission must not silently reset the preference")
        XCTAssertEqual(model.notificationActionTitle, "Open Notification Settings")
        await model.performNotificationAction()
        XCTAssertEqual(requests, 0, "A denied permission cannot display another prompt")
        XCTAssertEqual(settingsOpens, 1)
        XCTAssertTrue(model.preferences.notifications)
        authorization = .authorized
        await model.refreshNotificationPermission()
        XCTAssertEqual(model.notificationStatus, "Allowed")
        model.setActivationNotifications(false)
        XCTAssertFalse(model.preferences.notifications)
        authorization = .notDetermined
        await model.refreshNotificationPermission()
        await model.performNotificationAction()
        XCTAssertEqual(requests, 1, "First-time permission must still be requested")
        XCTAssertEqual(model.notificationStatus, "Allowed")
        XCTAssertFalse(model.preferences.notifications, "Permission alone does not change the activation preference")
        XCTAssertFalse(model.notificationBusy)
    }

    @MainActor
    func testNotificationSettingsFailureIsActionable() async {
        let suite = "dev.genesis.clicky.notifications.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = ClickyModel(defaults: defaults, observeSystemEvents: false,
            notificationClient: NativeNotificationClient(status: { .denied }, request: {
                XCTFail("Denied authorization must not be requested again")
                return false
            }, openSettings: { false }))
        defer { model.shutdown() }
        await model.performNotificationAction()
        XCTAssertTrue(model.error?.contains("System Settings") == true)
        XCTAssertFalse(model.notificationBusy)
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
        // The test also disposes on purpose before it checks selection; a second dispose is a no-op.
        defer { fixture.dispose() }
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

extension ClickyPackTests {
    private enum IntegrationFailure: LocalizedError, Sendable {
        case corrupt, missingRequest
        var errorDescription: String? {
            switch self {
            case .corrupt: return "Synthetic pack checksum failed"
            case .missingRequest: return "The synthetic request was not pending"
            }
        }
    }

    private actor GatedIntegrationLoader: ClickyPackLoading {
        let entries: [ClickyPackEntry]
        let packs: [String: PreparedClickyPack]
        let catalogueStarted: @Sendable (Int) -> Void
        let prepareStarted: @Sendable (Int) -> Void
        private var catalogueHeld = false
        private var catalogues = 0
        private var prepares = 0
        private var catalogueWaiters: [Int: CheckedContinuation<[ClickyPackEntry], Error>] = [:]
        private var prepareWaiters: [Int: CheckedContinuation<PreparedClickyPack, Error>] = [:]
        private var prepareIDs: [Int: String] = [:]

        init(
            packs: [PreparedClickyPack],
            catalogueStarted: @escaping @Sendable (Int) -> Void = { _ in },
            prepareStarted: @escaping @Sendable (Int) -> Void = { _ in }
        ) {
            entries = packs.map(\.entry)
            self.packs = Dictionary(uniqueKeysWithValues: packs.map { ($0.entry.id, $0) })
            self.catalogueStarted = catalogueStarted
            self.prepareStarted = prepareStarted
        }

        func holdCatalogues() { catalogueHeld = true }
        func counts() -> (catalogue: Int, prepare: Int) { (catalogues, prepares) }

        func catalogue(at root: URL) async throws -> [ClickyPackEntry] {
            catalogues += 1
            let request = catalogues
            if !catalogueHeld {
                catalogueStarted(request)
                return entries
            }
            // Gates intentionally ignore task cancellation so the production generation guard is exercised.
            return try await withCheckedThrowingContinuation { continuation in
                catalogueWaiters[request] = continuation
                catalogueStarted(request)
            }
        }

        func prepare(at root: URL, entry: ClickyPackEntry) async throws -> PreparedClickyPack {
            prepares += 1
            let request = prepares
            prepareIDs[request] = entry.id
            return try await withCheckedThrowingContinuation { continuation in
                prepareWaiters[request] = continuation
                prepareStarted(request)
            }
        }

        func finishCatalogue(_ request: Int, entries: [ClickyPackEntry]? = nil) throws {
            guard let continuation = catalogueWaiters.removeValue(forKey: request) else {
                throw IntegrationFailure.missingRequest
            }
            continuation.resume(returning: entries ?? self.entries)
        }

        func finishPrepare(_ request: Int, failure: Bool = false) throws {
            guard let continuation = prepareWaiters.removeValue(forKey: request),
                let id = prepareIDs.removeValue(forKey: request), let pack = packs[id]
            else { throw IntegrationFailure.missingRequest }
            if failure {
                continuation.resume(throwing: IntegrationFailure.corrupt)
            } else {
                continuation.resume(returning: pack)
            }
        }

        func cancelPending() {
            for continuation in catalogueWaiters.values { continuation.resume(throwing: CancellationError()) }
            for continuation in prepareWaiters.values { continuation.resume(throwing: CancellationError()) }
            catalogueWaiters.removeAll()
            prepareWaiters.removeAll()
            prepareIDs.removeAll()
        }
    }

    private func integrationPack(_ base: PreparedClickyPack, id: String, manifestHash: String? = nil) -> PreparedClickyPack {
        PreparedClickyPack(
            entry: ClickyPackEntry(id: id, name: "Synthetic \(id)", kind: base.entry.kind, author: "Fixture Author",
                                  licence: base.entry.licence, manifest: "\(id)/manifest.json", licenceFile: "\(id)/LICENCE.txt"),
            manifestHash: manifestHash ?? ClickyPackLoader.sha256(Data(id.utf8)), licenceText: base.licenceText,
            source: base.source, permissions: base.permissions, attribution: base.attribution,
            attributionRequired: base.attributionRequired, playback: base.playback, samples: base.samples,
            decodedFrameCount: base.decodedFrameCount)
    }

    @MainActor
    private func integrationDefaults() -> (UserDefaults, String) {
        let suite = "dev.genesis.clicky.integration.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    @MainActor
    private func seedLibrary(_ defaults: UserDefaults, root: URL, count: Int = 1) throws -> [ClickyLibraryRecord] {
        let bookmark = try root.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
        let records = (0..<count).map {
            ClickyLibraryRecord(id: "fixture-library-\($0)", displayName: "Fixture library \($0)", bookmark: bookmark)
        }
        defaults.set(try JSONEncoder().encode(records), forKey: "clicky.libraries.v1")
        return records
    }

    @MainActor
    func testIntegrationNewestSelectionWinsWhenCancelledPreparationReturnsLate() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let base = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let a = integrationPack(base, id: "alpha")
        let b = integrationPack(base, id: "beta")
        let starts = [expectation(description: "alpha preparation"), expectation(description: "beta preparation")]
        let committed = expectation(description: "beta installed")
        let staleInstall = expectation(description: "alpha must not install")
        staleInstall.isInverted = true
        let loader = GatedIntegrationLoader(packs: [a, b], prepareStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        var installed: [ClickyPackReference] = []
        library.install = { reference, _ in
            installed.append(reference)
            if reference.packID == "alpha" { staleInstall.fulfill() } else { committed.fulfill() }
        }
        await library.refresh()
        let refA = ClickyPackReference(libraryID: record.id, packID: a.entry.id)
        let refB = ClickyPackReference(libraryID: record.id, packID: b.entry.id)
        library.select(refA)
        await fulfillment(of: [starts[0]], timeout: 2)
        library.select(refB)
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishPrepare(2)
        await fulfillment(of: [committed], timeout: 2)
        try await loader.finishPrepare(1)
        await fulfillment(of: [staleInstall], timeout: 0.05)
        XCTAssertEqual(installed, [refB])
        XCTAssertEqual(library.active?.reference, refB)
        XCTAssertNil(library.loading)
        XCTAssertNil(library.error)
    }

    @MainActor
    func testIntegrationBuiltInAndStopCancelPendingSelectionsWithoutLateInstallation() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let base = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        for stop in [false, true] {
            let started = expectation(description: "preparation started \(stop)")
            let forbidden = expectation(description: "cancelled preparation must not install \(stop)")
            forbidden.isInverted = true
            let loader = GatedIntegrationLoader(packs: [base], prepareStarted: { _ in started.fulfill() })
            addTeardownBlock { await loader.cancelPending() }
            let (defaults, suite) = integrationDefaults()
            defer { defaults.removePersistentDomain(forName: suite) }
            let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
            let library = ClickySoundLibrary(defaults: defaults, loader: loader)
            defer { library.stop() }
            library.install = { _, _ in forbidden.fulfill() }
            await library.refresh()
            library.select(ClickyPackReference(libraryID: record.id, packID: base.entry.id))
            await fulfillment(of: [started], timeout: 2)
            if stop { library.stop() } else { library.useBuiltIn() }
            try await loader.finishPrepare(1)
            await fulfillment(of: [forbidden], timeout: 0.05)
            XCTAssertNil(library.active)
            XCTAssertNil(library.loading)
        }
    }

    @MainActor
    func testIntegrationFailedAndUnavailableSelectionsPreservePreviousPackAndPreference() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let base = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let a = integrationPack(base, id: "valid")
        let b = integrationPack(base, id: "corrupt")
        let starts = [expectation(description: "valid preparation"), expectation(description: "corrupt preparation")]
        let installed = expectation(description: "valid installed")
        let failed = expectation(description: "failed load reported")
        let loader = GatedIntegrationLoader(packs: [a, b], prepareStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        var preferences = ClickyPreferences()
        var installationCount = 0
        library.install = { reference, _ in
            installationCount += 1
            preferences.selectedPack = reference
            installed.fulfill()
        }
        let subscription = library.$error.compactMap { $0 }.filter { $0.contains("checksum") }.sink { _ in failed.fulfill() }
        defer { subscription.cancel() }
        await library.refresh()
        let valid = ClickyPackReference(libraryID: record.id, packID: a.entry.id)
        library.select(valid)
        await fulfillment(of: [starts[0]], timeout: 2)
        try await loader.finishPrepare(1)
        await fulfillment(of: [installed], timeout: 2)
        library.select(ClickyPackReference(libraryID: record.id, packID: b.entry.id))
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishPrepare(2, failure: true)
        await fulfillment(of: [failed], timeout: 2)
        XCTAssertEqual(library.active?.reference, valid)
        XCTAssertEqual(preferences.selectedPack, valid)
        XCTAssertEqual(installationCount, 1)
        // Subscribed before the selection and matched on its own message, so the checksum error still published
        // from the previous step cannot fulfil it.
        let unavailable = expectation(description: "unavailable reported")
        let missingSubscription = library.$error.compactMap { $0 }.filter { $0.contains("unavailable") }
            .sink { _ in unavailable.fulfill() }
        defer { missingSubscription.cancel() }
        library.select(ClickyPackReference(libraryID: "missing-library", packID: "missing"))
        await fulfillment(of: [unavailable], timeout: 2)
        XCTAssertEqual(library.active?.reference, valid)
        XCTAssertEqual(preferences.selectedPack, valid)
        XCTAssertEqual(installationCount, 1)
        let calls = await loader.counts()
        XCTAssertEqual(calls.prepare, 2)
    }

    @MainActor
    func testIntegrationInstallationFailureKeepsTheLastSuccessfulMetadata() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let base = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let a = integrationPack(base, id: "valid")
        let b = integrationPack(base, id: "allocation-failure")
        let starts = [expectation(description: "first prepare"), expectation(description: "second prepare")]
        let installed = expectation(description: "first installed")
        let failed = expectation(description: "installation error")
        let loader = GatedIntegrationLoader(packs: [a, b], prepareStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        library.install = { reference, _ in
            if reference.packID == b.entry.id { throw IntegrationFailure.corrupt }
            installed.fulfill()
        }
        let subscription = library.$error.compactMap { $0 }.sink { _ in failed.fulfill() }
        defer { subscription.cancel() }
        await library.refresh()
        let reference = ClickyPackReference(libraryID: record.id, packID: a.entry.id)
        library.select(reference)
        await fulfillment(of: [starts[0]], timeout: 2)
        try await loader.finishPrepare(1)
        await fulfillment(of: [installed], timeout: 2)
        library.select(ClickyPackReference(libraryID: record.id, packID: b.entry.id))
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishPrepare(2)
        await fulfillment(of: [failed], timeout: 2)
        XCTAssertEqual(library.active?.reference, reference)
        XCTAssertEqual(library.active?.licenceText, base.licenceText)
    }

    @MainActor
    func testIntegrationRemovingLibraryInvalidatesAnOlderRefresh() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let started = expectation(description: "refresh catalogue started")
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { _ in started.fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        await loader.holdCatalogues()
        let refresh = Task { @MainActor in await library.refresh() }
        await fulfillment(of: [started], timeout: 2)
        library.remove(record.id)
        try await loader.finishCatalogue(1)
        await refresh.value
        XCTAssertTrue(library.records.isEmpty)
        XCTAssertTrue(library.rows.isEmpty)
        XCTAssertFalse(library.refreshing)
        let persisted = try JSONDecoder().decode([ClickyLibraryRecord].self, from: XCTUnwrap(defaults.data(forKey: "clicky.libraries.v1")))
        XCTAssertTrue(persisted.isEmpty)
    }

    @MainActor
    func testIntegrationNewerRefreshWinsWhenOlderCatalogueReturnsLast() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let base = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let older = integrationPack(base, id: "older")
        let newer = integrationPack(base, id: "newer")
        let starts = [expectation(description: "old refresh"), expectation(description: "new refresh")]
        let loader = GatedIntegrationLoader(packs: [older, newer], catalogueStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        _ = try seedLibrary(defaults, root: fixture.root)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        await loader.holdCatalogues()
        let first = Task { @MainActor in await library.refresh() }
        await fulfillment(of: [starts[0]], timeout: 2)
        let second = Task { @MainActor in await library.refresh() }
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishCatalogue(2, entries: [newer.entry])
        await second.value
        XCTAssertEqual(library.rows.map { $0.entry.id }, [newer.entry.id])
        try await loader.finishCatalogue(1, entries: [older.entry])
        await first.value
        XCTAssertEqual(library.rows.map { $0.entry.id }, [newer.entry.id])
        XCTAssertFalse(library.refreshing)
    }

    @MainActor
    func testIntegrationImportDuringOlderRefreshRetainsBothLibraries() async throws {
        let firstFixture = try Fixture()
        let secondFixture = try Fixture()
        defer { firstFixture.dispose(); secondFixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: firstFixture.root, entry: firstFixture.entry)
        let starts = [expectation(description: "older refresh"), expectation(description: "new import")]
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        _ = try seedLibrary(defaults, root: firstFixture.root)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        await loader.holdCatalogues()
        let refreshing = Task { @MainActor in await library.refresh() }
        await fulfillment(of: [starts[0]], timeout: 2)
        let importing = Task { @MainActor in await library.register(secondFixture.root) }
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishCatalogue(2)
        await importing.value
        XCTAssertEqual(library.records.count, 2)
        try await loader.finishCatalogue(1)
        await refreshing.value
        XCTAssertEqual(Set(library.rows.map { $0.reference.libraryID }), Set(library.records.map(\.id)))
        XCTAssertEqual(library.rows.count, 2)
    }

    @MainActor
    func testIntegrationStopPreventsPendingImportFromMutatingOrPersistingTheCatalogue() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let started = expectation(description: "import catalogue started")
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { _ in started.fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        await loader.holdCatalogues()
        let importing = Task { @MainActor in await library.register(fixture.root) }
        await fulfillment(of: [started], timeout: 2)
        library.stop()
        try await loader.finishCatalogue(1)
        await importing.value
        XCTAssertTrue(library.records.isEmpty)
        XCTAssertTrue(library.rows.isEmpty)
        XCTAssertNil(defaults.data(forKey: "clicky.libraries.v1"))
    }

    @MainActor
    func testIntegrationCancelledCallerImportDoesNotCommitAndNormalImportWorks() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let starts = [expectation(description: "cancelled import"), expectation(description: "normal import")]
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        await loader.holdCatalogues()
        let cancelled = Task { @MainActor in await library.register(fixture.root) }
        await fulfillment(of: [starts[0]], timeout: 2)
        cancelled.cancel()
        try await loader.finishCatalogue(1)
        await cancelled.value
        XCTAssertTrue(library.records.isEmpty)
        let normal = Task { @MainActor in await library.register(fixture.root) }
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishCatalogue(2)
        await normal.value
        XCTAssertEqual(library.records.count, 1)
        XCTAssertEqual(library.rows.count, 1)
        XCTAssertNil(library.error)
    }

    @MainActor
    func testIntegrationConcurrentImportsCannotExceedTheLibraryLimit() async throws {
        let firstFixture = try Fixture()
        let secondFixture = try Fixture()
        defer { firstFixture.dispose(); secondFixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: firstFixture.root, entry: firstFixture.entry)
        let starts = [expectation(description: "first import at limit"), expectation(description: "second import at limit")]
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { starts[$0 - 1].fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        _ = try seedLibrary(defaults, root: firstFixture.root, count: 31)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        await loader.holdCatalogues()
        let first = Task { @MainActor in await library.register(firstFixture.root) }
        await fulfillment(of: [starts[0]], timeout: 2)
        let second = Task { @MainActor in await library.register(secondFixture.root) }
        await fulfillment(of: [starts[1]], timeout: 2)
        try await loader.finishCatalogue(1)
        await first.value
        try await loader.finishCatalogue(2)
        await second.value
        XCTAssertEqual(library.records.count, 32)
        let persisted = try JSONDecoder().decode([ClickyLibraryRecord].self, from: XCTUnwrap(defaults.data(forKey: "clicky.libraries.v1")))
        XCTAssertEqual(persisted.count, 32)
        XCTAssertNotNil(library.error)
    }

    @MainActor
    func testIntegrationBankCacheStaysAtThreeDeduplicatesAndReplacesSameReference() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let base = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let engine = AVAudioEngine()
        try engine.enableManualRenderingMode(.offline, format: XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)), maximumFrameCount: 8192)
        let audio = ClickyAudio(engine: engine)
        defer { audio.stop() }
        for id in ["alpha", "beta", "gamma", "delta"] {
            let pack = integrationPack(base, id: id)
            let reference = ClickyPackReference(libraryID: "fixture-library", packID: id)
            try audio.install(reference: reference, pack: pack)
            XCTAssertLessThanOrEqual(audio.cachedPackCount, 3)
            XCTAssertLessThanOrEqual(audio.cachedPackFrames, 3 * ClickyPackLoader.maximumFrames)
        }
        XCTAssertEqual(audio.cachedPackCount, 3)
        XCTAssertEqual(audio.cachedPackFrames, 15)
        let reference = ClickyPackReference(libraryID: "fixture-library", packID: "delta")
        let replacement = integrationPack(base, id: "delta", manifestHash: String(repeating: "d", count: 64))
        try audio.install(reference: reference, pack: replacement)
        try audio.install(reference: reference, pack: replacement)
        XCTAssertEqual(audio.cachedPackCount, 3)
        XCTAssertEqual(audio.cachedPackFrames, 15)
        XCTAssertEqual(audio.selectedPackReference, reference)
        audio.useBuiltIn()
        XCTAssertNil(audio.selectedPackReference)
        XCTAssertEqual(audio.cachedPackCount, 3)
    }

    @MainActor
    func testIntegrationPreparedPlaybackRendersAfterSourcesDisappearAndNeverCallsLoaderAgain() async throws {
        var fixture = try Fixture()
        let frameCount = 960
        let waves: [(String, Double, Double)] = [("press-a.wav", 400, 0.25), ("press-b.wav", 800, 0.08),
                                              ("release-a.wav", 1200, 0.10), ("release-b.wav", 1600, 0.06)]
        var declarations: [[String: Any]] = []
        for (name, frequency, amplitude) in waves {
            let samples = (0..<frameCount).map { index in
                Int16((sin(2 * Double.pi * frequency * Double(index) / 48_000) * amplitude * 32767).rounded())
            }
            let bytes = Self.wav(samples)
            try bytes.write(to: fixture.root.appendingPathComponent("fixture/\(name)"))
            declarations.append(["filename": name, "sha256": ClickyPackLoader.sha256(bytes), "frames": frameCount])
        }
        fixture.manifest["files"] = declarations
        try fixture.writeManifest()
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let started = expectation(description: "one preparation")
        let installed = expectation(description: "one installation")
        let loader = GatedIntegrationLoader(packs: [pack], prepareStarted: { _ in started.fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        let engine = AVAudioEngine()
        let stereo = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
        try engine.enableManualRenderingMode(.offline, format: stereo, maximumFrameCount: 8192)
        let audio = ClickyAudio(engine: engine)
        defer { audio.stop() }
        library.install = { reference, prepared in
            try audio.install(reference: reference, pack: prepared)
            installed.fulfill()
        }
        await library.refresh()
        library.select(ClickyPackReference(libraryID: record.id, packID: pack.entry.id))
        await fulfillment(of: [started], timeout: 2)
        try await loader.finishPrepare(1)
        await fulfillment(of: [installed], timeout: 2)
        fixture.dispose()
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.root.path))
        var preferences = ClickyPreferences()
        preferences.volume = 1
        preferences.randomizedPitch = true
        preferences.spatialAudio = false
        func render(_ key: UInt16, release: Bool) throws -> Double {
            XCTAssertTrue(try audio.playSelected(keyCode: key, release: release, preview: false, preferences: preferences, pan: 0))
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: 8192))
            XCTAssertEqual(try engine.renderOffline(8192, to: buffer), .success)
            let channel = try XCTUnwrap(buffer.floatChannelData?[0])
            return (0..<Int(buffer.frameLength)).reduce(0) { $0 + Double(channel[$1] * channel[$1]) }
        }
        let pressA = try render(0, release: false)
        let pressB = try render(1, release: false)
        let releaseB = try render(1, release: true)
        let releaseA = try render(0, release: true)
        XCTAssertGreaterThan(pressA, 0)
        XCTAssertGreaterThan(releaseA, 0)
        XCTAssertGreaterThan(pressA, pressB * 5)
        XCTAssertGreaterThan(releaseA, releaseB * 1.8)
        XCTAssertLessThan(releaseA, pressA)
        preferences.releaseSounds = false
        _ = try render(0, release: false)
        XCTAssertEqual(try render(0, release: true), 0, accuracy: 0.000001)
        preferences.releaseSounds = true
        audio.clearHeldKeys()
        XCTAssertEqual(try render(0, release: true), 0, accuracy: 0.000001)
        let calls = await loader.counts()
        XCTAssertEqual(calls.prepare, 1)
        XCTAssertEqual(calls.catalogue, 1)
        XCTAssertEqual(audio.cachedPackCount, 1)
        XCTAssertEqual(audio.cachedPackFrames, 4 * frameCount)
    }
}

extension ClickyTests {
    @MainActor
    func testIntegrationLegacyPreferencesRestoreEveryExistingFieldWithoutExternalSelection() throws {
        var original = ClickyPreferences()
        original.selectedSwitch = .paper
        original.volume = 0.73
        original.releaseSounds = false
        original.repeatSounds = true
        original.collectStats = false
        original.excludedApplications = ["com.example.fixture"]
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        legacy.removeValue(forKey: "selectedPack")
        let data = try JSONSerialization.data(withJSONObject: legacy)
        let decoded = try JSONDecoder().decode(ClickyPreferences.self, from: data)
        XCTAssertEqual(decoded, original)
        XCTAssertNil(decoded.selectedPack)
        let monitor = InputMonitorStub()
        let (model, defaults, suite) = monitorFixture(monitor, snapshot: true)
        model.shutdown()
        defaults.set(data, forKey: "clicky.preferences.v1")
        defer { defaults.removePersistentDomain(forName: suite) }
        let restored = ClickyModel(defaults: defaults, previewOnly: true, inputMonitor: monitor, observeSystemEvents: false)
        defer { restored.shutdown() }
        XCTAssertEqual(restored.preferences, original)
        XCTAssertEqual(restored.selectedSoundName, "Paper")
        XCTAssertFalse(restored.enabled)
        XCTAssertEqual(monitor.requests, 0)
        XCTAssertEqual(monitor.starts, 0)
    }

    func testIntegrationExternalPreferencesNamespaceLibraryIDsAndRoundTrip() throws {
        let first = ClickyPackReference(libraryID: "fixture-library-one", packID: "same-pack")
        let second = ClickyPackReference(libraryID: "fixture-library-two", packID: "same-pack")
        XCTAssertNotEqual(first, second)
        var preferences = ClickyPreferences()
        preferences.selectedSwitch = .honey
        preferences.selectedPack = first
        let decoded = try JSONDecoder().decode(ClickyPreferences.self, from: JSONEncoder().encode(preferences))
        XCTAssertEqual(decoded, preferences)
        XCTAssertEqual(decoded.selectedPack, first)
        XCTAssertEqual(decoded.selectedSwitch, .honey)
    }

    @MainActor
    func testIntegrationMissingRestoredLibraryKeepsExternalPreferenceAndBuiltInFallbackWithoutInput() async throws {
        let monitor = InputMonitorStub()
        let suite = "dev.genesis.clicky.missing-library.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var saved = ClickyPreferences()
        saved.selectedSwitch = .honey
        saved.selectedPack = ClickyPackReference(libraryID: "missing-library", packID: "fixture")
        defaults.set(try JSONEncoder().encode(saved), forKey: "clicky.preferences.v1")
        let model = ClickyModel(defaults: defaults, previewOnly: true, inputMonitor: monitor, observeSystemEvents: false)
        defer { model.shutdown() }
        let unavailable = expectation(description: "restore unavailable")
        let subscription = model.soundLibrary.$error.compactMap { $0 }.sink { _ in unavailable.fulfill() }
        defer { subscription.cancel() }
        await fulfillment(of: [unavailable], timeout: 2)
        XCTAssertEqual(model.preferences.selectedPack, saved.selectedPack)
        XCTAssertEqual(model.selectedSoundName, "Honey")
        XCTAssertNil(model.soundLibrary.active)
        XCTAssertFalse(model.enabled)
        XCTAssertEqual(monitor.requests, 0)
        XCTAssertEqual(monitor.starts, 0)
        model.selectBuiltIn(.violet)
        XCTAssertNil(model.preferences.selectedPack)
        XCTAssertEqual(model.selectedSoundName, "Violet")
        XCTAssertNil(model.soundLibrary.error)
    }
}

extension ClickyPackTests {
    @MainActor
    func testIntegrationRemovingLibraryCancelsItsPendingSelection() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let started = expectation(description: "selection before removal")
        let forbidden = expectation(description: "removed library must not install")
        forbidden.isInverted = true
        let loader = GatedIntegrationLoader(packs: [pack], prepareStarted: { _ in started.fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        library.install = { _, _ in forbidden.fulfill() }
        await library.refresh()
        library.select(ClickyPackReference(libraryID: record.id, packID: pack.entry.id))
        await fulfillment(of: [started], timeout: 2)
        library.remove(record.id)
        try await loader.finishPrepare(1)
        await fulfillment(of: [forbidden], timeout: 0.05)
        XCTAssertNil(library.active)
        XCTAssertNil(library.loading)
        XCTAssertTrue(library.records.isEmpty)
        XCTAssertTrue(library.rows.isEmpty)
    }

    @MainActor
    func testIntegrationRestoreCannotReapplySavedPackAfterBuiltInChoiceDuringRefresh() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let started = expectation(description: "restore refresh")
        let forbidden = expectation(description: "stale restore must not prepare")
        forbidden.isInverted = true
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { _ in started.fulfill() },
                                            prepareStarted: { _ in forbidden.fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let record = try XCTUnwrap(seedLibrary(defaults, root: fixture.root).first)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        await loader.holdCatalogues()
        library.restore(ClickyPackReference(libraryID: record.id, packID: pack.entry.id))
        await fulfillment(of: [started], timeout: 2)
        library.useBuiltIn()
        try await loader.finishCatalogue(1)
        await fulfillment(of: [forbidden], timeout: 0.05)
        XCTAssertNil(library.active)
        XCTAssertNil(library.loading)
        let calls = await loader.counts()
        XCTAssertEqual(calls.prepare, 0)
    }

    @MainActor
    func testIntegrationRestoringCatalogueWithoutSelectionDoesNotPrepareAudio() async throws {
        let fixture = try Fixture()
        defer { fixture.dispose() }
        let pack = try await ClickyPackLoader().prepare(at: fixture.root, entry: fixture.entry)
        let catalogue = expectation(description: "restored catalogue")
        let forbidden = expectation(description: "metadata browsing must not prepare")
        forbidden.isInverted = true
        let loader = GatedIntegrationLoader(packs: [pack], catalogueStarted: { _ in catalogue.fulfill() },
                                            prepareStarted: { _ in forbidden.fulfill() })
        addTeardownBlock { await loader.cancelPending() }
        let (defaults, suite) = integrationDefaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        _ = try seedLibrary(defaults, root: fixture.root)
        let library = ClickySoundLibrary(defaults: defaults, loader: loader)
        defer { library.stop() }
        library.restore(nil)
        await fulfillment(of: [catalogue], timeout: 2)
        await fulfillment(of: [forbidden], timeout: 0.05)
        XCTAssertEqual(library.rows.count, 1)
        XCTAssertNil(library.active)
        let calls = await loader.counts()
        XCTAssertEqual(calls.catalogue, 1)
        XCTAssertEqual(calls.prepare, 0)
    }
}
