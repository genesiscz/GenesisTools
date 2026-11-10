import Foundation

/// The values the Projects page's rule fields offer (`projects.suggestions`): the Wispr Flow folders, the Calendar
/// app's calendars, the title words and labels already in use. Read once through the Meetings service, on the first
/// field that needs them; there is no command for it, so without a service the fields take typed values only.
extension MeetingsSettingsModel {
    static let suggestionsUnavailable =
        "The Meetings service does not answer yet, so there are no values to offer. Type one and press Return."

    func suggestions() async throws -> MeetingsAPI.ProjectsSuggestions.Result {
        if let task = suggestionsTask { return try await task.value }
        guard let service else { throw AutocompleteFailure(Self.suggestionsUnavailable) }
        let task = Task { try await service.call(MeetingsAPI.ProjectsSuggestions.self, .init()) }
        suggestionsTask = task
        do {
            return try await task.value
        } catch is MeetingsService.Unavailable {
            suggestionsTask = nil
            throw AutocompleteFailure(Self.suggestionsUnavailable)
        } catch {
            // A failed read is asked again by the list's Retry.
            suggestionsTask = nil
            throw AutocompleteFailure(asFailure(error).sentence)
        }
    }

    /// The folders a Wispr Flow rule can name; a folder known only from a meeting says so.
    func wisprFolderValues() async throws -> [AutocompleteValue] {
        guard let folders = try await suggestions().folders["wisprflow"] else { return [] }
        let detail = folders.from == "meetings" ? "a folder a meeting sits in" : nil
        return folders.values.map { AutocompleteValue($0, detail: detail, symbol: "folder") }
    }

    func calendarValues() async throws -> [AutocompleteValue] {
        try await suggestions().calendars.values.map { AutocompleteValue($0, symbol: "calendar") }
    }

    func titleWordValues() async throws -> [AutocompleteValue] {
        try await suggestions().titleWords.map { AutocompleteValue($0) }
    }

    func labelValues() async throws -> [AutocompleteValue] {
        try await suggestions().labels.map { AutocompleteValue($0, symbol: "tag") }
    }

    /// The export folder a person typed or completed.
    func setExportFolder(_ project: String, path: String) {
        set(["projects", project, "export", "folder"], path,
            done: "Exports of \(project) go to \((path as NSString).lastPathComponent)")
    }
}
