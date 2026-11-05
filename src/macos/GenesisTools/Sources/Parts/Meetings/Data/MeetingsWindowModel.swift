import AppKit
import Foundation
import Observation

/// A note the window shows on the pane that caused it: a success fades, an error stays with Retry and Details.
struct MeetingsNotice: Equatable, Identifiable {
    let id = UUID()
    let text: String
    var detail: String?
    var more: String?
    let tone: NoticePill.Tone
    /// A button beside the note ("Undo", "Retry"), and what it does.
    var actionTitle: String?
    /// The button's SF Symbol; without one the pill draws its generic fix glyph.
    var actionSymbol: String?
    var action: (@MainActor () -> Void)?

    static func == (a: MeetingsNotice, b: MeetingsNotice) -> Bool { a.id == b.id }

    static func failure(_ error: Error, retry: (@MainActor () -> Void)? = nil) -> MeetingsNotice {
        let failure = error as? MeetingsCLI.Failure
        return MeetingsNotice(text: failure?.sentence ?? "The meetings command failed.", more: failure?.detail ?? "\(error)",
                              tone: .error, actionTitle: retry == nil ? nil : "Retry", actionSymbol: "arrow.clockwise", action: retry)
    }
}

/// What a part of a pane holds: not asked yet, being read (with the last answer kept on screen), the answer, or why
/// it failed. "Loading" and "none" stay two states, so a pending read never shows an empty answer.
enum Loadable<Value: Equatable>: Equatable {
    case idle
    case loading(previous: Value?)
    case loaded(Value)
    case failed(MeetingsCLI.Failure, previous: Value?)

    var value: Value? {
        switch self {
        case .idle: return nil
        case .loading(let previous): return previous
        case .loaded(let value): return value
        case .failed(_, let previous): return previous
        }
    }

    var isLoading: Bool { if case .loading = self { return true } else { return false } }
    var failure: MeetingsCLI.Failure? { if case .failed(let failure, _) = self { return failure } else { return nil } }
}

/// A read beside the main one that failed (a meeting's proposals, the config), with words that say what is missing
/// on screen, so a failed read never looks like a successful empty one.
struct MeetingsUnread: Equatable {
    enum Source: String { case proposals, projects, projectSettings }
    let source: Source
    let failure: MeetingsCLI.Failure

    var text: String {
        switch source {
        case .proposals: return "The proposed projects did not load: \(failure.sentence)"
        case .projects: return "The known projects did not load, so the picker lists only the proposals: \(failure.sentence)"
        case .projectSettings: return "The project's settings did not load: \(failure.sentence)"
        }
    }

    static func of(_ reads: [(Source, MeetingsCLI.Failure?)]) -> [MeetingsUnread] {
        reads.compactMap { source, failure in failure.map { MeetingsUnread(source: source, failure: $0) } }
    }
}

func asFailure(_ error: Error) -> MeetingsCLI.Failure {
    error as? MeetingsCLI.Failure ?? MeetingsCLI.Failure(sentence: "The meetings command failed.", detail: "\(error)")
}

/// The Meetings window: which place the sidebar shows, the meetings of the window's days, and the open meeting.
@Observable
@MainActor
final class MeetingsWindowModel {
    enum Place: Hashable {
        case needs
        case all
        case project(String)
    }

    var place: Place
    var selectedMeetingID: String?
    private(set) var overview: Loadable<MeetingsOverview> = .idle
    private(set) var settings: Loadable<MeetingsSettings> = .idle
    private(set) var detail: MeetingDetailModel?
    var notice: MeetingsNotice?
    var days: Int
    private var overviewGeneration = 0

    init(defaults: UserDefaults = .standard) {
        place = MeetingsPreferences.openOn(defaults) == .needs ? .needs : .all
        days = MeetingsPreferences.days(defaults)
    }

    /// The meetings the sidebar's place shows, newest first.
    var visibleMeetings: [OverviewMeeting] {
        guard let overview = overview.value else { return [] }
        switch place {
        case .all: return overview.meetings
        case .project(let name): return overview.meetings.filter { $0.project == name }
        case .needs:
            let waiting = Set(overview.needsYou.noProject + overview.needsYou.questions.map(\.id) + overview.needsYou.suggestions.map(\.id))
            return overview.meetings.filter { waiting.contains($0.id) }
        }
    }

    /// The visible meetings in one group per day, in list order.
    var meetingsByDay: [(day: String, meetings: [OverviewMeeting])] {
        var groups: [(day: String, meetings: [OverviewMeeting])] = []
        for meeting in visibleMeetings {
            if groups.last?.day == meeting.day {
                groups[groups.count - 1].meetings.append(meeting)
            } else {
                groups.append((meeting.day, [meeting]))
            }
        }
        return groups
    }

    func meeting(_ id: String) -> OverviewMeeting? {
        overview.value?.meetings.first { $0.id == id }
    }

    func load() {
        loadOverview()
        loadSettings()
    }

    func loadOverview() {
        overviewGeneration += 1
        let generation = overviewGeneration
        overview = .loading(previous: overview.value)
        let days = days
        Task {
            do {
                let value = try await MeetingsCLI.json(MeetingsOverview.self, ["overview", "--days", String(days), "--json"])
                guard generation == overviewGeneration else { return }
                receive(value)
            } catch {
                guard generation == overviewGeneration else { return }
                receive(failure: asFailure(error))
            }
        }
    }

    /// A read failed: the list keeps the meetings it showed, and the pane says why with a Retry.
    func receive(failure: MeetingsCLI.Failure) {
        overview = .failed(failure, previous: overview.value)
    }

    /// A read overview lands: the list shows it, and a selection it no longer holds moves to the first row.
    func receive(_ value: MeetingsOverview) {
        overview = .loaded(value)
        if selectedMeetingID == nil {
            select(visibleMeetings.first?.id)
        }
    }

    func loadSettings() {
        settings = .loading(previous: settings.value)
        Task {
            do {
                settings = .loaded(try await MeetingsCLI.json(ConfigShow.self, ["config", "show", "--json"]).value)
            } catch {
                settings = .failed(asFailure(error), previous: settings.value)
            }
        }
    }

    func show(days: Int) {
        self.days = days
        loadOverview()
    }

    func go(_ place: Place) {
        self.place = place
        if let id = selectedMeetingID, visibleMeetings.contains(where: { $0.id == id }) { return }
        select(visibleMeetings.first?.id)
    }

    func select(_ id: String?) {
        selectedMeetingID = id
        if place == .needs, id.map({ needsSelection?.hasSuffix($0) != true }) ?? true {
            needsSelection = id
        }
        guard let id else {
            detail = nil
            return
        }
        if detail?.id != id {
            detail = MeetingDetailModel(id: id, window: self)
            detail?.load()
        }
    }

    /// The Needs you row that is selected: its tag names the group ("q:<id>" questions, "s:<id>" suggestions).
    private(set) var needsSelection: String?

    /// A Needs you row was picked: the meeting opens on the tab that answers it (Items for questions and suggestions).
    func select(needsTag tag: String?) {
        needsSelection = tag
        guard let tag else { return }
        if tag.hasPrefix("q:") || tag.hasPrefix("s:") {
            select(String(tag.dropFirst(2)))
            detail?.show(.items)
        } else {
            select(tag)
        }
    }

    /// Moves the selection by `offset` rows of the visible list (Up and Down).
    func step(_ offset: Int) {
        let ids = visibleMeetings.map(\.id)
        guard !ids.isEmpty else { return }
        let index = selectedMeetingID.flatMap { ids.firstIndex(of: $0) } ?? (offset > 0 ? -1 : ids.count)
        select(ids[min(max(index + offset, 0), ids.count - 1)])
    }

    /// The window became key again: what changed outside it (a confirm in a terminal, a new meeting) shows.
    func refreshAfterReturn() {
        loadOverview()
        loadSettings()
        detail?.refreshLoaded()
    }
}
