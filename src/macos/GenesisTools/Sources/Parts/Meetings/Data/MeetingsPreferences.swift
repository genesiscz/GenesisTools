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
    /// Where a transcript time plays: in this window (ffplay with no window of its own, which the window's player bar
    /// pauses and stops), or in the player the meetings config names (VLC first, with its own window and controls).
    enum Player: String, CaseIterable {
        case window, app
        /// The `--player` the window passes to `tools meetings play`; nil leaves the config's choice.
        var cliPlayer: String? { self == .window ? "ffplay" : nil }
    }

    static let openOnKey = "meetings.window.openOn"
    static let daysKey = "meetings.window.days"
    static let timelineKey = "meetings.timeline.lines"
    static let afterExportKey = "meetings.export.after"
    static let typedAnswerKey = "meetings.questions.typedAnswer"
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

    static func player(_ defaults: UserDefaults = .standard) -> Player {
        defaults.string(forKey: playerKey).flatMap(Player.init(rawValue:)) ?? .window
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

    /// Removes the keys this version replaced. Run once when the window's model starts; no reader uses them.
    static func migrate(_ defaults: UserDefaults = .standard) {
        if defaults.object(forKey: legacyUndoSecondsKey) != nil { defaults.removeObject(forKey: legacyUndoSecondsKey) }
    }
}
