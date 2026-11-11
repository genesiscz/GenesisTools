import AppKit
import Foundation
import Observation

extension StackedNotice {
    /// A failed meetings command as a notice on the pane that ran it: the CLI's sentence, its own text behind Details,
    /// and Retry when running it again can help. An error stays until it is closed or retried. A source that can fail
    /// again and again (a test run per keystroke) passes one `id`, so its next failure replaces the last.
    /// "Details" opens the failure window (the error, its output, Copy context for agents, Report a bug).
    @MainActor
    static func meetingsFailure(_ error: Error, id: StackedNotice.ID = StackedNotice.ID(),
                                retry: (@MainActor () -> Void)? = nil) -> StackedNotice {
        let failure = error as? MeetingsCLI.Failure
        let text = failure?.sentence ?? "The meetings command failed."
        let more = failure?.detail ?? "\(error)"
        var report = FailureReport.unexpected(more, outcome: "A Meetings action failed", action: "Use the Meetings window",
                                              title: "Meetings action failed", area: "meetings")
        report.headline = FailureLog.sentence(text) ?? text
        report.command = failure?.command
        report.stack = failure?.stack
        report.issue = failure?.issue
        let actions: [StackedNotice.Action] = (retry.map { [.retry($0)] } ?? []) + [.details(report, retry: retry)]
        return StackedNotice(id: id, text: text, more: more, tone: .error, actions: actions)
    }
}

extension MeetingsCLI.Failure {
    /// The report retains the failure's event time. Cached app facts avoid disk reads in a view body.
    @MainActor
    func report(outcome: String = "A Meetings read failed", action: String = "Use the Meetings window") -> FailureReport {
        var report = FailureReport.unexpected(detail, outcome: outcome, action: action, title: outcome, area: "meetings",
                                              time: occurredAt, app: .launch)
        report.headline = FailureLog.sentence(sentence) ?? sentence
        report.command = command
        report.stack = stack
        report.issue = issue
        return report
    }

    /// "Details" on a notice pill: the failure window on this failure, with Try again.
    @MainActor
    func detailsFix(retry: (@MainActor () -> Void)? = nil) -> NoticeFix {
        .details(report(), retry: retry)
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
        /// Every person the directory knows (R24, G-PPL-5): a view of the window, not of a meeting.
        case contacts
    }

    var place: Place
    var selectedMeetingID: String?
    private(set) var overview: Loadable<MeetingsOverview> = .idle
    /// How often an answer replaced the list. Each set redraws every view of it, so an unchanged answer must not set it
    /// (the perf tests read this).
    @ObservationIgnored private(set) var overviewSets = 0
    private(set) var settings: Loadable<MeetingsSettings> = .idle
    /// The same config read as JSON: the side panel's engine rows and the Contacts view's source switches read their
    /// values here, and each write names the value it replaces (`expect`).
    private(set) var settingsRaw: JSONValue?
    private(set) var detail: MeetingDetailModel?
    var days: Int
    /// The settings side panel is open in the meeting's trailing pane slot (it replaces the transcript pane there). The
    /// open state is remembered, not a setting (G55).
    var sidePanelOpen = false {
        didSet { if remembersPanel, oldValue != sidePanelOpen { defaults.set(sidePanelOpen, forKey: Self.sidePanelOpenKey) } }
    }
    /// The side panel's folded sections by id, remembered the same way.
    var sidePanelFolded: Set<String> = [] {
        didSet { if remembersPanel, oldValue != sidePanelFolded { defaults.set(sidePanelFolded.sorted(), forKey: Self.sidePanelFoldedKey) } }
    }
    /// False in a snapshot run: opening the panel for a picture must not change what the real window opens with.
    @ObservationIgnored var remembersPanel = true
    /// The window's people: the Contacts view and an assignment's reach sheet.
    @ObservationIgnored private(set) lazy var people = MeetingsPeopleModel(window: self)
    static let sidePanelOpenKey = "meetings.window.sidePanelOpen"
    static let sidePanelFoldedKey = "meetings.window.sidePanelFolded"
    /// The edge of a pane its notices float at (`meetings.notices.place`): an observed value, so a change in the side
    /// panel moves the stack at once. The Settings page runs in another process; its change lands when this window
    /// becomes key again (`refreshAfterReturn`).
    private(set) var noticePlace: MeetingsPreferences.NoticePlace
    /// The Moment player: every Moment of the window plays here, one at a time, with its context stack (F1b).
    var player = MomentPlayer()
    /// The window's one notice stack (R31): every meeting's notices, so a notice of a meeting that is not open stays on
    /// screen and names it (G34).
    @ObservationIgnored let notices: NoticeStackModel
    /// Events arrive: the window's subscription to the Meetings service is live. False while it is lost or was never
    /// made (no service runs); the panes then read again when the window becomes key.
    private(set) var liveUpdates = false
    /// The subscription was lost (or never came up) for longer than `liveLostGrace`: the detail says "Live updates off".
    private(set) var liveUpdatesOff = false
    private var overviewGeneration = 0
    private let loadDetail: @MainActor (MeetingDetailModel) -> Void
    /// The app defaults the window settings live in (`.standard` in the app; a test passes its own suite).
    @ObservationIgnored let defaults: UserDefaults
    /// The clock the panes' notices count on; nil is the real one (a test passes a `ManualNoticeClock`).
    @ObservationIgnored private let noticeClock: NoticeClock?
    /// The window's Meetings service; nil in the preview build, under XCTest and when it is turned off.
    @ObservationIgnored let service: MeetingsService?
    @ObservationIgnored private var listening: MeetingsService.Listening?
    @ObservationIgnored private var liveLostTask: Task<Void, Never>?
    @ObservationIgnored private var overviewRefresh: Task<Void, Never>?
    /// The events heard since the last overview refresh.
    @ObservationIgnored private var overviewBurst = OverviewBurst()
    /// One overview read in flight per service and days, shared by every window model of the process.
    private static let overviewReads = MeetingsSharedRead<OverviewKey, MeetingsOverview>()

    struct OverviewKey: Hashable {
        let service: ObjectIdentifier?
        let days: Int
    }

    /// The events of one burst, as far as the overview cares.
    struct OverviewBurst: Equatable {
        /// The last event's arrival: a read that started after it shows every change of the burst.
        var heardAt: ContinuousClock.Instant?
        /// The decision tokens heard.
        var tokens: Set<String> = []
        /// An event that is no decision (a changed record, a comment).
        var other = false
    }
    /// The notices of other actors' decisions, merged per actor and meeting within `burstSeconds` (G38).
    @ObservationIgnored private var bursts: [String: Burst] = [:]

    /// How long a lost subscription may take to come back before the detail says so.
    static let liveLostGrace: Duration = .seconds(5)
    /// One actor's decisions within this many seconds share one notice with one Undo (G38).
    static let burstSeconds: TimeInterval = 5

    /// `service` nil is the window's shared service (`MeetingsService.shared`, itself nil under XCTest and in the preview).
    init(defaults: UserDefaults = .standard, noticeClock: NoticeClock? = nil, service: MeetingsService? = nil,
         loadDetail: @escaping @MainActor (MeetingDetailModel) -> Void = { $0.load() }) {
        self.loadDetail = loadDetail
        self.defaults = defaults
        self.noticeClock = noticeClock
        self.service = service ?? MeetingsService.shared
        MeetingsPreferences.migrate(defaults)
        place = MeetingsPreferences.openOn(defaults) == .needs ? .needs : .all
        days = MeetingsPreferences.days(defaults)
        noticePlace = MeetingsPreferences.noticePlace(defaults)
        sidePanelOpen = defaults.bool(forKey: Self.sidePanelOpenKey)
        sidePanelFolded = Set(defaults.stringArray(forKey: Self.sidePanelFoldedKey) ?? [])
        notices = NoticeStackModel(clock: noticeClock, timing: { [defaults] in MeetingsPreferences.noticeTiming(defaults) },
                                   maxVisible: { [defaults] in MeetingsPreferences.Notices.maxVisible.value(defaults) })
    }

    /// The window's notice stack; every pane pushes into it.
    func makeNoticeStack() -> NoticeStackModel { notices }

    /// The newest notice with an Undo that still waits for a press: what ⌘Z takes back (its text, for the menu item).
    var newestUndo: String? { newestUndoNotice?.notice.text }

    private var newestUndoNotice: (notice: StackedNotice, action: StackedNotice.Action)? {
        for notice in notices.notices.reversed() where notices.waiting[notice.id] == nil {
            if let undo = notice.actions.first(where: { $0.label == "Undo" }) { return (notice, undo) }
        }
        return nil
    }

    /// ⌘Z with no text field in focus: presses the newest notice's Undo (G39). False when none waits.
    @discardableResult
    func undoNewest() -> Bool {
        guard let newest = newestUndoNotice else { return false }
        notices.press(newest.action, of: newest.notice.id)
        return true
    }

    /// A window setting changed (the side panel wrote one, or the window came back after the Settings page): the values
    /// the window model holds read again. The views read every other window setting from the defaults themselves.
    func windowSettingsChanged() {
        let place = MeetingsPreferences.noticePlace(defaults)
        if place != noticePlace { noticePlace = place }
    }

    /// The meetings the sidebar's place shows, newest first.
    var visibleMeetings: [OverviewMeeting] {
        guard let overview = overview.value else { return [] }
        switch place {
        case .all: return overview.meetings
        case .contacts: return []
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
        startLiveUpdates()
    }

    /// The list: the Meetings service's `meetings.overview`, or `overview --days <n> --json` when no service answers.
    static func overviewRead(days: Int) -> MeetingsRead<MeetingsOverview> {
        .service(MeetingsAPI.Overview.self, .init(days: days), orRun: ["overview", "--days", String(days), "--json"])
    }

    /// The whole meetings config: `config.read`, or `config show --json`.
    static let settingsRead: MeetingsRead<ConfigShow> = .service(MeetingsAPI.ConfigShowRead.self, .init(), orRun: ["config", "show", "--json"])

    /// `quiet` (a return to the window, an event): the list keeps what it shows until the answer lands.
    /// `changedAt` is when the change this read must show happened (an event's arrival); a read of another window model
    /// or caller that started after it answers this one too (`overviewReads`). Nil: now.
    func loadOverview(quiet: Bool = false, changedAt: ContinuousClock.Instant? = nil) {
        overviewGeneration += 1
        let generation = overviewGeneration
        if !quiet { overview = .loading(previous: overview.value) }
        let days = days
        let service = service
        let key = OverviewKey(service: service.map(ObjectIdentifier.init), days: days)
        Task {
            do {
                let value = try await Self.overviewReads.value(for: key, changedAt: changedAt ?? .now) {
                    try await Self.overviewRead(days: days).run(service: service)
                }
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
        detail?.listResolved()
    }

    /// A read overview lands: the list shows it, and a selection it no longer holds moves to the first row. An answer
    /// equal to the shown one is not set again, so an unchanged list redraws nothing.
    func receive(_ value: MeetingsOverview) {
        if overview != .loaded(value) {
            overview = .loaded(value)
            overviewSets += 1
            HubMainBusy.measure("meetings.overview.render")
        }
        if selectedMeetingID == nil {
            select(visibleMeetings.first?.id)
        }
        detail?.listResolved()
    }

    func loadSettings(quiet: Bool = false) {
        if !quiet { settings = .loading(previous: settings.value) }
        Task {
            let next: Loadable<MeetingsSettings>
            do {
                let shown = try await Self.settingsRead.run(service: service)
                if settingsRaw != shown.raw {
                    if settingsRaw?.at(["global", "playback", "listen"]) != shown.raw.at(["global", "playback", "listen"]) {
                        player.invalidateClipCache()
                    }
                    settingsRaw = shown.raw
                }
                next = .loaded(shown.value)
            } catch {
                next = .failed(asFailure(error), previous: settings.value)
            }
            if settings != next { settings = next }
        }
    }

    // MARK: Config writes from the window (the side panel's engine rows, the Contacts view's sources)

    /// Sets one meetings config value, or puts it back to its default when `value` is nil (`config.set`, `config.unset`,
    /// else the command), naming the value the window read there, then reads the config again. A refusal is a notice
    /// with Retry; the control shows the saved value again after the read.
    func setConfig(_ path: [String], _ value: JSONValue?, done: String? = nil) {
        let write: MeetingsConfigWrite = value.map { .set(path, $0, readFrom: settingsRaw) } ?? .unset(path, readFrom: settingsRaw)
        Task {
            do {
                try await write.run(service: service)
                if path.starts(with: ["global", "playback", "listen"]) { player.invalidateClipCache() }
                // The next write at this path names this value, not the one before it, even before the read lands.
                if let value { settingsRaw = settingsRaw?.setting(path, to: value) }
                if let done { notices.push(StackedNotice(text: done)) }
            } catch let failure as MeetingsCLI.Failure where failure.code == "config-stale" {
                notices.push(MeetingsSettingsModel.staleNotice(failure))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.setConfig(path, value, done: done) })
            }
            loadSettings(quiet: true)
        }
    }

    /// Plays the tone alone with `sound` (`tone.preview` cuts it; the side panel's Play button). Only the service cuts a
    /// preview; without one a notice says so, since a second tone maker would be a second engine (R7).
    func previewTone(_ sound: MeetingsAPI.ToneSoundSetting) {
        Task {
            do {
                try await TonePreviewPlayer.play(sound, service: service)
            } catch is MeetingsService.Unavailable {
                notices.push(StackedNotice(text: TonePreviewPlayer.unavailableText))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.previewTone(sound) })
            }
        }
    }

    func show(days: Int) {
        self.days = days
        loadOverview()
    }

    func go(_ place: Place) {
        self.place = place
        // The Contacts view lists people, not meetings: the open meeting stays open for the way back.
        if place == .contacts {
            people.ensure()
            return
        }
        if let id = selectedMeetingID, visibleMeetings.contains(where: { $0.id == id }) { return }
        select(visibleMeetings.first?.id)
    }

    /// Opens a meeting, on `tab` when given: the tab is set before the first read, so only its data loads. The meeting
    /// it replaces stops its reads in flight.
    func select(_ id: String?, tab: MeetingDetailModel.Tab? = nil) {
        selectedMeetingID = id
        if place == .needs, id.map({ needsSelection?.hasSuffix($0) != true }) ?? true {
            needsSelection = id
        }
        guard let id else {
            detail?.cancelReads()
            detail = nil
            return
        }
        if detail?.id != id {
            detail?.cancelReads()
            let next = MeetingDetailModel(id: id, window: self)
            next.tab = tab ?? MeetingDetailModel.firstTab(for: meeting(id))
            next.tabIsDefault = tab == nil
            detail = next
            HubMainBusy.measure("meetings.detail.open")
            loadDetail(next)
        } else if let tab {
            detail?.show(tab)
        }
    }

    /// The Needs you row that is selected: its tag names the group ("q:<id>" questions, "s:<id>" suggestions).
    private(set) var needsSelection: String?

    /// A Needs you row was picked: the meeting opens on the tab that answers it (Items for questions and suggestions).
    func select(needsTag tag: String?) {
        needsSelection = tag
        guard let tag else { return }
        if tag.hasPrefix("q:") || tag.hasPrefix("s:") {
            select(String(tag.dropFirst(2)), tab: .items)
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

    /// Set by the face: the window is on screen and not covered, hidden or minimized. A row plays by itself only then.
    @ObservationIgnored var windowVisible = true

    /// The window became key again. While the subscription is live the events already showed every change, so
    /// nothing reads; without it (no service, a lost subscription) what changed outside the window (a confirm in a
    /// terminal, a new meeting) reads now, quietly: what is on screen stays until an answer differs.
    func refreshAfterReturn() {
        windowSettingsChanged()
        guard !liveUpdates else { return }
        HubMainBusy.measure("meetings.refresh", window: 1.5)
        loadOverview(quiet: true)
        loadSettings(quiet: true)
        detail?.refreshLoaded()
    }

    // MARK: Live updates (R36)

    /// Subscribes the window to every meeting's events once: the open meeting updates its rows in place on a decision,
    /// a meeting changed outside the service reads its changed parts, and the sidebar's counts follow (G50). Subscribing
    /// to all meetings, not only the open one, is what lets the counts and a notice of another meeting follow too.
    func startLiveUpdates() {
        guard let service, listening == nil else { return }
        listening = service.listen { [weak self] signal in self?.receive(signal) }
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await service.subscribe(events: MeetingsAPI.windowEvents)
                self.setLive(true)
            } catch {
                // No service yet: the kept subscription connects by itself once one runs (`.resumed`).
                self.setLive(false)
            }
        }
    }

    /// A second window closes: its own listener stops, and the shared service keeps the subscription the other windows
    /// listen on (`stopLiveUpdates` unsubscribes the service itself).
    func detachLiveUpdates() {
        listening?.cancel()
        listening = nil
    }

    // MARK: - Duplicate and rename

    /// The meeting whose title the header edits now: a double click on the title, or Rename… in a menu.
    var renamingMeetingID: String?
    /// The meetings a duplicate runs for, so a second press waits for the first.
    private(set) var duplicating: Set<String> = []

    /// `meetings duplicate --json`'s answer.
    struct DuplicateResult: Decodable, Equatable {
        let from: String
        let id: String
        let title: String
    }

    /// Copies a meeting into a new record (`meetings duplicate`) and opens the copy, with its title ready to edit.
    func duplicate(_ id: String) {
        guard !duplicating.contains(id) else { return }
        duplicating.insert(id)
        Task {
            defer { duplicating.remove(id) }
            do {
                let copy = try await MeetingsCLI.json(DuplicateResult.self, ["duplicate", id, "--json"], timeoutSeconds: 120)
                loadOverview(quiet: true)
                select(copy.id)
                renamingMeetingID = copy.id
                notices.push(StackedNotice(text: "Duplicated as \(copy.title)"))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.duplicate(id) })
            }
        }
    }

    /// Stops the events (the window closes).
    func stopLiveUpdates() {
        listening?.cancel()
        listening = nil
        service?.unsubscribe()
        setLive(false)
    }

    /// One signal of the subscription.
    func receive(_ signal: MeetingsServiceSignal) {
        switch signal {
        case .event(let event):
            detail?.receive(event)
            receive(event)
        case .resumed:
            setLive(true)
            // Events between the two connections were not heard: what the window shows reads again once.
            loadOverview(quiet: true)
            detail?.refreshLoaded()
        case .lost:
            setLive(false)
        }
    }

    private func setLive(_ live: Bool) {
        if liveUpdates != live { liveUpdates = live }
        liveLostTask?.cancel()
        if live {
            if liveUpdatesOff { liveUpdatesOff = false }
            return
        }
        // A reconnect usually takes about a second: the detail says "Live updates off" only when it takes longer.
        liveLostTask = Task { [weak self] in
            try? await Task.sleep(for: Self.liveLostGrace)
            guard let self, !Task.isCancelled, !self.liveUpdates else { return }
            self.liveUpdatesOff = true
        }
    }

    /// The menu's and the banner's Reload: the subscription again, and every part read again.
    func reloadAll() {
        load()
        detail?.refreshLoaded(force: true)
    }

    /// An event the window itself answers: the sidebar's counts, and a notice for a decision someone else made.
    private func receive(_ event: MeetingsEvent) {
        if case .peopleChanged = event, place == .contacts { people.load() }
        if Self.changesOverview(event) { scheduleOverviewRefresh(event) }
        guard let entry = event.entry, let meeting = event.meeting, entry.actor.kind != DecisionActor.window.kind else { return }
        noteDecision(entry, meeting: meeting)
    }

    /// Whether an event can change the overview. The overview is read from the meeting records alone (`meeting.json`,
    /// which `show` names), so a `meeting.changed` that names only the timeline (a frame or an OCR line of a live
    /// recording) changes nothing in it: 506 such events in one evening each cost a full overview read (2026-11-11).
    static func changesOverview(_ event: MeetingsEvent) -> Bool {
        switch event {
        case .meetingChanged(let changed): changed.parts.contains("show")
        case .decisionApplied, .decisionReverted, .commentSent: true
        case .peopleChanged: false
        }
    }

    /// Whether a burst of events still needs the overview read: not when every event in it was a decision this window
    /// made, because the decision's own path reads the overview when it lands. Checked when the burst ends, since a
    /// decision's event can arrive before its answer names the token.
    static func burstNeedsOverview(_ burst: OverviewBurst, own: Set<String>) -> Bool {
        burst.other || !burst.tokens.isSubset(of: own)
    }

    /// The sidebar reads the overview again once per burst of events, not once per event.
    private func scheduleOverviewRefresh(_ event: MeetingsEvent) {
        overviewBurst.heardAt = .now
        if let token = event.entry?.token { overviewBurst.tokens.insert(token) } else { overviewBurst.other = true }
        overviewRefresh?.cancel()
        overviewRefresh = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, !Task.isCancelled else { return }
            let burst = self.overviewBurst
            self.overviewBurst = OverviewBurst()
            guard Self.burstNeedsOverview(burst, own: self.detail?.ownTokens ?? []) else { return }
            self.loadOverview(quiet: true, changedAt: burst.heardAt)
        }
    }

    // MARK: Notices of other actors' decisions (G34, G38)

    private struct Burst {
        let notice: StackedNotice.ID
        var tokens: [String]
        var items: Set<String>
        var at: Date
    }

    /// A decision an agent, the terminal or a rule made: one notice per actor and meeting within `burstSeconds`, with one
    /// Undo for all of it; a meeting that is not open is named.
    func noteDecision(_ entry: JournalEntry, meeting: String, now: Date = Date()) {
        guard entry.action.kind != "comment", entry.action.kind != "revert" || !entry.changes.isEmpty else { return }
        let key = "\(meeting)|\(MeetingsWords.actor(entry.actor))"
        var burst = bursts[key]
        if let current = burst, now.timeIntervalSince(current.at) > Self.burstSeconds || !notices.contains(current.notice) {
            burst = nil
        }
        let items = entry.touched
        var next = burst ?? Burst(notice: StackedNotice.ID(), tokens: [], items: [], at: now)
        next.tokens.append(entry.token)
        next.items.formUnion(items)
        next.at = now
        bursts[key] = next
        let open = detail.flatMap { $0.id == meeting ? $0 : nil }
        let text = Self.decisionNotice(entry, items: next.items.count, decisions: next.tokens.count,
                                       meetingTitle: meeting == selectedMeetingID ? nil : self.meeting(meeting)?.displayTitle ?? meeting,
                                       label: { open?.rowName($0) ?? $0 })
        let tokens = next.tokens
        let notice = StackedNotice(id: next.notice, text: text, detail: entry.reason.map { "Why: \($0)" },
                                   actions: [.undo { [weak self] id in self?.revert(tokens, in: meeting, replacing: id) }])
        notices.push(notice, replacing: burst == nil ? nil : next.notice)
    }

    /// "An agent (Claude Code, session 3f98b772) confirmed i3", or for a burst "… decided 7 items", with the meeting
    /// named when it is not the open one.
    static func decisionNotice(_ entry: JournalEntry, items: Int, decisions: Int, meetingTitle: String?,
                               label: (String) -> String = { $0 }) -> String {
        let who = MeetingsWords.actor(entry.actor)
        let what: String
        if decisions > 1 {
            what = "decided \(Plural.count(items, "item"))"
        } else {
            what = MeetingsWords.entryAction(entry, label: label)
        }
        let sentence = who.prefix(1).uppercased() + who.dropFirst() + " " + what
        return meetingTitle.map { "\($0): \(sentence)" } ?? sentence
    }

    /// The Undo of a burst: each decision taken back, newest first.
    func revert(_ tokens: [String], in meeting: String, replacing: StackedNotice.ID?) {
        Task { [weak self] in
            guard let self else { return }
            var failed: MeetingsCLI.Failure?
            for token in tokens.reversed() {
                do {
                    _ = try await MeetingDetailModel.revertDecision(meeting: meeting, token: token, items: nil, service: self.service)
                } catch {
                    failed = asFailure(error)
                }
            }
            if let failed {
                self.notices.push(StackedNotice(text: "Not every decision was undone: \(failed.sentence)", more: failed.detail,
                                                tone: .error), replacing: replacing)
            } else {
                self.notices.push(StackedNotice(text: "Undone"), replacing: replacing)
            }
            if self.detail?.id == meeting { self.detail?.refreshAfterDecision() }
            self.loadOverview(quiet: true)
        }
    }
}
