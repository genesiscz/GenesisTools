import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The Wave B Swift review's fixes (WaveB-b-review-fix-swift.md): each test names the finding it pins.
@MainActor
final class MeetingsReviewFixTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() async throws {
        suite = "meetings.reviewfix.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    // MARK: Finding 1: the row's controls are pressable at rest

    /// Whether each `LiveButton` in a view's body is pressable at rest. A hosted SwiftUI view shows no accessibility
    /// children without an accessibility client, so the test reads the body's structure: a resting row (`.liveRow`)
    /// draws a LiveButton's label alone unless it is `pressable` (GenesisKit `Style/LiveControls.swift`).
    private func liveButtonsPressable(_ value: Any, depth: Int = 0) -> [Bool] {
        guard depth < 24 else { return [] }
        let mirror = Mirror(reflecting: value)
        if String(describing: type(of: value)).hasPrefix("LiveButton<") {
            return [mirror.children.first { $0.label == "pressable" }?.value as? Bool ?? false]
        }
        return mirror.children.flatMap { liveButtonsPressable($0.value, depth: depth + 1) }
    }

    func testARowsPlayControlIsPressableWhileItsRowRests() {
        let player = MomentPlayer(engine: .init(cut: { _ in throw CancellationError() }, plan: { _ in .init(moment: nil, cannot: nil) },
                                                audio: { _ in throw CancellationError() }),
                                  load: { _ in throw CancellationError() }, defaults: defaults)
        let found = liveButtonsPressable(MomentButton(player: player, meeting: "m1", target: .time(309), label: "05:09").body)
        XCTAssertEqual(found, [true], "the one play control presses in a resting row")
    }

    func testASpeakerChipsTimeIsPressableWhileItsBlockRests() {
        let found = liveButtonsPressable(SpeakerChip(speaker: "Speaker 1", startSec: 3, play: { _ in }).body)
        XCTAssertEqual(found, [true], "the block's time plays from a resting block")
    }

    // MARK: Finding 5: every opinionated pick of a view is a window setting with a row

    func testEveryHardCodedPickIsAWindowSettingWithARow() {
        let rows = Dictionary(uniqueKeysWithValues: SidePanelCatalog.windowSections(defaults).flatMap(\.rows).map { ($0.id, $0) })
        let picks: [(String, SidePanelValue)] = [
            ("meetings.transcript.dimPast", .flag(true)), ("meetings.transcript.avatars", .flag(true)),
            ("meetings.transcript.blockBreakSec", .number(0)), ("meetings.selection.clipSec", .number(5)),
            ("meetings.speakers.showQuestions", .flag(true)), ("meetings.speakers.hintChips", .number(3)),
            ("meetings.screen.height", .number(150)), ("meetings.timeline.collapseHeight", .number(560)),
            ("meetings.rows.openPersonPicker", .flag(true)), ("meetings.playback.keys", .flag(true)),
        ]
        for (key, value) in picks {
            XCTAssertEqual(rows[key]?.value, value, "\(key) has a row with the view's old pick")
            XCTAssertEqual(rows[key]?.defaultValue, value, "\(key)'s default is the view's old pick")
        }
        XCTAssertEqual(rows["meetings.transcript.blockBreakSec"]?.valueTitle, "Off")
        XCTAssertEqual(rows["meetings.timeline.collapseHeight"]?.choices.first?.title, "Never")
        XCTAssertEqual(rows["meetings.screen.height"]?.valueTitle, "150 pt")
        XCTAssertNil(MeetingsPreferences.Transcript.breakAfterGapSec(0), "Off keeps one block per turn")
        XCTAssertEqual(MeetingsPreferences.Transcript.breakAfterGapSec(10), 10)
        XCTAssertTrue(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 500, collapseHeight: 560))
        XCTAssertFalse(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 500, collapseHeight: 0), "Never folds")
        SidePanelCatalog.write(.number(0), key: MeetingsPreferences.Panes.collapseHeight.key, to: defaults)
        XCTAssertEqual(MeetingsPreferences.Panes.collapseHeight.value(defaults), 0, "Never is stored as a whole number and read back")
    }

    func testThePlayerKeysCanBeTurnedOff() {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        window.player.timeline.hoveredPin = "i1"
        defaults.set(false, forKey: MeetingsPreferences.Playback.keys.key)
        XCTAssertFalse(MeetingsPlaybackKeys.perform(.escape, model: window), "off: Esc goes on to the views")
        XCTAssertEqual(window.player.timeline.hoveredPin, "i1")
        defaults.removeObject(forKey: MeetingsPreferences.Playback.keys.key)
        XCTAssertTrue(MeetingsPlaybackKeys.perform(.escape, model: window), "on by default: Esc closes the pin card")
        XCTAssertNil(window.player.timeline.hoveredPin)
    }

    // MARK: Finding 6: a sub-option is off while its parent is off, and says why

    func testASubOptionIsOffWhileItsParentIsOff() throws {
        let toneOff = SidePanelCatalog.engineSection(listen: .object(["tone": .object(["enabled": .bool(false)])]))
        let lead = try XCTUnwrap(toneOff.rows.first { $0.id.hasSuffix(".tone.leadSec") })
        let sound = try XCTUnwrap(toneOff.rows.first { $0.id.hasSuffix(".tone.sound") })
        XCTAssertFalse(toneOff.isEnabled(lead))
        XCTAssertFalse(toneOff.isEnabled(sound))
        XCTAssertTrue(toneOff.detail(lead).hasSuffix("Off while Tone is off."))
        let toneOn = SidePanelCatalog.engineSection(listen: .object([:]))
        XCTAssertTrue(toneOn.rows.allSatisfy { toneOn.isEnabled($0) }, "Tone is on by default")
        XCTAssertEqual(toneOn.detail(lead), lead.detail)

        XCTAssertTrue(SidePanelCatalog.windowSections(defaults).allSatisfy { section in section.rows.allSatisfy(section.isEnabled) },
                      "fresh defaults: every row takes a change")
        defaults.set("off", forKey: MeetingsPreferences.Rows.autoplayNext.key)
        defaults.set("stop", forKey: MeetingsPreferences.Playback.afterClip.key)
        defaults.set(false, forKey: MeetingsPreferences.Panes.timelineShown.key)
        defaults.set(false, forKey: MeetingsPreferences.Panes.screenBesidePlayback.key)
        let sections = SidePanelCatalog.windowSections(defaults)
        func off(_ key: String) -> Bool {
            guard let section = sections.first(where: { $0.rows.contains { $0.id == key } }),
                  let row = section.rows.first(where: { $0.id == key }) else { return false }
            return !section.isEnabled(row)
        }
        for key in [MeetingsPreferences.Rows.autoplayDelaySec.key, MeetingsPreferences.Playback.moreSec.key,
                    MeetingsPreferences.Panes.hoverDelayMs.key, MeetingsPreferences.Panes.collapseHeight.key,
                    MeetingsPreferences.Panes.screenHeight.key] {
            XCTAssertTrue(off(key), "\(key) is off while its parent is off")
        }
        XCTAssertFalse(off(MeetingsPreferences.Panes.followPlayback.key), "a row with no parent stays on")
    }

    // MARK: Finding 11: the detail model reads the window's defaults

    func testTheDetailModelReadsTheWindowsDefaults() {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        XCTAssertTrue(detail.defaults === defaults, "a test's suite reaches the rows' settings and \"Do not ask again\"")
        XCTAssertTrue(MeetingDetailModel(id: "m", window: nil).defaults === UserDefaults.standard)
    }

    // MARK: Finding 3: a stored 0 is a value when the setting offers it

    func testAStoredZeroIsTheValueWhenTheChoicesOfferIt() {
        let hover = MeetingsPreferences.Panes.hoverDelayMs
        XCTAssertEqual(hover.value(defaults), 300, "unset reads the default")
        defaults.set(0, forKey: hover.key)
        XCTAssertEqual(hover.value(defaults), 0, "0 ms is one of the hover delay's choices")
        defaults.set(150, forKey: hover.key)
        XCTAssertEqual(hover.value(defaults), 150)
        let depth = MeetingsPreferences.Playback.stackDepth
        defaults.set(0, forKey: depth.key)
        XCTAssertEqual(depth.value(defaults), depth.defaultValue, "0 is no choice of the stack depth: the default")
        defaults.set(-2, forKey: depth.key)
        XCTAssertEqual(depth.value(defaults), depth.defaultValue)
        let delay = MeetingsWindowSetting(key: "meetings.test.delaySec", defaultValue: 1.0, choices: [0, 0.5, 1], title: "", detail: "")
        defaults.set(0.0, forKey: delay.key)
        XCTAssertEqual(delay.value(defaults), 0, "a Double choice of 0 reads as 0")
        let speed = MeetingsPreferences.Playback.speed
        defaults.set(0.0, forKey: speed.key)
        XCTAssertEqual(speed.value(defaults), 1, "0 is no speed: the default")
    }
}
