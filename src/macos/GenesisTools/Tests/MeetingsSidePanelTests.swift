import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The settings side panel's sections (F8; R8, R26, G52 to G55).
/// Snapshots: `MEETINGS_PEOPLE_SHOTS=<folder>` renders the panel there at inspector widths, light and dark.
@MainActor
final class MeetingsSidePanelTests: XCTestCase {
    private func defaults() throws -> (UserDefaults, String) {
        let suite = "meetings.sidepanel.tests.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: suite)), suite)
    }

    func testEveryWindowSettingHasARowInItsSection() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let sections = SidePanelCatalog.windowSections(defaults)
        XCTAssertEqual(sections.map(\.id), ["playback", "rows", "notices", "panes", "people"])
        let keys = Set(sections.flatMap(\.windowKeys))
        for key in ["meetings.rows.typedAnswer", "meetings.rows.returnKey", "meetings.rows.choiceKeys", "meetings.rows.decided",
                    "meetings.rows.order", "meetings.rows.lowPriority", "meetings.rows.askReach", "meetings.rows.autoplayNext",
                    "meetings.rows.autoplayDelaySec", "meetings.notices.seconds", "meetings.notices.plainSeconds",
                    "meetings.notices.place", "meetings.notices.maxVisible", "meetings.playback.view", "meetings.playback.speed",
                    "meetings.playback.repeat", "meetings.playback.afterClip", "meetings.playback.moreSec",
                    "meetings.playback.contextSec", "meetings.playback.rewindSec", "meetings.playback.stack.clickInQuestion",
                    "meetings.playback.stack.onTopEnd", "meetings.playback.stack.depth", "meetings.timeline.shown",
                    "meetings.timeline.hoverDelayMs", "meetings.transcript.followPlayback", "meetings.screen.besidePlayback",
                    "meetings.items.transcriptPane", "meetings.people.renameBlur", "meetings.people.offerNew"] {
            XCTAssertTrue(keys.contains(key), "the panel has a row for \(key)")
        }
        XCTAssertTrue(sections.allSatisfy(\.isDefault), "fresh defaults: every section is at its defaults")
        XCTAssertEqual(sections.first { $0.id == "notices" }?.settingsAnchor, MeetingsSettingsPages.noticesAnchor)
    }

    func testAChangedValueShowsAndTheSectionCanReset() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("confirm", forKey: "meetings.rows.returnKey")
        defaults.set(1.5, forKey: "meetings.playback.speed")
        let sections = SidePanelCatalog.windowSections(defaults)
        let rows = try XCTUnwrap(sections.first { $0.id == "rows" })
        let returnKey = try XCTUnwrap(rows.rows.first { $0.id == "meetings.rows.returnKey" })
        XCTAssertEqual(returnKey.value, .text("confirm"))
        XCTAssertEqual(returnKey.valueTitle, "Confirm")
        XCTAssertFalse(rows.isDefault)
        let speed = try XCTUnwrap(sections.first { $0.id == "playback" }?.rows.first { $0.id == "meetings.playback.speed" })
        XCTAssertEqual(speed.valueTitle, "1.5×")
        XCTAssertEqual(sections.first { $0.id == "panes" }?.isDefault, true)
    }

    func testTheWordsMatchTheSettingsPage() {
        XCTAssertEqual(SidePanelWords.choice("always", key: MeetingsPreferences.typedAnswerKey), "On every question")
        XCTAssertEqual(SidePanelWords.choice("always", key: "meetings.rows.askReach"), "Always")
        XCTAssertEqual(SidePanelWords.choice("moment", key: "meetings.playback.view"), "Its Moment")
        XCTAssertEqual(SidePanelWords.number(300, key: "meetings.timeline.hoverDelayMs"), "300 ms")
        XCTAssertEqual(SidePanelWords.number(30, key: "meetings.notices.seconds"), "30 s")
        XCTAssertEqual(SidePanelWords.number(0.5, key: "meetings.playback.rewindSec"), "0.5 s")
        XCTAssertEqual(SidePanelWords.number(3, key: "meetings.notices.maxVisible"), "3")
    }

    func testTheEngineSectionReadsTheListenConfigAndWritesPresets() throws {
        let listen = JSONValue.object([
            "padSec": .number(3),
            "tone": .object(["enabled": .bool(false), "leadSec": .number(0.6),
                             "sound": .object(["hz": .number(523), "sec": .number(0.3), "volume": .number(0.35)])]),
        ])
        let engine = SidePanelCatalog.engineSection(listen: listen)
        XCTAssertEqual(engine.footnote, "Applies from the next clip. The clip that plays keeps its sound.")
        XCTAssertEqual(engine.enginePaths, ["global.playback.listen.padSec", "global.playback.listen.tone.enabled",
                                            "global.playback.listen.tone.leadSec", "global.playback.listen.tone.sound",
                                            "global.playback.listen.longestClipSec"])
        let rows = Dictionary(uniqueKeysWithValues: engine.rows.map { ($0.id, $0) })
        let sound = try XCTUnwrap(rows["global.playback.listen.tone.sound"])
        XCTAssertEqual(sound.value, .text("soft"), "523 Hz 0.3 s at 0.35 is the Soft preset")
        XCTAssertEqual(rows["global.playback.listen.tone.enabled"]?.value, .flag(false))
        XCTAssertEqual(rows["global.playback.listen.longestClipSec"]?.value, .number(30), "a missing key reads as its default")
        XCTAssertEqual(SidePanelCatalog.configValue(.text("click"), for: sound),
                       .object(["hz": .number(2000), "sec": .number(0.03), "volume": .number(0.7)]))
        XCTAssertEqual(SidePanelCatalog.sound(.text("beep"), for: sound)?.hz, 880)
        XCTAssertFalse(engine.isDefault)

        let fresh = SidePanelCatalog.engineSection(listen: .null)
        let pad = try XCTUnwrap(fresh.rows.first)
        XCTAssertEqual(pad.value, .text(""), "padSec has no default: the first listen asks")
        XCTAssertEqual(pad.valueTitle, "Not set")
        XCTAssertTrue(fresh.isDefault)
        XCTAssertNil(SidePanelCatalog.configValue(.text(""), for: pad))
        let custom = SidePanelCatalog.engineSection(listen: .object(["tone": .object(["sound": .object(["hz": .number(440)])])]))
        XCTAssertEqual(custom.rows.first { $0.id.hasSuffix(".tone.sound") }?.valueTitle, "Custom")
    }

    /// F8: a window row writes the type its reader reads, so `integer(forKey:)` and the typed accessors see it.
    func testAWindowRowWritesTheTypeItsReaderReads() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        SidePanelCatalog.write(.number(5), key: MeetingsPreferences.Notices.maxVisible.key, to: defaults)
        XCTAssertTrue(defaults.object(forKey: MeetingsPreferences.Notices.maxVisible.key) is Int)
        XCTAssertEqual(MeetingsPreferences.Notices.maxVisible.value(defaults), 5)
        SidePanelCatalog.write(.number(1.25), key: MeetingsPreferences.Playback.speed.key, to: defaults)
        XCTAssertEqual(MeetingsPreferences.Playback.speed.value(defaults), 1.25)
        SidePanelCatalog.write(.text("top"), key: MeetingsPreferences.noticePlaceKey, to: defaults)
        XCTAssertEqual(MeetingsPreferences.noticePlace(defaults), .top)
        SidePanelCatalog.write(.flag(false), key: MeetingsPreferences.Panes.timelineShown.key, to: defaults)
        XCTAssertFalse(MeetingsPreferences.Panes.timelineShown.value(defaults))
        SidePanelCatalog.write(.text("commit"), key: MeetingsPreferences.People.renameBlur.key, to: defaults)
        XCTAssertEqual(MeetingsPreferences.People.renameBlur.value(defaults), .commit)
        XCTAssertEqual(SidePanelCatalog.segments("global.playback.listen.tone.sound"), ["global", "playback", "listen", "tone", "sound"])
    }

    /// F8, G55, a-review-fix-swift open question 4: the panel's open state and folds are remembered (not settings), and
    /// the notice placement is an observed value the panel changes at once.
    func testThePanelStateIsRememberedAndTheNoticePlaceIsObserved() throws {
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        XCTAssertFalse(model.sidePanelOpen)
        model.sidePanelOpen = true
        model.sidePanelFolded = ["panes"]
        let again = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        XCTAssertTrue(again.sidePanelOpen, "the next window opens with the panel")
        XCTAssertEqual(again.sidePanelFolded, ["panes"])
        XCTAssertEqual(again.noticePlace, .bottom)
        SidePanelCatalog.write(.text("top"), key: MeetingsPreferences.noticePlaceKey, to: defaults)
        again.windowSettingsChanged()
        XCTAssertEqual(again.noticePlace, .top, "the panel's change moves the stack without a relaunch")
        again.remembersPanel = false
        again.sidePanelOpen = false
        XCTAssertTrue(defaults.bool(forKey: MeetingsWindowModel.sidePanelOpenKey), "a snapshot run keeps the saved state")
    }

    /// G53: at the 900 pt minimum the three columns left the meeting about 120 pt beside the panel, so the list steps
    /// aside while the panel is open in a window narrower than sidebar, list, meeting and panel.
    func testTheListStepsAsideForThePanelInANarrowWindow() {
        XCTAssertTrue(MeetingsRootView.panelHidesList(width: 900, panelOpen: true))
        XCTAssertTrue(MeetingsRootView.panelHidesList(width: 1319, panelOpen: true))
        XCTAssertFalse(MeetingsRootView.panelHidesList(width: 1320, panelOpen: true))
        XCTAssertFalse(MeetingsRootView.panelHidesList(width: 900, panelOpen: false))
        XCTAssertFalse(MeetingsRootView.panelHidesList(width: 0, panelOpen: true), "before the first layout: three columns")
    }

    /// F8: a config write names the value it replaces, the same on the service and the command (decision 13).
    func testAnEngineWriteNamesTheValueItReplaces() {
        let raw = JSONValue.object(["global": .object(["playback": .object(["listen": .object(["padSec": .number(3)])])])])
        let path = ["global", "playback", "listen", "padSec"]
        let set = MeetingsConfigWrite.set(path, .number(5), readFrom: raw)
        XCTAssertEqual(set, .set(path: path, value: .number(5), expect: .number(3)))
        XCTAssertEqual(set.args, ["config", "set", #"["global","playback","listen","padSec"]"#, "5", "--expect", "3"])
        XCTAssertEqual(set.pathArgument, #"["global","playback","listen","padSec"]"#, "the service reads the same JSON path")
        let unset = MeetingsConfigWrite.unset(["global", "playback", "listen", "longestClipSec"], readFrom: raw)
        XCTAssertEqual(unset.args, ["config", "unset", #"["global","playback","listen","longestClipSec"]"#, "--expect", "null"])
    }

    func testTonePresetsMatchTheEngineDefault() {
        XCTAssertEqual(TonePreset.beep.sound, ToneSound(hz: 880, sec: 0.15, volume: 0.6), "DEFAULT_TONE_SOUND in config.ts")
        XCTAssertEqual(TonePreset.matching(ToneSound(hz: 880, sec: 0.15, volume: 0.6)), .beep)
        XCTAssertNil(TonePreset.matching(ToneSound(hz: 881.5, sec: 0.15, volume: 0.6)))
    }

    func testSnapshotsOfThePanel() throws {
        guard let folder = ProcessInfo.processInfo.environment["MEETINGS_PEOPLE_SHOTS"] else { return }
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("confirm", forKey: "meetings.rows.returnKey")
        let listen = JSONValue.object(["padSec": .number(3), "tone": .object(["leadSec": .number(0.4)])])
        let sections = [SidePanelCatalog.engineSection(listen: listen)] + SidePanelCatalog.windowSections(defaults)
        for dark in [false, true] {
            for width in [280.0, 340.0] {
                try PeopleSnapshot.render(
                    SidePanelSections(sections: sections, change: { _, _ in }, reset: { _ in }, playTone: { _ in },
                                      openSettings: { _ in }, folded: ["panes"], setFolded: { _, _ in })
                        .frame(height: 1500),
                    width: width, dark: dark, to: "\(folder)/side-panel-\(Int(width))-\(dark ? "dark" : "light").png")
            }
        }
    }
}
