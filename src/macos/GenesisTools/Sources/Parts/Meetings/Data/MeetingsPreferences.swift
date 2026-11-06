import Foundation

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
    static let undoSecondsKey = "meetings.items.undoSeconds"
    static let typedAnswerKey = "meetings.questions.typedAnswer"
    static let playerKey = "meetings.playback.player"

    static let dayChoices = [7, 14, 30, 90]
    static let undoChoices = [4, 8, 15]

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

    static func undoSeconds(_ defaults: UserDefaults = .standard) -> Int {
        let value = defaults.integer(forKey: undoSecondsKey)
        return value > 0 ? value : 8
    }
}
