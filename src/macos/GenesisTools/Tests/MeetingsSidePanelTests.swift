import AppKit
import Foundation
import GenesisKit
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The settings side panel's sections (F8; R8, R26, G52 to G55) and the engine's version 5 rows (decisions 8 and 9).
/// Snapshots: `MEETINGS_UI_SNAPSHOTS=<folder>` (or `MEETINGS_PEOPLE_SHOTS`) renders the panel there at inspector widths,
/// light and dark, and the Settings page's Clip and Tone card.
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
        XCTAssertEqual(sections.map(\.id), ["playback", "rows", "notices", "panes", "transcript", "people"])
        let keys = Set(sections.flatMap(\.windowKeys))
        for key in ["meetings.rows.typedAnswer", "meetings.rows.returnKey", "meetings.rows.choiceKeys", "meetings.rows.decided",
                    "meetings.rows.order", "meetings.rows.lowPriority", "meetings.rows.askReach", "meetings.rows.autoplayNext",
                    "meetings.rows.autoplayDelaySec", "meetings.notices.seconds", "meetings.notices.plainSeconds",
                    "meetings.notices.place", "meetings.notices.maxVisible", "meetings.playback.view", "meetings.playback.speed",
                    "meetings.playback.repeat", "meetings.playback.afterClip", "meetings.playback.moreSec",
                    "meetings.playback.contextSec", "meetings.playback.rewindSec", "meetings.playback.stack.clickInQuestion",
                    "meetings.playback.stack.onTopEnd", "meetings.playback.stack.depth", "meetings.timeline.shown",
                    "meetings.timeline.hoverDelayMs", "meetings.timeline.pinLanes", "meetings.timeline.waveform",
                    "meetings.transcript.followPlayback", "meetings.screen.besidePlayback",
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

    /// `tone.presets` as the service answers it on a Mac without the Tink sound.
    private static let presets: [MeetingsAPI.TonePresets.Preset] = [
        .init(name: "beep", label: "Beep", kind: "sine", volume: 0.6, hz: 880, sec: 0.15, file: nil, available: true),
        .init(name: "soft", label: "Soft", kind: "sine", volume: 0.35, hz: 523, sec: 0.3, file: nil, available: true),
        .init(name: "click", label: "Click", kind: "sine", volume: 0.7, hz: 2000, sec: 0.03, file: nil, available: true),
        .init(name: "glass", label: "Glass", kind: "file", volume: 0.6, hz: nil, sec: nil, file: "/System/Library/Sounds/Glass.aiff", available: true),
        .init(name: "tink", label: "Tink", kind: "file", volume: 0.6, hz: nil, sec: nil, file: "/System/Library/Sounds/Tink.aiff", available: false),
    ]

    /// The engine section of `listen`, with the presets above unless `presets` says otherwise; `files` exist.
    private func engine(_ listen: [String: JSONValue], presets: TonePresetList? = nil,
                        files: Set<String> = []) -> (SidePanelSection, [String: SidePanelRow]) {
        let section = SidePanelCatalog.engineSection(listen: .object(listen), presets: presets ?? .loaded(Self.presets),
                                                     fileExists: { files.contains($0) })
        return (section, Dictionary(uniqueKeysWithValues: section.rows.map { ($0.id, $0) }))
    }

    private static let soundPath = "global.playback.listen.tone.sound"
    private static let volumePath = "global.playback.listen.tone.sound.volume"

    /// Decision 9 (config version 5): two pads, before and after the asked spot, choices 1 to 10 s, no default. An unset
    /// side follows the other one, as the engine reads it; a write goes to its own key and never to padSec.
    func testThePadIsTwoRowsBeforeAndAfterTheAskedSpot() throws {
        let (fresh, freshRows) = engine([:])
        let before = try XCTUnwrap(freshRows["global.playback.listen.padBeforeSec"])
        let after = try XCTUnwrap(freshRows["global.playback.listen.padAfterSec"])
        XCTAssertEqual(Array(fresh.rows.prefix(2)).map(\.title), ["Before the asked spot", "After it"])
        XCTAssertEqual(before.choices.map(\.title), ["Not set", "1 s", "2 s", "3 s", "5 s", "10 s"])
        XCTAssertEqual(before.value, .text(""), "no default: the first listen asks")
        XCTAssertEqual(after.valueTitle, "Not set")
        XCTAssertTrue(before.isDefault && after.isDefault)

        let (_, rows) = engine(["padBeforeSec": .number(3)])
        let setBefore = try XCTUnwrap(rows["global.playback.listen.padBeforeSec"])
        let sameAfter = try XCTUnwrap(rows["global.playback.listen.padAfterSec"])
        XCTAssertEqual(setBefore.valueTitle, "3 s")
        XCTAssertEqual(sameAfter.valueTitle, "Same as before", "one side set stands for both")
        XCTAssertEqual(SidePanelCatalog.enginePick(.number(5), for: sameAfter), .set(.number(5)))
        XCTAssertEqual(SidePanelCatalog.enginePick(.text(""), for: setBefore), .unset)
        XCTAssertEqual(SidePanelCatalog.enginePick(.number(3), for: setBefore), .nothing, "the value it shows writes nothing")

        let (_, odd) = engine(["padBeforeSec": .number(4), "padAfterSec": .number(1)])
        XCTAssertEqual(odd["global.playback.listen.padBeforeSec"]?.choices.map(\.title), ["Same as after", "1 s", "2 s", "3 s", "4 s", "5 s", "10 s"])
        XCTAssertFalse(fresh.enginePaths.contains { $0.hasSuffix(".padSec") }, "version 5 refuses padSec")
    }

    /// Decision 8: the sound menu lists `tone.presets`, greys a sound this Mac lacks, and writes a whole `{ preset }`.
    func testTheSoundRowListsTheNamedTonesAndWritesAPreset() throws {
        let (section, rows) = engine(["tone": .object(["enabled": .bool(false), "leadSec": .number(0.6),
                                                       "sound": .object(["hz": .number(523), "sec": .number(0.3), "volume": .number(0.35)])])])
        XCTAssertEqual(section.footnote, "Applies from the next clip. The clip that plays keeps its sound.")
        XCTAssertEqual(section.enginePaths, ["global.playback.listen.padBeforeSec", "global.playback.listen.padAfterSec",
                                             "global.playback.listen.tone.enabled", "global.playback.listen.tone.leadSec",
                                             Self.soundPath, "global.playback.listen.longestClipSec"],
                       "the volume goes with the sound: one unset, no second write")
        let sound = try XCTUnwrap(rows[Self.soundPath])
        XCTAssertEqual(sound.value, .text("soft"), "a stored sine with Soft's pitch and length is Soft")
        XCTAssertEqual(sound.choices.map(\.title), ["Beep", "Soft", "Click", "Glass", "Tink", "Sound file…"])
        XCTAssertEqual(sound.choices.filter { !$0.available }.map(\.title), ["Tink"])
        XCTAssertEqual(sound.choices.last?.startsGroup, true)
        XCTAssertEqual(sound.tone, .sine(hz: 523, sec: 0.3, volume: 0.35), "Play plays the saved sound")
        XCTAssertNil(sound.problem)
        XCTAssertEqual(rows["global.playback.listen.tone.enabled"]?.value, .flag(false))
        XCTAssertFalse(section.isEnabled(sound), "off while Tone is off")
        XCTAssertEqual(SidePanelCatalog.enginePick(.text("click"), for: sound), .set(.object(["preset": .string("click")])))
        XCTAssertEqual(SidePanelCatalog.enginePick(.text("soft"), for: sound), .nothing)
        XCTAssertEqual(SidePanelCatalog.enginePick(SidePanelCatalog.chooseFileValue, for: sound), .chooseFile)
        XCTAssertFalse(section.isDefault)

        let (fresh, freshRows) = engine([:])
        XCTAssertEqual(freshRows[Self.soundPath]?.value, .text("beep"))
        XCTAssertEqual(freshRows[Self.volumePath]?.value, .number(0.6))
        XCTAssertTrue(fresh.isDefault)

        let (_, custom) = engine(["tone": .object(["sound": .object(["hz": .number(440)])])])
        XCTAssertEqual(custom[Self.soundPath]?.valueTitle, "Custom (440 Hz)")
        XCTAssertEqual(custom[Self.soundPath]?.choices.map(\.title).suffix(2), ["Custom (440 Hz)", "Sound file…"])
        XCTAssertEqual(SidePanelCatalog.enginePick(SidePanelCatalog.customValue, for: try XCTUnwrap(custom[Self.soundPath])), .nothing)
    }

    /// Need 2: a preset or a file reads as itself, not as Beep's values; before the presets answer, the default still
    /// reads as Beep and a stored preset by its name.
    func testASavedPresetOrFileReadsAsItself() throws {
        let (_, preset) = engine(["tone": .object(["sound": .object(["preset": .string("glass")])])])
        let glass = try XCTUnwrap(preset[Self.soundPath])
        XCTAssertEqual(glass.valueTitle, "Glass")
        XCTAssertEqual(glass.tone, .preset("glass", volume: nil))
        XCTAssertEqual(preset[Self.volumePath]?.value, .number(0.6), "a preset without a volume plays at its own")

        let (_, missing) = engine(["tone": .object(["sound": .object(["preset": .string("tink")])])])
        XCTAssertEqual(missing[Self.soundPath]?.problem, "Tink is not on this Mac, so clips do not play. Pick another sound.")

        let (_, waiting) = engine(["tone": .object(["sound": .object(["preset": .string("soft")])])], presets: .loading)
        XCTAssertEqual(waiting[Self.soundPath]?.valueTitle, "Soft")
        XCTAssertEqual(waiting[Self.soundPath]?.choices.map(\.title), ["Soft", "Sound file…"])
        let (_, fresh) = engine([:], presets: .unavailable("the service did not answer"))
        XCTAssertEqual(fresh[Self.soundPath]?.valueTitle, "Beep")
        XCTAssertEqual(fresh[Self.soundPath]?.detail.hasSuffix("The named sounds did not load: the service did not answer."), true)
    }

    /// Need 3: "Sound file…" writes `{ file }` with the absolute path the panel picked; a cancel writes nothing. A saved
    /// file shows its name, its path as the tooltip, and a sentence when it is gone.
    func testASoundFileIsPickedShownAndNamedWhenItIsGone() async throws {
        let path = "/Users/alice/Sounds/chime.m4a"
        let (_, present) = engine(["tone": .object(["sound": .object(["file": .string(path), "volume": .number(0.6)])])], files: [path])
        let file = try XCTUnwrap(present[Self.soundPath])
        XCTAssertEqual(file.value, .file(path))
        XCTAssertEqual(file.valueTitle, "chime.m4a")
        XCTAssertEqual(file.valueHelp, path)
        XCTAssertNil(file.problem)
        XCTAssertEqual(file.choices.suffix(2).map(\.title), ["chime.m4a", "Sound file…"])
        XCTAssertEqual(file.choices.suffix(2).first?.startsGroup, true)

        let (_, gone) = engine(["tone": .object(["sound": .object(["file": .string(path), "volume": .number(0.6)])])])
        XCTAssertEqual(gone[Self.soundPath]?.problem, "chime.m4a is not there, so clips do not play. Pick another sound.")

        var written: [JSONValue?] = []
        var askedNear: [String?] = []
        let picked = expectation(description: "a file was picked")
        SidePanelCatalog.applyEngine(SidePanelCatalog.chooseFileValue, for: file, chooseFile: { near in
            askedNear.append(near)
            return "/Users/alice/Sounds/bell.wav"
        }, write: { written.append($0); picked.fulfill() })
        await fulfillment(of: [picked], timeout: 2)
        XCTAssertEqual(written, [.object(["file": .string("/Users/alice/Sounds/bell.wav")])])
        XCTAssertEqual(askedNear, [path], "the panel opens in the saved file's folder")

        let cancelled = expectation(description: "the panel was cancelled")
        SidePanelCatalog.applyEngine(SidePanelCatalog.chooseFileValue, for: file, chooseFile: { _ in
            cancelled.fulfill()
            return nil
        }, write: { written.append($0) })
        await fulfillment(of: [cancelled], timeout: 2)
        await Task.yield()
        XCTAssertEqual(written.count, 1, "a cancel writes nothing")
    }

    /// Need 4: the volume row is a 0 to 1 slider at `tone.sound.volume`; its default is the sound's own volume.
    func testTheVolumeSliderWritesTheSoundsVolume() throws {
        let (_, rows) = engine(["tone": .object(["sound": .object(["preset": .string("soft"), "volume": .number(0.2)])])])
        let volume = try XCTUnwrap(rows[Self.volumePath])
        XCTAssertEqual(volume.slider, SidePanelRow.Slider(range: 0...1, step: 0.05))
        XCTAssertEqual(volume.value, .number(0.2))
        XCTAssertEqual(volume.defaultValue, .number(0.35), "Soft's own volume")
        XCTAssertFalse(volume.isDefault)
        XCTAssertEqual(SidePanelCatalog.enginePick(.number(0.45), for: volume), .set(.number(0.45)))
        XCTAssertEqual(SidePanelWords.percent(0.45), "45 %")
        XCTAssertEqual(SidePanelWords.fileName("/Users/alice/Sounds/a-long-chime-name.m4a"), "a-long…ame.m4a")
        XCTAssertEqual(SidePanelWords.fileName("/Users/alice/Sounds/chime.m4a"), "chime.m4a")
        let (_, own) = engine(["tone": .object(["sound": .object(["preset": .string("click")])])])
        XCTAssertEqual(own[Self.volumePath]?.value, .number(0.7))
        XCTAssertEqual(own[Self.volumePath]?.isDefault, true)
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
        let raw = JSONValue.object(["global": .object(["playback": .object(["listen": .object(["padBeforeSec": .number(3)])])])])
        let path = ["global", "playback", "listen", "padBeforeSec"]
        let set = MeetingsConfigWrite.set(path, .number(5), readFrom: raw)
        XCTAssertEqual(set, .set(path: path, value: .number(5), expect: .number(3)))
        XCTAssertEqual(set.args, ["config", "set", #"["global","playback","listen","padBeforeSec"]"#, "5", "--expect", "3"])
        XCTAssertEqual(set.pathArgument, #"["global","playback","listen","padBeforeSec"]"#, "the service reads the same JSON path")
        let unset = MeetingsConfigWrite.unset(["global", "playback", "listen", "longestClipSec"], readFrom: raw)
        XCTAssertEqual(unset.args, ["config", "unset", #"["global","playback","listen","longestClipSec"]"#, "--expect", "null"])
    }

    func testTheEngineDefaultIsTheBeepSine() throws {
        XCTAssertEqual(MeetingsAPI.ToneSoundSetting.engineDefault, .sine(hz: 880, sec: 0.15, volume: 0.6), "DEFAULT_TONE_SOUND in config.ts")
        XCTAssertEqual(SidePanelCatalog.toneSetting(.null), .engineDefault)
        XCTAssertEqual(SidePanelCatalog.toneSetting(.object([:])), .engineDefault, "a stored {} reads as the default sine")
        XCTAssertNil(SidePanelCatalog.namedSine(.sine(hz: 881.5, sec: 0.15, volume: 0.6), in: Self.presets))
        XCTAssertEqual(SidePanelCatalog.namedSine(.sine(hz: 880, sec: 0.15, volume: 0.2), in: Self.presets)?.name, "beep",
                       "the volume is its own row")
    }

    func testSnapshotsOfThePanel() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let folder = environment["MEETINGS_UI_SNAPSHOTS"] ?? environment["MEETINGS_PEOPLE_SHOTS"] else { return }
        let (defaults, suite) = try defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("confirm", forKey: "meetings.rows.returnKey")
        let presets = TonePresetList.loaded(Self.presets)
        let states: [(String, JSONValue)] = [
            ("preset", .object(["padBeforeSec": .number(3), "tone": .object(["leadSec": .number(0.4),
                                                                              "sound": .object(["preset": .string("soft"), "volume": .number(0.5)])])])),
            ("gone-file", .object(["padBeforeSec": .number(2), "padAfterSec": .number(5),
                                   "tone": .object(["sound": .object(["file": .string("/Users/alice/Sounds/a-long-chime-name.m4a"),
                                                                       "volume": .number(0.6)])])])),
        ]
        for (name, listen) in states {
            let engine = SidePanelCatalog.engineSection(listen: listen, presets: presets, fileExists: { _ in false })
            let sections = [engine] + SidePanelCatalog.windowSections(defaults)
            for dark in [false, true] {
                for width in [280.0, 340.0] {
                    try PeopleSnapshot.render(
                        SidePanelSections(sections: sections, change: { _, _ in }, reset: { _ in }, playTone: { _ in },
                                          openSettings: { _ in }, folded: ["playback", "rows", "notices", "panes", "transcript", "people"],
                                          setFolded: { _, _ in })
                            .frame(height: 760),
                        width: width, dark: dark, to: "\(folder)/side-panel-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
                }
            }
            // The Settings window is dark; a glass card is invisible to this capture, so the card takes a solid theme.
            try PeopleSnapshot.render(
                MeetingsCatalogCard(section: engine, change: { _, _ in }, reset: { _ in }, playTone: { _ in })
                    .padding(20)
                    .environment(\.nativeSettingsTheme, .graphite),
                width: 680, dark: true, to: "\(folder)/settings-card-\(name)-dark.png")
        }
    }
}
