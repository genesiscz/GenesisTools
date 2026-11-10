import Foundation
import SwiftUI

/// The Meetings window's own choices, in the app's defaults (Settings → Meetings → Window). The meetings data and its
/// rules live in the meetings config, written through `tools meetings config set`; these only decide how the window
/// shows them.
enum MeetingsPreferences {
    enum OpenOn: String, CaseIterable { case needs, all }
    enum TimelineLines: String, CaseIterable { case changed, all }
    enum AfterExport: String, CaseIterable { case genesis, finder, nothing }
    /// When a question offers a field for an answer the choices do not hold: on every question, or only on one with
    /// no choices.
    enum TypedAnswer: String, CaseIterable {
        case always, noChoices
        func shows(choices: [String]) -> Bool { self == .always || choices.isEmpty }
    }
    static let openOnKey = "meetings.window.openOn"
    static let daysKey = "meetings.window.days"
    static let timelineKey = "meetings.timeline.lines"
    static let afterExportKey = "meetings.export.after"
    /// When a review row offers a field for an answer its choices do not hold (`Rows`); renamed from
    /// `legacyTypedAnswerKey`, which `migrate` carries over.
    static let typedAnswerKey = "meetings.rows.typedAnswer"
    static let legacyTypedAnswerKey = "meetings.questions.typedAnswer"
    /// Retired in Wave B: every Moment plays in the window's player (`MomentPlayer`). Readers ignore it.
    static let playerKey = "meetings.playback.player"
    /// How long a notice with a button (Undo, Show, Replace) stays, in seconds: every notice with an action, one key.
    static let noticeSecondsKey = "meetings.notices.seconds"
    /// How long a notice without a button stays, in seconds.
    static let plainNoticeSecondsKey = "meetings.notices.plainSeconds"
    /// Which edge of a pane the notices float at.
    static let noticePlaceKey = "meetings.notices.place"
    /// The Undo time of a confirm or a reject only (choices 4, 8 and 15 s, default 8), replaced on 2026-11-09 by
    /// `noticeSecondsKey`. Not carried over: the new key covers every notice with a button and its default is the 30 s
    /// R15 asked for, longer than any old choice. `migrate` removes it.
    static let legacyUndoSecondsKey = "meetings.items.undoSeconds"

    static let dayChoices = [7, 14, 30, 90]
    static let noticeChoices = [8, 15, 30, 60]
    static let plainNoticeChoices = [4, 6, 10, 15]

    /// Where the notices float: at the bottom of the pane, over its last rows, or at its top, under the header.
    enum NoticePlace: String, CaseIterable {
        case bottom, top
        var alignment: Alignment { self == .top ? .top : .bottom }
    }

    static func openOn(_ defaults: UserDefaults = .standard) -> OpenOn {
        defaults.string(forKey: openOnKey).flatMap(OpenOn.init(rawValue:)) ?? .needs
    }

    static func days(_ defaults: UserDefaults = .standard) -> Int {
        let value = defaults.integer(forKey: daysKey)
        return value > 0 ? value : 14
    }

    static func timelineLines(_ defaults: UserDefaults = .standard) -> TimelineLines {
        defaults.string(forKey: timelineKey).flatMap(TimelineLines.init(rawValue:)) ?? .changed
    }

    static func afterExport(_ defaults: UserDefaults = .standard) -> AfterExport {
        defaults.string(forKey: afterExportKey).flatMap(AfterExport.init(rawValue:)) ?? .genesis
    }

    static func typedAnswer(_ defaults: UserDefaults = .standard) -> TypedAnswer {
        defaults.string(forKey: typedAnswerKey).flatMap(TypedAnswer.init(rawValue:)) ?? .always
    }

    static func noticeSeconds(_ defaults: UserDefaults = .standard) -> Int {
        let value = defaults.integer(forKey: noticeSecondsKey)
        return value > 0 ? value : 30
    }

    static func plainNoticeSeconds(_ defaults: UserDefaults = .standard) -> Int {
        let value = defaults.integer(forKey: plainNoticeSecondsKey)
        return value > 0 ? value : Int(NoticeStackTiming.standard.plainSeconds)
    }

    static func noticePlace(_ defaults: UserDefaults = .standard) -> NoticePlace {
        defaults.string(forKey: noticePlaceKey).flatMap(NoticePlace.init(rawValue:)) ?? .bottom
    }

    /// The times a notice stack of this window reads at each notice. An error stays until it is closed.
    static func noticeTiming(_ defaults: UserDefaults = .standard) -> NoticeStackTiming {
        NoticeStackTiming(actionSeconds: Double(noticeSeconds(defaults)), plainSeconds: Double(plainNoticeSeconds(defaults)))
    }

    /// Removes the keys this version replaced, and carries a renamed key's value over. Run once when the window's model
    /// starts; no reader uses the old keys.
    static func migrate(_ defaults: UserDefaults = .standard) {
        if defaults.object(forKey: legacyUndoSecondsKey) != nil { defaults.removeObject(forKey: legacyUndoSecondsKey) }
        if defaults.object(forKey: playerKey) != nil { defaults.removeObject(forKey: playerKey) }
        if let old = defaults.string(forKey: legacyTypedAnswerKey) {
            if defaults.object(forKey: typedAnswerKey) == nil { defaults.set(old, forKey: typedAnswerKey) }
            defaults.removeObject(forKey: legacyTypedAnswerKey)
        }
    }
}

// MARK: - Wave B window settings (WaveB-Plan.md, "Window settings")

/// One window setting as data: its defaults key, its default, the values a control offers, and the words a control
/// shows. Every opinionated choice of the review rows, the player and the panes is one of these
/// (`.claude/rules/opinionated-settings.md`); the side panel and the Settings page build their controls from them
/// (b-swift-settings-contacts), and views read them through the typed accessors, never a literal.
struct MeetingsWindowSetting<Value: Equatable>: Equatable {
    let key: String
    let defaultValue: Value
    /// The values a control offers, in order; empty for a free number.
    let choices: [Value]
    let title: String
    /// One line under the control that says what it does.
    let detail: String
}

extension MeetingsWindowSetting where Value: RawRepresentable, Value.RawValue == String {
    func value(_ defaults: UserDefaults = .standard) -> Value {
        defaults.string(forKey: key).flatMap(Value.init(rawValue:)) ?? defaultValue
    }
}

extension MeetingsWindowSetting where Value == Double {
    func value(_ defaults: UserDefaults = .standard) -> Double {
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        let stored = defaults.double(forKey: key)
        return stored > 0 ? stored : defaultValue
    }
}

extension MeetingsWindowSetting where Value == Int {
    func value(_ defaults: UserDefaults = .standard) -> Int {
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        let stored = defaults.integer(forKey: key)
        return stored > 0 ? stored : defaultValue
    }
}

extension MeetingsWindowSetting where Value == Bool {
    func value(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) == nil ? defaultValue : defaults.bool(forKey: key)
    }
}

extension MeetingsPreferences {
    /// The review rows (F6).
    enum Rows {
        enum ReturnKey: String, CaseIterable { case edit, confirm }
        enum ChoiceKeys: String, CaseIterable { case on, off }
        enum Decided: String, CaseIterable { case inPlace, hidden }
        enum Order: String, CaseIterable { case priority, time }
        enum LowPriority: String, CaseIterable { case hide, show }
        enum AskReach: String, CaseIterable { case always, never }
        enum AutoplayNext: String, CaseIterable { case off, afterAnswer }

        static let typedAnswer = MeetingsWindowSetting(
            key: MeetingsPreferences.typedAnswerKey, defaultValue: TypedAnswer.always, choices: TypedAnswer.allCases,
            title: "Typed answer", detail: "When a row offers a field for an answer its choices do not hold.")
        static let returnKey = MeetingsWindowSetting(
            key: "meetings.rows.returnKey", defaultValue: ReturnKey.edit, choices: ReturnKey.allCases,
            title: "Return on a row", detail: "Edit opens the row's editor and a second Return confirms; Confirm decides at once.")
        static let choiceKeys = MeetingsWindowSetting(
            key: "meetings.rows.choiceKeys", defaultValue: ChoiceKeys.on, choices: ChoiceKeys.allCases,
            title: "Number keys pick a choice", detail: "1 to 9 answer the selected row with that choice.")
        static let decided = MeetingsWindowSetting(
            key: "meetings.rows.decided", defaultValue: Decided.inPlace, choices: Decided.allCases,
            title: "Decided rows", detail: "In place: a decided row folds where it is. Hidden: it leaves the list.")
        static let order = MeetingsWindowSetting(
            key: "meetings.rows.order", defaultValue: Order.priority, choices: Order.allCases,
            title: "Row order", detail: "Priority: the order the terminal asks. Time: the transcript's order.")
        static let lowPriority = MeetingsWindowSetting(
            key: "meetings.rows.lowPriority", defaultValue: LowPriority.hide, choices: LowPriority.allCases,
            title: "Low-priority questions", detail: "Hide counts the questions under the priority line; Show lists them.")
        static let askReach = MeetingsWindowSetting(
            key: "meetings.rows.askReach", defaultValue: AskReach.always, choices: AskReach.allCases,
            title: "Ask before a wide change", detail: "Shows what an answer also changes before it is saved.")
        static let autoplayNext = MeetingsWindowSetting(
            key: "meetings.rows.autoplayNext", defaultValue: AutoplayNext.afterAnswer, choices: AutoplayNext.allCases,
            title: "Play the next row", detail: "After an answer, the next open row plays by itself.")
        static let autoplayDelaySec = MeetingsWindowSetting(
            key: "meetings.rows.autoplayDelaySec", defaultValue: 1.0, choices: [0.5, 1, 2, 3],
            title: "Delay before the next row plays", detail: "Seconds between an answer and the next row's sound.")
    }

    /// The notice stack (F4 keys stay in `MeetingsPreferences`; this adds the visible count).
    enum Notices {
        static let maxVisible = MeetingsWindowSetting(
            key: "meetings.notices.maxVisible", defaultValue: 3, choices: [2, 3, 5, 8],
            title: "Notices shown at once", detail: "Older notices fold into “+N more”.")
    }

    /// The Moment player (F1b).
    enum Playback {
        enum View: String, CaseIterable { case moment, meeting }
        enum Repeat: String, CaseIterable { case off, once }
        enum AfterClip: String, CaseIterable { case stop, offerMore, `continue` }
        enum ClickInQuestion: String, CaseIterable { case push, replace }
        enum OnTopEnd: String, CaseIterable { case `return`, stop }

        static let view = MeetingsWindowSetting(
            key: "meetings.playback.view", defaultValue: View.moment, choices: View.allCases,
            title: "Player view", detail: "Moment plays a row's clip; Meeting plays the whole recording.")
        static let speed = MeetingsWindowSetting(
            key: "meetings.playback.speed", defaultValue: 1.0, choices: [0.75, 1, 1.25, 1.5, 2],
            title: "Speed", detail: "How fast a Moment plays.")
        static let repeatClip = MeetingsWindowSetting(
            key: "meetings.playback.repeat", defaultValue: Repeat.off, choices: Repeat.allCases,
            title: "Repeat", detail: "Once plays a Moment a second time after a short gap.")
        static let afterClip = MeetingsWindowSetting(
            key: "meetings.playback.afterClip", defaultValue: AfterClip.offerMore, choices: AfterClip.allCases,
            title: "At the end of a clip", detail: "Stop, offer “Play 30 s more”, or play on.")
        static let moreSec = MeetingsWindowSetting(
            key: "meetings.playback.moreSec", defaultValue: 30.0, choices: [10, 30, 60],
            title: "“Play more” length", detail: "Seconds that “Play more” adds after a clip.")
        static let contextSec = MeetingsWindowSetting(
            key: "meetings.playback.contextSec", defaultValue: 120.0, choices: [60, 120, 300],
            title: "Context around a Moment", detail: "Seconds the zoomed timeline shows around the Moment.")
        static let rewindSec = MeetingsWindowSetting(
            key: "meetings.playback.rewindSec", defaultValue: 1.0, choices: [0.5, 1, 2, 5],
            title: "Rewind on play again", detail: "Seconds a paused Moment goes back when it plays again, without the tone.")
        static let clickInQuestion = MeetingsWindowSetting(
            key: "meetings.playback.stack.clickInQuestion", defaultValue: ClickInQuestion.push, choices: ClickInQuestion.allCases,
            title: "A time in a question", detail: "Push plays it over the Moment and comes back; Replace plays it instead.")
        static let onTopEnd = MeetingsWindowSetting(
            key: "meetings.playback.stack.onTopEnd", defaultValue: OnTopEnd.return, choices: OnTopEnd.allCases,
            title: "When a pushed Moment ends", detail: "Return goes back to the Moment below; Stop stays.")
        static let stackDepth = MeetingsWindowSetting(
            key: "meetings.playback.stack.depth", defaultValue: 3, choices: [2, 3, 5],
            title: "Moments kept below", detail: "How many Moments the player keeps to come back to.")
    }

    /// A speaker's rename field and its person picker (F10).
    enum People {
        static let renameBlur = MeetingsWindowSetting(
            key: "meetings.people.renameBlur", defaultValue: PersonNameBlur.keepDraft, choices: PersonNameBlur.allCases,
            title: "A typed name left unsaved", detail: "Keep it: the field holds the name with Save. Save it: leaving the field saves it.")
        static let offerNew = MeetingsWindowSetting(
            key: "meetings.people.offerNew", defaultValue: PersonPickerAddRule.noExactMatch, choices: PersonPickerAddRule.allCases,
            title: "Offer a new speaker", detail: "When no one has the typed name, or only when no one matches it at all.")
    }

    /// The timeline and the panes (F9 reads them; the side panel shows them).
    enum Panes {
        enum TranscriptPane: String, CaseIterable { case auto, always, never }

        static let timelineShown = MeetingsWindowSetting(
            key: "meetings.timeline.shown", defaultValue: true, choices: [true, false],
            title: "Timeline", detail: "The dock's timeline above the player controls.")
        static let hoverDelayMs = MeetingsWindowSetting(
            key: "meetings.timeline.hoverDelayMs", defaultValue: 300, choices: [0, 150, 300, 600],
            title: "Hover delay", detail: "Milliseconds before a pin's card opens under the pointer.")
        static let followPlayback = MeetingsWindowSetting(
            key: "meetings.transcript.followPlayback", defaultValue: true, choices: [true, false],
            title: "Transcript follows playback", detail: "The heard line stays in view while a Moment plays.")
        static let screenBesidePlayback = MeetingsWindowSetting(
            key: "meetings.screen.besidePlayback", defaultValue: true, choices: [true, false],
            title: "Screen beside the sound", detail: "The frame of the Moment that plays shows in the dock.")
        static let transcriptPane = MeetingsWindowSetting(
            key: "meetings.items.transcriptPane", defaultValue: TranscriptPane.auto, choices: TranscriptPane.allCases,
            title: "Transcript beside the rows", detail: "Auto shows it when the window is wide enough.")
    }
}
