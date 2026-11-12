import AppKit
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - The settings side panel's content (F8; R26, R8, G52 to G55)
//
// One section per group of the window settings (`MeetingsPreferences.Rows`, `Notices`, `Playback`, `Panes`) and one
// for the engine's clip and tone (`global.playback.listen`: the pads before and after, the tone and its sound and volume,
// longestClipSec), with "Applies from the next clip" under the engine rows (G54) and "Reset to Defaults" per section
// (G55). The words and the choices come from the same `MeetingsWindowSetting` values the Settings page reads, and the
// Settings page draws the same sections as cards. Presentational: the rows come in as values, a change goes out through
// `change`, a reset through `reset`, the tone preview through `playTone`.

/// A value a panel row holds: a choice's raw text, a number, a switch, or a sound file.
enum SidePanelValue: Hashable {
    case text(String)
    case number(Double)
    case flag(Bool)
    /// The tone sound row's sound file: an absolute path.
    case file(String)
}

/// One choice a row's menu offers.
struct SidePanelChoice: Hashable {
    let value: SidePanelValue
    let title: String
    /// False shows the choice greyed out: a Mac alert sound this Mac lacks (`tone.presets`' `available`).
    var available = true
    /// A separator goes above it: "Sound file…" and a sound set by hand sit apart from the named sounds.
    var startsGroup = false
    /// A sentence about the choice the Settings page shows under it ("Not on this Mac.").
    var note: String?
}

/// The named tones the sound row offers (`tone.presets`, decision 8), as far as the window knows them.
enum TonePresetList: Equatable {
    case loading
    case loaded([MeetingsAPI.TonePresets.Preset])
    /// No answer: the row offers the saved sound and "Sound file…", and its detail says why.
    case unavailable(String)

    var presets: [MeetingsAPI.TonePresets.Preset]? {
        if case .loaded(let presets) = self { return presets }
        return nil
    }

    /// Asks the Meetings service. While the service starts (the window starts one when none answers) it asks again
    /// once a second, ten times; a cancelled ask answers `.loading`.
    @MainActor
    static func load(service: MeetingsService?, attempts: Int = 10) async -> TonePresetList {
        guard let service else { return .unavailable("this build has no Meetings service") }
        for attempt in 1...max(1, attempts) {
            do {
                return .loaded(try await service.call(MeetingsAPI.TonePresets.self, .init()).presets)
            } catch let unavailable as MeetingsService.Unavailable {
                if attempt >= attempts { return .unavailable(unavailable.reason) }
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return .loading }
            } catch {
                return .unavailable(asFailure(error).sentence)
            }
        }
        return .loading
    }
}

/// "Sound file…": an open panel for a sound the engine reads (wav, aiff, mp3, m4a). It answers the absolute path, or nil
/// when it was cancelled; a sheet on the key window when there is one.
@MainActor
enum ToneFileChooser {
    static let types: [UTType] = [.wav, .aiff, .mp3, .mpeg4Audio]

    static func choose(near saved: String?) async -> String? {
        let panel = NSOpenPanel()
        panel.title = "Choose a Tone Sound"
        panel.message = "The tone plays the first 2 seconds of the file."
        panel.prompt = "Use Sound"
        panel.allowedContentTypes = types
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let saved { panel.directoryURL = URL(fileURLWithPath: saved).deletingLastPathComponent() }
        let response: NSApplication.ModalResponse = await withCheckedContinuation { done in
            if let window = NSApp.keyWindow {
                panel.beginSheetModal(for: window) { done.resume(returning: $0) }
            } else {
                panel.begin { done.resume(returning: $0) }
            }
        }
        return response == .OK ? panel.url?.path : nil
    }
}

/// One row of the panel: where its value is stored, its words, its choices, its value and its default.
struct SidePanelRow: Identifiable, Equatable {
    enum Store: Hashable {
        /// A window setting in the app's defaults.
        case window(key: String)
        /// A meetings config value, written with `config.set` and reset with `config.unset`.
        case engine(path: String)
    }

    let store: Store
    let title: String
    let detail: String
    /// Empty for a switch.
    let choices: [SidePanelChoice]
    let value: SidePanelValue
    /// nil: the engine has no default (the pads, which the first `listen` asks for).
    let defaultValue: SidePanelValue?
    /// The tone sound row: the saved sound, which its Play button plays.
    var tone: MeetingsAPI.ToneSoundSetting?
    /// A slider instead of a menu (the tone's volume); the value is `.number`.
    var slider: Slider?
    /// A sentence beside the control when the saved value cannot work (a sound file that is gone).
    var problem: String?
    /// The whole value when its title is short (a sound file's path), as the control's tooltip.
    var valueHelp: String?

    struct Slider: Equatable {
        let range: ClosedRange<Double>
        let step: Double
    }
    /// A row of the same section this one needs: off while that row holds none of `values` (ux checklist, Settings:
    /// a sub-option is disabled while its parent is off, and says which).
    var requires: Requirement?

    struct Requirement: Equatable {
        let rowID: String
        let values: [SidePanelValue]
        /// What the row says while it is off: "Off while Tone is off."
        let words: String
    }

    var id: String {
        switch store {
        case .window(let key): return key
        case .engine(let path): return path
        }
    }

    var isSwitch: Bool { if case .flag = value { return true } else { return false } }
    var isDefault: Bool { defaultValue == nil ? value == .text("") : value == defaultValue }

    /// The title of the value shown, or the value itself when no choice has it.
    var valueTitle: String {
        choices.first { $0.value == value }?.title ?? SidePanelWords.title(value, store: store)
    }

    /// This row, off while the row `id` of its section holds none of `values`.
    func requiring(_ id: String, _ values: [SidePanelValue], _ words: String) -> SidePanelRow {
        var row = self
        row.requires = Requirement(rowID: id, values: values, words: words)
        return row
    }
}

/// One section: its rows, a line under them, and the Settings page card it matches.
struct SidePanelSection: Identifiable, Equatable {
    let id: String
    let title: String
    let rows: [SidePanelRow]
    /// A quiet line under the rows ("Applies from the next clip").
    var footnote: String?
    /// The Settings page card anchor ("notices"), for its "Settings…" link.
    var settingsAnchor: String?

    var isDefault: Bool { rows.allSatisfy(\.isDefault) }

    /// Whether `row` takes a change now: its requirement's row holds one of the values it needs.
    func isEnabled(_ row: SidePanelRow) -> Bool {
        guard let requirement = row.requires, let parent = rows.first(where: { $0.id == requirement.rowID }) else { return true }
        return requirement.values.contains(parent.value)
    }

    /// The row's detail line, with why it is off while it is.
    func detail(_ row: SidePanelRow) -> String {
        guard !isEnabled(row), let words = row.requires?.words else { return row.detail }
        return "\(row.detail) \(words)"
    }

    /// The app defaults keys a reset removes.
    var windowKeys: [String] { rows.compactMap { if case .window(let key) = $0.store { return key } else { return nil } } }
    /// The config paths a reset unsets. A path under another one of the list goes with it (the tone's volume with its
    /// sound), so no second write names a value the first one already removed.
    var enginePaths: [String] {
        let paths = rows.compactMap { row -> String? in if case .engine(let path) = row.store { return path } else { return nil } }
        return paths.filter { path in !paths.contains { path.hasPrefix($0 + ".") } }
    }
}

/// The words of the panel's choices: the same as the Settings page (G55).
enum SidePanelWords {
    /// A choice's words by its raw value, for every window setting with named choices.
    static let choiceTitles: [String: String] = [
        "always": "Always", "never": "Never", "auto": "Auto", "on": "On", "off": "Off",
        "edit": "Edit first", "confirm": "Confirm",
        "inPlace": "In place", "hidden": "Hidden",
        "priority": "Priority", "time": "Time",
        "hide": "Hide", "show": "Show",
        "afterAnswer": "After an answer",
        "hueAndGlyph": "Hue and glyph", "shade": "Shade only",
        "moment": "Its Moment", "meeting": "The meeting from there",
        "once": "Once",
        "stop": "Stop", "offerMore": "Offer more", "continue": "Play on",
        "push": "Push", "replace": "Replace", "return": "Return",
        "selectedTime": "At the selected time", "rewind": "Apply the rewind",
        "noChoices": "Without choices",
        "bottom": "Bottom", "top": "Top",
        "keepDraft": "Keep it", "commit": "Save it",
        "noExactMatch": "No one has the name", "noResults": "No one matches",
        "speakers": "By speaker", "plain": "One colour",
    ]

    /// Choices whose words depend on the key ("always" of the typed answer is "On every question").
    static let keyedTitles: [String: [String: String]] = [
        MeetingsPreferences.typedAnswerKey: ["always": "On every question", "noChoices": "Without choices"],
    ]

    /// A number choice of 0 that means "not at all" for its key.
    static let zeroTitles: [String: String] = [
        MeetingsPreferences.Transcript.blockBreakSec.key: "Off",
        MeetingsPreferences.Panes.collapseHeight.key: "Never",
    ]

    static func choice(_ raw: String, key: String) -> String {
        keyedTitles[key]?[raw] ?? choiceTitles[raw] ?? raw
    }

    /// A number with the unit its key names: "1.25×", "30 s", "300 ms", or a count.
    static func number(_ value: Double, key: String) -> String {
        if value == 0, let zero = zeroTitles[key] { return zero }
        let text = value == value.rounded() ? String(Int(value)) : String(format: "%g", value)
        if key.hasSuffix("speed") { return "\(text)×" }
        if key.hasSuffix("Height") || key.hasSuffix(".height") { return "\(text) pt" }
        if key.hasSuffix("Ms") { return "\(text) ms" }
        if key.hasSuffix("Sec") || key.hasSuffix("Seconds") || key.hasSuffix("seconds") || key.hasSuffix("plainSeconds") { return "\(text) s" }
        return text
    }

    /// A sound file's name for a menu: a long one keeps its start and its end ("a-long…ame.m4a"), so the menu stays
    /// narrow enough for the row's title in a 280 pt panel. The whole path is the control's tooltip.
    static func fileName(_ path: String, limit: Int = 14) -> String {
        let name = URL(fileURLWithPath: path).lastPathComponent
        guard name.count > limit else { return name }
        let tail = limit / 2
        return "\(name.prefix(limit - tail - 1))…\(name.suffix(tail))"
    }

    /// A volume of 0 to 1 as a percentage: "60 %".
    static func percent(_ value: Double) -> String { "\(Int((value * 100).rounded())) %" }

    static func title(_ value: SidePanelValue, store: SidePanelRow.Store) -> String {
        let key: String
        switch store {
        case .window(let name): key = name
        case .engine(let path): key = path
        }
        switch value {
        case .text(let raw): return raw.isEmpty ? "Not set" : choice(raw, key: key)
        case .number(let number): return SidePanelWords.number(number, key: key)
        case .flag(let on): return on ? "On" : "Off"
        case .file(let path): return fileName(path)
        }
    }
}

/// Builds the panel's sections from the window settings and the engine's listen config.
enum SidePanelCatalog {
    static let listenPath = "global.playback.listen"

    // MARK: Window rows

    static func row<Value: RawRepresentable & Equatable>(_ setting: MeetingsWindowSetting<Value>, value: Value) -> SidePanelRow
        where Value.RawValue == String {
        SidePanelRow(store: .window(key: setting.key), title: setting.title, detail: setting.detail,
                     choices: setting.choices.map { SidePanelChoice(value: .text($0.rawValue), title: SidePanelWords.choice($0.rawValue, key: setting.key)) },
                     value: .text(value.rawValue), defaultValue: .text(setting.defaultValue.rawValue))
    }

    static func row(_ setting: MeetingsWindowSetting<Double>, value: Double) -> SidePanelRow {
        numberRow(key: setting.key, title: setting.title, detail: setting.detail, choices: setting.choices, value: value,
                  defaultValue: setting.defaultValue)
    }

    static func row(_ setting: MeetingsWindowSetting<Int>, value: Int) -> SidePanelRow {
        numberRow(key: setting.key, title: setting.title, detail: setting.detail, choices: setting.choices.map(Double.init),
                  value: Double(value), defaultValue: Double(setting.defaultValue))
    }

    static func row(_ setting: MeetingsWindowSetting<Bool>, value: Bool) -> SidePanelRow {
        SidePanelRow(store: .window(key: setting.key), title: setting.title, detail: setting.detail, choices: [],
                     value: .flag(value), defaultValue: .flag(setting.defaultValue))
    }

    static func numberRow(key: String, title: String, detail: String, choices: [Double], value: Double, defaultValue: Double,
                          store: SidePanelRow.Store? = nil) -> SidePanelRow {
        let store = store ?? .window(key: key)
        var offered = choices
        if !offered.contains(value) { offered = (offered + [value]).sorted() }
        return SidePanelRow(store: store, title: title, detail: detail,
                            choices: offered.map { SidePanelChoice(value: .number($0), title: SidePanelWords.number($0, key: key)) },
                            value: .number(value), defaultValue: .number(defaultValue))
    }

    /// Every window section, with the values `defaults` holds.
    static func windowSections(_ defaults: UserDefaults = .standard) -> [SidePanelSection] {
        typealias Rows = MeetingsPreferences.Rows
        typealias Playback = MeetingsPreferences.Playback
        typealias Panes = MeetingsPreferences.Panes
        typealias Transcript = MeetingsPreferences.Transcript
        typealias Speakers = MeetingsPreferences.Speakers
        let playback = SidePanelSection(id: "playback", title: "Playback", rows: [
            row(Playback.view, value: Playback.view.value(defaults)),
            row(Playback.speed, value: Playback.speed.value(defaults)),
            row(Playback.animateActivity, value: Playback.animateActivity.value(defaults)),
            row(Playback.repeatClip, value: Playback.repeatClip.value(defaults)),
            row(Playback.afterClip, value: Playback.afterClip.value(defaults)),
            row(Playback.moreSec, value: Playback.moreSec.value(defaults))
                .requiring(Playback.afterClip.key, [.text(Playback.AfterClip.offerMore.rawValue), .text(Playback.AfterClip.continue.rawValue)],
                           "Off while a clip's end is Stop."),
            row(Playback.contextSec, value: Playback.contextSec.value(defaults)),
            row(Playback.rewindSec, value: Playback.rewindSec.value(defaults)),
            row(Playback.resumeAfterSeek, value: Playback.resumeAfterSeek.value(defaults)),
            row(Playback.clickInQuestion, value: Playback.clickInQuestion.value(defaults)),
            row(Playback.onTopEnd, value: Playback.onTopEnd.value(defaults)),
            row(Playback.stackDepth, value: Playback.stackDepth.value(defaults)),
            row(Playback.keys, value: Playback.keys.value(defaults)),
        ])
        let rows = SidePanelSection(id: "rows", title: "Rows", rows: [
            row(Rows.typedAnswer, value: Rows.typedAnswer.value(defaults)),
            row(Rows.returnKey, value: Rows.returnKey.value(defaults)),
            row(Rows.choiceKeys, value: Rows.choiceKeys.value(defaults)),
            row(Rows.decided, value: Rows.decided.value(defaults)),
            row(Rows.keepPlace, value: Rows.keepPlace.value(defaults)),
            row(Rows.stateLook, value: Rows.stateLook.value(defaults)),
            row(Rows.order, value: Rows.order.value(defaults)),
            row(Rows.lowPriority, value: Rows.lowPriority.value(defaults)),
            row(Rows.askReach, value: Rows.askReach.value(defaults)),
            row(Rows.autoplayNext, value: Rows.autoplayNext.value(defaults)),
            row(Rows.autoplayDelaySec, value: Rows.autoplayDelaySec.value(defaults))
                .requiring(Rows.autoplayNext.key, [.text(Rows.AutoplayNext.afterAnswer.rawValue)], "Off while the next row does not play."),
            row(Rows.openPersonPicker, value: Rows.openPersonPicker.value(defaults)),
        ])
        let notices = SidePanelSection(id: "notices", title: "Notices", rows: [
            numberRow(key: MeetingsPreferences.noticeSecondsKey, title: "A notice with Undo stays for",
                      detail: "After a confirm, a reject, a removal or an export. The pointer over the notices stops the time.",
                      choices: MeetingsPreferences.noticeChoices.map(Double.init),
                      value: Double(MeetingsPreferences.noticeSeconds(defaults)), defaultValue: 30),
            numberRow(key: MeetingsPreferences.plainNoticeSecondsKey, title: "Any other notice stays for",
                      detail: "A note without a button. An error stays until you close it.",
                      choices: MeetingsPreferences.plainNoticeChoices.map(Double.init),
                      value: Double(MeetingsPreferences.plainNoticeSeconds(defaults)),
                      defaultValue: NoticeStackTiming.standard.plainSeconds),
            SidePanelRow(store: .window(key: MeetingsPreferences.noticePlaceKey), title: "Notices float at",
                         detail: "Bottom: over the last rows. Top: under the meeting's header.",
                         choices: MeetingsPreferences.NoticePlace.allCases.map {
                             SidePanelChoice(value: .text($0.rawValue), title: SidePanelWords.choice($0.rawValue, key: MeetingsPreferences.noticePlaceKey))
                         },
                         value: .text(MeetingsPreferences.noticePlace(defaults).rawValue),
                         defaultValue: .text(MeetingsPreferences.NoticePlace.bottom.rawValue)),
            row(MeetingsPreferences.Notices.maxVisible, value: MeetingsPreferences.Notices.maxVisible.value(defaults)),
            row(MeetingsPreferences.Notices.pauseWhenInactive, value: MeetingsPreferences.Notices.pauseWhenInactive.value(defaults)),
            row(MeetingsPreferences.Notices.passScrollWhenFits, value: MeetingsPreferences.Notices.passScrollWhenFits.value(defaults)),
        ], settingsAnchor: MeetingsSettingsPages.noticesAnchor)
        let timelineOn: [SidePanelValue] = [.flag(true)]
        let panes = SidePanelSection(id: "panes", title: "Timeline and Panes", rows: [
            row(Panes.timelineShown, value: Panes.timelineShown.value(defaults)),
            row(Panes.hoverDelayMs, value: Panes.hoverDelayMs.value(defaults))
                .requiring(Panes.timelineShown.key, timelineOn, "Off while the timeline is off."),
            row(Panes.collapseHeight, value: Panes.collapseHeight.value(defaults))
                .requiring(Panes.timelineShown.key, timelineOn, "Off while the timeline is off: the dock is one line."),
            row(Panes.pinLanes, value: Panes.pinLanes.value(defaults))
                .requiring(Panes.timelineShown.key, timelineOn, "Off while the timeline is off."),
            row(Panes.waveform, value: Panes.waveform.value(defaults))
                .requiring(Panes.timelineShown.key, timelineOn, "Off while the timeline is off."),
            row(Panes.followPlayback, value: Panes.followPlayback.value(defaults)),
            row(Panes.screenBesidePlayback, value: Panes.screenBesidePlayback.value(defaults)),
            row(Panes.screenHeight, value: Panes.screenHeight.value(defaults))
                .requiring(Panes.screenBesidePlayback.key, [.flag(true)], "Off while the screen is not beside the sound."),
            row(Panes.transcriptPane, value: Panes.transcriptPane.value(defaults)),
            row(Panes.frameBoxes, value: Panes.frameBoxes.value(defaults)),
            row(Panes.frameFocusSingle, value: Panes.frameFocusSingle.value(defaults)),
            row(Panes.frameAutoDisplay, value: Panes.frameAutoDisplay.value(defaults)),
            row(Panes.frameSeek, value: Panes.frameSeek.value(defaults)),
            SidePanelRow(store: .window(key: MeetingsPreferences.lookKey), title: "Window look",
                         detail: "Aurora: raised surfaces and a colour per meaning, including list needs and counts. Candy: capsules and gradients. Glass: hairlines and colour on state. Classic: grey controls, needs and counts.",
                         choices: KitLook.allCases.map { SidePanelChoice(value: .text($0.rawValue), title: $0.title) },
                         value: .text(MeetingsPreferences.look(defaults).rawValue),
                         defaultValue: .text(MeetingsPreferences.defaultLook.rawValue)),
        ])
        let transcript = SidePanelSection(id: "transcript", title: "Transcript and Speakers", rows: [
            row(Transcript.dimPast, value: Transcript.dimPast.value(defaults)),
            row(Transcript.avatars, value: Transcript.avatars.value(defaults)),
            row(Transcript.blockBreakSec, value: Transcript.blockBreakSec.value(defaults)),
            row(Transcript.clipSec, value: Transcript.clipSec.value(defaults)),
            row(Speakers.showQuestions, value: Speakers.showQuestions.value(defaults)),
            row(Speakers.hintChips, value: Speakers.hintChips.value(defaults)),
        ])
        typealias People = MeetingsPreferences.People
        let people = SidePanelSection(id: "people", title: "Speaker Names", rows: [
            row(People.renameBlur, value: People.renameBlur.value(defaults)),
            row(People.offerNew, value: People.offerNew.value(defaults)),
        ])
        return [playback, rows, notices, panes, transcript, people]
    }

    /// The keys whose readers read a whole number (`integer(forKey:)`, `MeetingsWindowSetting<Int>`).
    static let integerKeys: Set<String> = [
        MeetingsPreferences.noticeSecondsKey, MeetingsPreferences.plainNoticeSecondsKey,
        MeetingsPreferences.Notices.maxVisible.key, MeetingsPreferences.Playback.stackDepth.key,
        MeetingsPreferences.Panes.hoverDelayMs.key, MeetingsPreferences.Panes.collapseHeight.key,
        MeetingsPreferences.Panes.screenHeight.key, MeetingsPreferences.Speakers.hintChips.key,
        MeetingsPreferences.Panes.pinLanes.key,
    ]

    /// Writes a window row's value into `defaults` as the type its reader reads (the side panel and the Settings page).
    static func write(_ value: SidePanelValue, key: String, to defaults: UserDefaults) {
        switch value {
        case .text(let raw): defaults.set(raw, forKey: key)
        case .number(let number):
            if integerKeys.contains(key) { defaults.set(Int(number.rounded()), forKey: key) } else { defaults.set(number, forKey: key) }
        case .flag(let on): defaults.set(on, forKey: key)
        // A sound file is an engine value; no window row holds one.
        case .file(let path): defaults.set(path, forKey: key)
        }
    }

    /// An engine row's config path as segments (`global.playback.listen.padBeforeSec`).
    static func segments(_ path: String) -> [String] { path.split(separator: ".").map(String.init) }

    // MARK: Engine rows

    /// The tone's sound (config version 5): a sine, a named preset or a sound file.
    static let toneSoundPath = "\(listenPath).tone.sound"
    /// The "Sound file…" choice: it opens a file panel, then writes the file it picked. Never stored.
    static let chooseFileValue = SidePanelValue.text("chooseFile")
    /// A sine set by hand that no named tone matches.
    static let customValue = SidePanelValue.text("custom")
    /// The pads a menu offers, in seconds.
    static let padChoices: [Double] = [1, 2, 3, 5, 10]

    /// The engine's clip and tone, from `config.read global.playback.listen` (null or missing keys read as defaults),
    /// with the named tones `presets` holds. `fileExists` checks a saved sound file (one stat per draw).
    static func engineSection(listen: JSONValue, presets: TonePresetList = .loading,
                              fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> SidePanelSection {
        func number(_ path: [String]) -> Double? { if case .number(let value) = listen.at(path) { return value } else { return nil } }
        func flag(_ path: [String]) -> Bool? { if case .bool(let value) = listen.at(path) { return value } else { return nil } }
        func text(_ path: [String]) -> String? { if case .string(let value) = listen.at(path) { return value } else { return nil } }
        let toneOn = "\(listenPath).tone.enabled"
        let setting = toneSetting(listen.at(["tone", "sound"]))
        return SidePanelSection(id: "engine", title: "Clip and Tone", rows: padRows(before: number(["padBeforeSec"]), after: number(["padAfterSec"])) + [
            SidePanelRow(store: .engine(path: toneOn), title: "Tone",
                         detail: "A short tone just before the asked spot, in the window and the terminal.",
                         choices: [], value: .flag(flag(["tone", "enabled"]) ?? true), defaultValue: .flag(true)),
            numberRow(key: "leadSec", title: "Tone before the spot", detail: "How long before the asked spot the tone sounds.",
                      choices: [0.2, 0.4, 0.6, 1], value: number(["tone", "leadSec"]) ?? 0.4, defaultValue: 0.4,
                      store: .engine(path: "\(listenPath).tone.leadSec"))
                .requiring(toneOn, [.flag(true)], "Off while Tone is off."),
            toneSoundRow(setting, presets: presets, fileExists: fileExists)
                .requiring(toneOn, [.flag(true)], "Off while Tone is off."),
            toneVolumeRow(setting, presets: presets.presets)
                .requiring(toneOn, [.flag(true)], "Off while Tone is off."),
            SidePanelRow(store: .engine(path: "\(listenPath).tone.onMissing"), title: "If the tone file is missing",
                         detail: "Use a beep with a notice, or stop playback and show the error.",
                         choices: [.init(value: .text("beep"), title: "Use beep"), .init(value: .text("error"), title: "Stop with an error")],
                         value: .text(text(["tone", "onMissing"]) ?? "beep"), defaultValue: .text("beep"))
                .requiring(toneOn, [.flag(true)], "Off while Tone is off."),
            numberRow(key: "longestClipSec", title: "Longest clip",
                      detail: "A longer item or turn is shown, not played.",
                      choices: [15, 30, 60, 120], value: number(["longestClipSec"]) ?? 30, defaultValue: 30,
                      store: .engine(path: "\(listenPath).longestClipSec")),
        ], footnote: "Applies from the next clip. The clip that plays keeps its sound.")
    }

    /// The pads before and after the asked spot (config version 5, decision 9). Neither has a default: the first
    /// `listen` asks once and saves both, and one side set stands for both, so an unset side says "Same as …" while
    /// the other is set. Its empty choice puts the side back to that.
    static func padRows(before: Double?, after: Double?) -> [SidePanelRow] {
        func row(key: String, title: String, detail: String, value: Double?, other: Double?, sameAs: String) -> SidePanelRow {
            var offered = padChoices
            if let value, !offered.contains(value) { offered = (offered + [value]).sorted() }
            let choices = [SidePanelChoice(value: .text(""), title: other == nil ? "Not set" : sameAs)]
                + offered.map { SidePanelChoice(value: .number($0), title: SidePanelWords.number($0, key: key)) }
            return SidePanelRow(store: .engine(path: "\(listenPath).\(key)"), title: title, detail: detail, choices: choices,
                                value: value.map(SidePanelValue.number) ?? .text(""), defaultValue: nil)
        }
        return [
            row(key: "padBeforeSec", title: "Before the asked spot", detail: "Seconds a Moment plays before the words it is about.",
                value: before, other: after, sameAs: "Same as after"),
            row(key: "padAfterSec", title: "After it", detail: "Seconds it plays after them.",
                value: after, other: before, sameAs: "Same as before"),
        ]
    }

    /// The saved tone sound, or the engine's default when none is stored.
    static func toneSetting(_ value: JSONValue) -> MeetingsAPI.ToneSoundSetting {
        guard case .object = value, let setting = try? MeetingsService.decode(MeetingsAPI.ToneSoundSetting.self, value.foundation) else {
            return .engineDefault
        }
        return setting
    }

    /// The named sine a sound is (the same pitch and length), whatever its volume.
    static func namedSine(_ setting: MeetingsAPI.ToneSoundSetting, in presets: [MeetingsAPI.TonePresets.Preset]) -> MeetingsAPI.TonePresets.Preset? {
        guard case .sine(let hz, let sec, _) = setting else { return nil }
        return presets.first { $0.kind == "sine" && abs(($0.hz ?? -1) - hz) < 0.5 && abs(($0.sec ?? -1) - sec) < 0.001 }
    }

    /// The sound row's value for a saved sound: a preset's name, `.file`, or "custom". Before the named tones answer,
    /// the engine's default sine still reads as the beep, so the row does not change its words when they arrive.
    static func toneValue(_ setting: MeetingsAPI.ToneSoundSetting, presets: [MeetingsAPI.TonePresets.Preset]?) -> SidePanelValue {
        switch setting {
        case .preset(let name, _): return .text(name)
        case .file(let path, _): return .file(path)
        case .sine:
            if let presets { return namedSine(setting, in: presets).map { .text($0.name) } ?? customValue }
            return sameSound(setting, .engineDefault) ? .text(defaultTonePreset) : customValue
        }
    }

    /// The preset that the engine's default sine is (DEFAULT_TONE_SOUND is the beep).
    static let defaultTonePreset = "beep"

    private static func sameSound(_ a: MeetingsAPI.ToneSoundSetting, _ b: MeetingsAPI.ToneSoundSetting) -> Bool {
        guard case .sine(let hzA, let secA, _) = a, case .sine(let hzB, let secB, _) = b else { return false }
        return abs(hzA - hzB) < 0.5 && abs(secA - secB) < 0.001
    }

    /// The tone sound row: every named tone (greyed where this Mac lacks the file), the saved sine or sound file when it
    /// is neither, and "Sound file…". A sound file that is gone, or a Mac sound this Mac lacks, says so beside it.
    static func toneSoundRow(_ setting: MeetingsAPI.ToneSoundSetting, presets: TonePresetList,
                             fileExists: (String) -> Bool) -> SidePanelRow {
        let named = presets.presets ?? []
        let value = toneValue(setting, presets: presets.presets)
        var choices = named.map {
            SidePanelChoice(value: .text($0.name), title: $0.label, available: $0.available,
                            note: $0.available ? nil : "Not on this Mac.")
        }
        if !choices.contains(where: { $0.value == value }) {
            choices.append(SidePanelChoice(value: value, title: toneTitle(value, setting: setting), startsGroup: !choices.isEmpty,
                                           note: setting.filePath))
        }
        choices.append(SidePanelChoice(value: chooseFileValue, title: "Sound file…",
                                       startsGroup: !choices.contains { $0.startsGroup } && !choices.isEmpty,
                                       note: "A wav, aiff, mp3 or m4a file. The tone plays its first 2 seconds."))
        var detail = "The sound just before the asked spot. Each sound starts at its own volume."
        if case .unavailable(let reason) = presets { detail += " The named sounds did not load: \(reason)." }
        var row = SidePanelRow(store: .engine(path: toneSoundPath), title: "Tone sound", detail: detail, choices: choices,
                               value: value, defaultValue: .text(defaultTonePreset), tone: setting)
        row.valueHelp = setting.filePath
        if let path = setting.filePath, !fileExists(path) {
            row.problem = "\(URL(fileURLWithPath: path).lastPathComponent) is not there, so clips do not play. Pick another sound."
        } else if case .preset(let name, _) = setting, let preset = named.first(where: { $0.name == name }), !preset.available {
            row.problem = "\(preset.label) is not on this Mac, so clips do not play. Pick another sound."
        }
        return row
    }

    /// The title of a sound that no named tone lists (they have not answered, or it is none of them): a preset by its
    /// name, a file by its file name, a sine set by hand by its pitch.
    static func toneTitle(_ value: SidePanelValue, setting: MeetingsAPI.ToneSoundSetting) -> String {
        switch value {
        case .file(let path): return SidePanelWords.fileName(path)
        case .text(let name) where value != customValue: return name.prefix(1).uppercased() + name.dropFirst()
        default:
            if case .sine(let hz, _, _) = setting { return "Custom (\(Int(hz.rounded())) Hz)" }
            return "Custom"
        }
    }

    /// The tone's volume (0 to 1), written at `tone.sound.volume`: the saved one, else the named tone's own, else the
    /// engine's default. Its default is the sound's own volume, so a sound picked from the menu reads as default.
    static func toneVolumeRow(_ setting: MeetingsAPI.ToneSoundSetting, presets: [MeetingsAPI.TonePresets.Preset]?) -> SidePanelRow {
        let fallback = MeetingsAPI.ToneSoundSetting.defaultSine.volume
        let own: Double
        let saved: Double?
        switch setting {
        case .sine(_, _, let volume):
            own = presets.flatMap { namedSine(setting, in: $0)?.volume } ?? fallback
            saved = volume
        case .preset(let name, let volume):
            own = presets?.first { $0.name == name }?.volume ?? fallback
            saved = volume
        case .file(_, let volume):
            own = fallback
            saved = volume
        }
        var row = SidePanelRow(store: .engine(path: "\(toneSoundPath).volume"), title: "Tone volume",
                               detail: "How loud the tone plays, from silent to full.", choices: [],
                               value: .number(saved ?? own), defaultValue: .number(own))
        row.slider = SidePanelRow.Slider(range: 0...1, step: 0.05)
        return row
    }

    /// What a pick on an engine row writes.
    enum EnginePick: Equatable {
        case set(JSONValue)
        /// Put the default back (`config.unset`).
        case unset
        /// "Sound file…": ask for the file first.
        case chooseFile
        /// The value already shown, or "Custom" (nothing to write).
        case nothing
    }

    /// The write a pick means. A named tone is written whole as `{ preset }` (the engine refuses a preset key over a
    /// stored sine), a sound file as `{ file }`; both play at their own volume until the volume row moves.
    static func enginePick(_ value: SidePanelValue, for row: SidePanelRow) -> EnginePick {
        if row.id == toneSoundPath, value == chooseFileValue { return .chooseFile }
        guard value != row.value else { return .nothing }
        switch value {
        case .number(let number): return .set(.number(number))
        case .flag(let on): return .set(.bool(on))
        case .file(let path): return .set(.object(["file": .string(path)]))
        case .text(let raw):
            if raw.isEmpty { return .unset }
            guard row.id == toneSoundPath else { return .set(.string(raw)) }
            return value == customValue ? .nothing : .set(.object(["preset": .string(raw)]))
        }
    }

    /// Runs an engine row's pick: `write` gets the JSON to set, or nil to put the default back. "Sound file…" opens
    /// the file panel first and writes nothing when it is cancelled. The side panel and the Settings page both call it.
    @MainActor
    static func applyEngine(_ value: SidePanelValue, for row: SidePanelRow,
                            chooseFile: @escaping @MainActor (String?) async -> String? = { await ToneFileChooser.choose(near: $0) },
                            write: @escaping @MainActor (JSONValue?) -> Void) {
        switch enginePick(value, for: row) {
        case .set(let json): write(json)
        case .unset: write(nil)
        case .nothing: break
        case .chooseFile:
            Task { @MainActor in
                if let path = await chooseFile(row.tone?.filePath) { write(.object(["file": .string(path)])) }
            }
        }
    }
}

// MARK: - The view

/// The side panel's sections, for an inspector about 280 pt wide (G53).
struct SidePanelSections: View {
    let sections: [SidePanelSection]
    /// A row's new value. A window row writes its defaults key; an engine row goes through
    /// `SidePanelCatalog.applyEngine` (`config.set` or `config.unset` at its path, a file panel first for "Sound file…").
    let change: (SidePanelRow, SidePanelValue) -> Void
    /// "Reset to Defaults": remove `section.windowKeys`, `config.unset` each of `section.enginePaths`.
    let reset: (SidePanelSection) -> Void
    /// The tone row's Play button: `tone.preview` with the saved sound.
    var playTone: ((MeetingsAPI.ToneSoundSetting) -> Void)?
    /// A section's "Settings…" link: the Settings page at the card anchor.
    var openSettings: ((String) -> Void)?
    /// The sections that start folded, by id; the wiring remembers the reader's choice.
    var folded: Set<String> = []
    var setFolded: ((String, Bool) -> Void)?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                ForEach(sections) { section in
                    Section {
                        if !folded.contains(section.id) {
                            ForEach(section.rows) { row in
                                SidePanelRowView(row: row, change: { change(row, $0) }, playTone: playTone,
                                                 enabled: section.isEnabled(row), detail: section.detail(row))
                            }
                            if let footnote = section.footnote {
                                Label(footnote, systemImage: "clock.arrow.circlepath")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 14)
                                    .padding(.top, 2)
                                    .padding(.bottom, 8)
                                    .accessibilityIdentifier("meetings.sidePanel.\(section.id).footnote")
                            }
                        }
                    } header: {
                        header(section)
                    }
                }
            }
            .padding(.bottom, 12)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Meeting settings")
    }

    private func header(_ section: SidePanelSection) -> some View {
        let isFolded = folded.contains(section.id)
        return HStack(spacing: 6) {
            Button {
                setFolded?(section.id, !isFolded)
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(isFolded ? 0 : 90))
                        .foregroundStyle(.secondary)
                    Text(section.title).font(.system(size: 12, weight: .semibold))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .disabled(setFolded == nil)
            .accessibilityLabel(section.title)
            .accessibilityValue(isFolded ? "folded" : "open")
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 4)
            if let anchor = section.settingsAnchor, let openSettings {
                Button("Settings…") { openSettings(anchor) }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
                    .accessibilityIdentifier("meetings.sidePanel.\(section.id).settings")
            }
            Button("Reset to Defaults") { reset(section) }
                .buttonStyle(.genHoverPlain())
                .font(.system(size: 11))
                .disabled(section.isDefault)
                .instantTooltip("Put every \(section.title.lowercased()) setting back to its default")
                .accessibilityIdentifier("meetings.sidePanel.\(section.id).reset")
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 6)
        .background(.bar)
    }
}

/// One row: the title and the control on one line, the detail under them, and a problem with the saved value under that.
struct SidePanelRowView: View {
    let row: SidePanelRow
    let change: (SidePanelValue) -> Void
    var playTone: ((MeetingsAPI.ToneSoundSetting) -> Void)?
    /// False while the row it needs is off (`SidePanelSection.isEnabled`); `detail` then says why.
    var enabled = true
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(row.title)
                    .font(.system(size: 12))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(enabled ? .primary : .secondary)
                Spacer(minLength: 6)
                control
                    .disabled(!enabled)
                if let playTone, let sound = row.tone {
                    // lint-rules-ignore: short list (the panel's settings rows, about thirty; only the tone row has it)
                    IconButton(systemName: "play.circle", tooltip: row.problem == nil ? "Play the tone" : "The tone cannot play: \(row.problem ?? "")",
                               size: 13) { playTone(sound) }
                        .disabled(!enabled || row.problem != nil)
                        .accessibilityIdentifier("meetings.sidePanel.playTone")
                }
            }
            Text(detail ?? row.detail)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let problem = row.problem {
                SidePanelProblem(text: problem)
                    .accessibilityIdentifier("meetings.sidePanel.problem.\(row.id)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meetings.sidePanel.row.\(row.id)")
    }

    @ViewBuilder
    private var control: some View {
        if let slider = row.slider, case .number(let saved) = row.value {
            SidePanelSlider(title: row.title, saved: saved, slider: slider) { change(.number($0)) }
        } else if case .flag(let on) = row.value {
            Toggle(row.title, isOn: Binding(get: { on }, set: { change(.flag($0)) }))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
        } else {
            Picker(row.title, selection: Binding(get: { row.value }, set: { change($0) })) {
                ForEach(row.choices, id: \.self) { choice in
                    if choice.startsGroup { Divider() }
                    Text(choice.title).tag(choice.value)
                        .disabled(!choice.available)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            .help(row.valueHelp ?? "")
        }
    }
}

/// A sentence under a row whose saved value cannot work, with a warning symbol so it does not read as a plain detail.
struct SidePanelProblem: View {
    let text: String

    var body: some View {
        Label {
            Text(text).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.system(size: 11))
        .foregroundStyle(.orange)
        .accessibilityElement(children: .combine)
    }
}

/// The volume slider: it follows the knob while it moves and writes once, when the drag ends, so a drag is one
/// `config.set`; a step by the arrow keys or VoiceOver writes 0.4 s after the last step. The draft stays until the
/// saved value arrives (no jump back on release), or 5 s after a write that did not land, when the slider shows the
/// saved value again.
struct SidePanelSlider: View {
    let title: String
    let saved: Double
    let slider: SidePanelRow.Slider
    let commit: (Double) -> Void
    @State private var draft: Double?
    @State private var editing = false
    @State private var written = 0

    var body: some View {
        HStack(spacing: 6) {
            // No `step:` here: it draws a tick per step (21 for a volume). The value snaps to the step instead.
            Slider(value: Binding(get: { draft ?? saved }, set: { draft = ($0 / slider.step).rounded() * slider.step }),
                   in: slider.range) {
                Text(title)
            } onEditingChanged: { isEditing in
                editing = isEditing
                guard !isEditing, let draft else { return }
                commit(draft)
                written += 1
            }
            .labelsHidden()
            .controlSize(.mini)
            .frame(width: 96)
            .accessibilityValue(SidePanelWords.percent(draft ?? saved))
            Text(verbatim: SidePanelWords.percent(draft ?? saved))
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 36, alignment: .trailing)
                .accessibilityHidden(true)
        }
        .onChange(of: saved) { draft = nil }
        .task(id: draft) {
            guard let draft, !editing, draft != saved else { return }
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, !editing else { return }
            commit(draft)
            written += 1
        }
        .task(id: written) {
            guard written > 0 else { return }
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { draft = nil }
        }
    }
}
