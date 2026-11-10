import GenesisKit
import SwiftUI

// MARK: - The settings side panel's content (F8; R26, R8, G52 to G55)
//
// One section per group of the window settings (`MeetingsPreferences.Rows`, `Notices`, `Playback`, `Panes`) and one
// for the engine's clip and tone (`global.playback.listen`: padSec, tone, longestClipSec), with "Applies from the next
// clip" under the engine rows (G54) and "Reset to Defaults" per section (G55). The words and the choices come from the
// same `MeetingsWindowSetting` values the Settings page reads. Presentational: the rows come in as values, a change goes
// out through `change`, a reset through `reset`, the tone preview through `playTone`.

/// A value a panel row holds: a choice's raw text, a number, or a switch.
enum SidePanelValue: Hashable {
    case text(String)
    case number(Double)
    case flag(Bool)
}

/// One choice a row's menu offers.
struct SidePanelChoice: Hashable {
    let value: SidePanelValue
    let title: String
}

/// The tone's named sounds (G52, decision 8): each writes `tone.sound { hz, sec, volume }`; no sound files.
enum TonePreset: String, CaseIterable {
    case beep, soft, click

    var title: String {
        switch self {
        case .beep: return "Beep"
        case .soft: return "Soft"
        case .click: return "Click"
        }
    }

    var sound: ToneSound {
        switch self {
        case .beep: return ToneSound(hz: 880, sec: 0.15, volume: 0.6)
        case .soft: return ToneSound(hz: 523, sec: 0.3, volume: 0.35)
        case .click: return ToneSound(hz: 2000, sec: 0.03, volume: 0.7)
        }
    }

    /// The preset a saved sound is, nil for a sound set by hand ("Custom").
    static func matching(_ sound: ToneSound) -> TonePreset? {
        allCases.first { abs($0.sound.hz - sound.hz) < 0.5 && abs($0.sound.sec - sound.sec) < 0.001 && abs($0.sound.volume - sound.volume) < 0.001 }
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
    /// nil: the engine has no default (padSec, which the first `listen` asks for).
    let defaultValue: SidePanelValue?
    /// The tone row: its Play button plays this sound.
    var tone: ToneSound?

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
    /// The app defaults keys a reset removes.
    var windowKeys: [String] { rows.compactMap { if case .window(let key) = $0.store { return key } else { return nil } } }
    /// The config paths a reset unsets.
    var enginePaths: [String] { rows.compactMap { if case .engine(let path) = $0.store { return path } else { return nil } } }
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
        "moment": "Its Moment", "meeting": "The meeting from there",
        "once": "Once",
        "stop": "Stop", "offerMore": "Offer more", "continue": "Play on",
        "push": "Push", "replace": "Replace", "return": "Return",
        "noChoices": "Without choices",
        "bottom": "Bottom", "top": "Top",
        "keepDraft": "Keep it", "commit": "Save it",
        "noExactMatch": "No one has the name", "noResults": "No one matches",
    ]

    /// Choices whose words depend on the key ("always" of the typed answer is "On every question").
    static let keyedTitles: [String: [String: String]] = [
        MeetingsPreferences.typedAnswerKey: ["always": "On every question", "noChoices": "Without choices"],
    ]

    static func choice(_ raw: String, key: String) -> String {
        keyedTitles[key]?[raw] ?? choiceTitles[raw] ?? raw
    }

    /// A number with the unit its key names: "1.25×", "30 s", "300 ms", or a count.
    static func number(_ value: Double, key: String) -> String {
        let text = value == value.rounded() ? String(Int(value)) : String(format: "%g", value)
        if key.hasSuffix("speed") { return "\(text)×" }
        if key.hasSuffix("Ms") { return "\(text) ms" }
        if key.hasSuffix("Sec") || key.hasSuffix("Seconds") || key.hasSuffix("seconds") || key.hasSuffix("plainSeconds") { return "\(text) s" }
        return text
    }

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
        let playback = SidePanelSection(id: "playback", title: "Playback", rows: [
            row(Playback.view, value: Playback.view.value(defaults)),
            row(Playback.speed, value: Playback.speed.value(defaults)),
            row(Playback.repeatClip, value: Playback.repeatClip.value(defaults)),
            row(Playback.afterClip, value: Playback.afterClip.value(defaults)),
            row(Playback.moreSec, value: Playback.moreSec.value(defaults)),
            row(Playback.contextSec, value: Playback.contextSec.value(defaults)),
            row(Playback.rewindSec, value: Playback.rewindSec.value(defaults)),
            row(Playback.clickInQuestion, value: Playback.clickInQuestion.value(defaults)),
            row(Playback.onTopEnd, value: Playback.onTopEnd.value(defaults)),
            row(Playback.stackDepth, value: Playback.stackDepth.value(defaults)),
        ])
        let rows = SidePanelSection(id: "rows", title: "Rows", rows: [
            row(Rows.typedAnswer, value: Rows.typedAnswer.value(defaults)),
            row(Rows.returnKey, value: Rows.returnKey.value(defaults)),
            row(Rows.choiceKeys, value: Rows.choiceKeys.value(defaults)),
            row(Rows.decided, value: Rows.decided.value(defaults)),
            row(Rows.order, value: Rows.order.value(defaults)),
            row(Rows.lowPriority, value: Rows.lowPriority.value(defaults)),
            row(Rows.askReach, value: Rows.askReach.value(defaults)),
            row(Rows.autoplayNext, value: Rows.autoplayNext.value(defaults)),
            row(Rows.autoplayDelaySec, value: Rows.autoplayDelaySec.value(defaults)),
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
        ], settingsAnchor: MeetingsSettingsPages.noticesAnchor)
        let panes = SidePanelSection(id: "panes", title: "Timeline and Panes", rows: [
            row(Panes.timelineShown, value: Panes.timelineShown.value(defaults)),
            row(Panes.hoverDelayMs, value: Panes.hoverDelayMs.value(defaults)),
            row(Panes.followPlayback, value: Panes.followPlayback.value(defaults)),
            row(Panes.screenBesidePlayback, value: Panes.screenBesidePlayback.value(defaults)),
            row(Panes.transcriptPane, value: Panes.transcriptPane.value(defaults)),
        ])
        typealias People = MeetingsPreferences.People
        let people = SidePanelSection(id: "people", title: "Speaker Names", rows: [
            row(People.renameBlur, value: People.renameBlur.value(defaults)),
            row(People.offerNew, value: People.offerNew.value(defaults)),
        ])
        return [playback, rows, notices, panes, people]
    }

    /// The keys whose readers read a whole number (`integer(forKey:)`, `MeetingsWindowSetting<Int>`).
    static let integerKeys: Set<String> = [
        MeetingsPreferences.noticeSecondsKey, MeetingsPreferences.plainNoticeSecondsKey,
        MeetingsPreferences.Notices.maxVisible.key, MeetingsPreferences.Playback.stackDepth.key,
        MeetingsPreferences.Panes.hoverDelayMs.key,
    ]

    /// Writes a window row's value into `defaults` as the type its reader reads (the side panel and the Settings page).
    static func write(_ value: SidePanelValue, key: String, to defaults: UserDefaults) {
        switch value {
        case .text(let raw): defaults.set(raw, forKey: key)
        case .number(let number):
            if integerKeys.contains(key) { defaults.set(Int(number.rounded()), forKey: key) } else { defaults.set(number, forKey: key) }
        case .flag(let on): defaults.set(on, forKey: key)
        }
    }

    /// An engine row's config path as segments (`global.playback.listen.padSec`).
    static func segments(_ path: String) -> [String] { path.split(separator: ".").map(String.init) }

    // MARK: Engine rows

    /// The engine's clip and tone, from `config.read global.playback.listen` (null or missing keys read as defaults).
    static func engineSection(listen: JSONValue) -> SidePanelSection {
        func number(_ path: [String]) -> Double? { if case .number(let value) = listen.at(path) { return value } else { return nil } }
        func flag(_ path: [String]) -> Bool? { if case .bool(let value) = listen.at(path) { return value } else { return nil } }
        let pad = number(["padSec"])
        let sound = ToneSound(hz: number(["tone", "sound", "hz"]) ?? TonePreset.beep.sound.hz,
                              sec: number(["tone", "sound", "sec"]) ?? TonePreset.beep.sound.sec,
                              volume: number(["tone", "sound", "volume"]) ?? TonePreset.beep.sound.volume)
        let preset = TonePreset.matching(sound)
        var padChoices = [1.0, 2, 3, 5, 10].map { SidePanelChoice(value: .number($0), title: SidePanelWords.number($0, key: "padSec")) }
        if let pad, !padChoices.contains(where: { $0.value == .number(pad) }) {
            padChoices.append(SidePanelChoice(value: .number(pad), title: SidePanelWords.number(pad, key: "padSec")))
        }
        if pad == nil { padChoices.insert(SidePanelChoice(value: .text(""), title: "Not set"), at: 0) }
        var soundChoices = TonePreset.allCases.map { SidePanelChoice(value: .text($0.rawValue), title: $0.title) }
        if preset == nil { soundChoices.append(SidePanelChoice(value: .text("custom"), title: "Custom")) }
        return SidePanelSection(id: "engine", title: "Clip and Tone", rows: [
            SidePanelRow(store: .engine(path: "\(listenPath).padSec"), title: "Sound around the asked spot",
                         detail: "Seconds a Moment plays before and after the words it is about.",
                         choices: padChoices, value: pad.map(SidePanelValue.number) ?? .text(""), defaultValue: nil),
            SidePanelRow(store: .engine(path: "\(listenPath).tone.enabled"), title: "Tone",
                         detail: "A short tone just before the asked spot, in the window and the terminal.",
                         choices: [], value: .flag(flag(["tone", "enabled"]) ?? true), defaultValue: .flag(true)),
            numberRow(key: "leadSec", title: "Tone before the spot", detail: "How long before the asked spot the tone sounds.",
                      choices: [0.2, 0.4, 0.6, 1], value: number(["tone", "leadSec"]) ?? 0.4, defaultValue: 0.4,
                      store: .engine(path: "\(listenPath).tone.leadSec")),
            SidePanelRow(store: .engine(path: "\(listenPath).tone.sound"), title: "Tone sound",
                         detail: "Beep is a clear 880 Hz, Soft is lower and quieter, Click is very short.",
                         choices: soundChoices, value: .text(preset?.rawValue ?? "custom"),
                         defaultValue: .text(TonePreset.beep.rawValue), tone: sound),
            numberRow(key: "longestClipSec", title: "Longest clip",
                      detail: "A longer item or turn is shown, not played.",
                      choices: [15, 30, 60, 120], value: number(["longestClipSec"]) ?? 30, defaultValue: 30,
                      store: .engine(path: "\(listenPath).longestClipSec")),
        ], footnote: "Applies from the next clip. The clip that plays keeps its sound.")
    }

    /// The JSON `config.set` writes for an engine row's new value: a preset becomes its `{ hz, sec, volume }`.
    static func configValue(_ value: SidePanelValue, for row: SidePanelRow) -> JSONValue? {
        switch value {
        case .number(let number): return .number(number)
        case .flag(let on): return .bool(on)
        case .text(let raw):
            guard row.id.hasSuffix(".tone.sound") else { return raw.isEmpty ? nil : .string(raw) }
            guard let preset = TonePreset(rawValue: raw) else { return nil }
            return .object(["hz": .number(preset.sound.hz), "sec": .number(preset.sound.sec), "volume": .number(preset.sound.volume)])
        }
    }

    /// The sound a tone row's Play button plays for a value: the preset's, else the saved sound.
    static func sound(_ value: SidePanelValue, for row: SidePanelRow) -> ToneSound? {
        if case .text(let raw) = value, let preset = TonePreset(rawValue: raw) { return preset.sound }
        return row.tone
    }
}

// MARK: - The view

/// The side panel's sections, for an inspector about 280 pt wide (G53).
struct SidePanelSections: View {
    let sections: [SidePanelSection]
    /// A row's new value. A window row writes its defaults key; an engine row writes
    /// `SidePanelCatalog.configValue(value, for: row)` with `config.set` at its path.
    let change: (SidePanelRow, SidePanelValue) -> Void
    /// "Reset to Defaults": remove `section.windowKeys`, `config.unset` each of `section.enginePaths`.
    let reset: (SidePanelSection) -> Void
    /// The tone row's Play button: `tone.preview` with the sound.
    var playTone: ((ToneSound) -> Void)?
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
                                SidePanelRowView(row: row, change: { change(row, $0) }, playTone: playTone)
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

/// One row: the title and the control on one line, the detail under them.
struct SidePanelRowView: View {
    let row: SidePanelRow
    let change: (SidePanelValue) -> Void
    var playTone: ((ToneSound) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(row.title)
                    .font(.system(size: 12))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                control
                if let playTone, let sound = SidePanelCatalog.sound(row.value, for: row) {
                    IconButton(systemName: "play.circle", tooltip: "Play the tone", size: 13) { playTone(sound) }
                        .accessibilityIdentifier("meetings.sidePanel.playTone")
                }
            }
            Text(row.detail)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("meetings.sidePanel.row.\(row.id)")
    }

    @ViewBuilder
    private var control: some View {
        if case .flag(let on) = row.value {
            Toggle(row.title, isOn: Binding(get: { on }, set: { change(.flag($0)) }))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .labelsHidden()
        } else {
            Picker(row.title, selection: Binding(get: { row.value }, set: { change($0) })) {
                ForEach(row.choices, id: \.self) { choice in
                    Text(choice.title).tag(choice.value)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
        }
    }
}
