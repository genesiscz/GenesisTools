import Foundation
import XCTest

@testable import GenesisKit

final class ClickyTests: XCTestCase {
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
