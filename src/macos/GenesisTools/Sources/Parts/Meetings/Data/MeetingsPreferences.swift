import Foundation

/// The Meetings window's own choices, in the app's defaults (Settings → Meetings → Window). The meetings data and its
/// rules live in the meetings config, written through `tools meetings config set`; these only decide how the window
/// shows them.
enum MeetingsPreferences {
    enum OpenOn: String, CaseIterable { case needs, all }
    enum TimelineLines: String, CaseIterable { case changed, all }
    enum AfterExport: String, CaseIterable { case genesis, finder, nothing }

    static let openOnKey = "meetings.window.openOn"
    static let daysKey = "meetings.window.days"
    static let timelineKey = "meetings.timeline.lines"
    static let afterExportKey = "meetings.export.after"
    static let undoSecondsKey = "meetings.items.undoSeconds"

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

    static func undoSeconds(_ defaults: UserDefaults = .standard) -> Int {
        let value = defaults.integer(forKey: undoSecondsKey)
        return value > 0 ? value : 8
    }
}
