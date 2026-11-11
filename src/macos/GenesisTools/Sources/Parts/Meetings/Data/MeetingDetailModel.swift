import AppKit
import Foundation
import GenesisToolsHost
import Observation

/// One meeting in the window: its record, and each tab's data read the first time the tab shows. Every change runs a
/// `tools meetings …` command and then reads the record again, so the pane always shows what was saved.
@Observable
@MainActor
final class MeetingDetailModel {
    enum Tab: String, CaseIterable, Identifiable {
        case transcript, screen, items, speakers, context
        var id: String { rawValue }
        var title: String {
            switch self {
            case .transcript: return "Transcript"
            case .screen: return "Screen"
            case .items: return "Items"
            case .speakers: return "Speakers"
            case .context: return "Context"
            }
        }
    }

    let id: String
    weak var window: MeetingsWindowModel?
    /// The defaults the window settings live in: the window's (a test passes its own suite), `.standard` without one.
    var defaults: UserDefaults { window?.defaults ?? .standard }
    var tab: Tab = .transcript
    /// The tab is the one the meeting opened on by itself, not one a request named or the reader picked.
    var tabIsDefault = false
    private(set) var record: Loadable<MeetingRecordView> = .idle
    private(set) var transcript: Loadable<MeetingTranscript> = .idle
    private(set) var timeline: Loadable<ScreenTimeline> = .idle
    /// `meeting.speakers`: talk time per label with its spans (the Speakers tab's lanes, R40) and the hints.
    private(set) var speakers: Loadable<MeetingsAPI.MeetingSpeakers.Result> = .idle
    private(set) var proposals: Loadable<AssignProposals> = .idle
    /// Item ids with a command in flight: their buttons wait, so a second press cannot run it twice.
    var busyItems: Set<String> = []
    var busy: Set<String> = []
    /// The notices of this pane's actions, floating over its tabs: several at once, each with its own Undo and time.
    @ObservationIgnored let notices: NoticeStackModel
    private var recordGeneration = 0
    private var transcriptGeneration = 0
    private var timelineGeneration = 0
    private var speakersGeneration = 0
    private var proposalsGeneration = 0
    @ObservationIgnored private var refreshGeneration = 0
    /// The read in flight per part. A new read of a part cancels the one before it, which stops its process, its
    /// server call or its Meetings service call (`$/cancel`); `cancelReads()` stops them all.
    @ObservationIgnored private var inFlight: [AnyKeyPath: Task<Void, Never>] = [:]
    /// The record and rows read together after a decision (`readRecordAndRows`). Kept apart from `inFlight`: a later
    /// read of one part must not cancel the other part's half.
    @ObservationIgnored private var pairRead: Task<Void, Never>?
    /// The window let this meeting go (another one opened): no read starts, and one that still lands is ignored.
    @ObservationIgnored private(set) var isDropped = false
    /// Opened before the list showed the meeting: whether proposals read waits for its record.
    @ObservationIgnored private var proposalsAwaitRecord = false
    /// The first tab read waits for the list (`firstReadWaitsForList`).
    @ObservationIgnored private var tabAwaitsList = false
    /// A change made the transcript stale while its tab was hidden: the next show reads it quietly over the old lines.
    @ObservationIgnored private var transcriptStale = false

    /// A part of the pane with a `meetings revisions` token.
    enum RevisionPart: Hashable { case record, transcript, speakers, timeline }
    /// The token each part was read at. A return to the window reads a part again only when its token changed; a part
    /// read without one (the first open) reads on the first return and keeps a token from then on.
    @ObservationIgnored private var readAt: [RevisionPart: String] = [:]

    // MARK: Review rows (F6; the logic is in MeetingDetailModel+Rows.swift)

    /// The review rows (`meeting.rows`): what the Items tab lists, computed by the engine.
    var rows: Loadable<ReviewRows> = .idle
    @ObservationIgnored var rowsGeneration = 0
    /// The keyboard's row.
    var selectedRow: String?
    /// The row whose editor is open (a spelling, a person, a typed answer, a reason).
    var editingRow: String?
    /// What was typed in a row's editor, by row id (R10, R11, G4): it survives a re-read, a fold and a decision made
    /// elsewhere meanwhile.
    var drafts: [String: String] = [:]
    /// The reason typed for a row's next decision, by row id (G5: one word for a comment and a reason).
    var reasons: [String: String] = [:]
    /// Rows decided elsewhere while their editor held a draft, with the entry that decided them (G47, G48).
    var decidedMeanwhile: [String: JournalEntry] = [:]
    /// The "This also affects" sheet waiting for an answer (R22).
    var pendingReach: PendingReach?
    /// The sheet's struck items: they leave the decision (genesiscz.md 6).
    var pendingStruck: Set<String> = []
    /// Answered questions whose answer is being changed: their choices show until a new answer replaces it or "Keep".
    var changingRows: Set<String> = []
    /// What this window's last answer to a question row left out, by row id: a changed answer strikes it again.
    @ObservationIgnored var carriedStruck: [String: [String]] = [:]
    /// The History sheet: the meeting's journal, or one row's (G43).
    var history: HistorySheet?
    /// Rows this window just answered that keep their open height until the reader scrolls, so the rows under them do
    /// not move (G33, `meetings.rows.keepPlace`).
    var heldFolds: Set<String> = []
    /// The row each window decision was about, by its journal token: an event of it is not news.
    @ObservationIgnored var ownTokens: Set<String> = []
    /// The tokens of the decision events heard since the last event refresh: a burst that holds only decisions whose
    /// own path already read the record and the rows reads nothing again.
    @ObservationIgnored var eventBurstTokens: Set<String> = []
    /// The window's decisions whose own path read the record and the rows again (`refreshAfterDecision`).
    @ObservationIgnored var refreshedTokens: Set<String> = []
    @ObservationIgnored var rowDecisionTokens: [String: String] = [:]
    @ObservationIgnored var autoplayTask: Task<Void, Never>?
    @ObservationIgnored var eventRefresh: Task<Void, Never>?
    /// The Meetings service the writes go through; nil runs the commands (tests, the preview, a service turned off).
    @ObservationIgnored let service: MeetingsService?
    /// The comments for the listening agent (R43): the staged ones and who listens now; the service keeps them.
    var comments: Loadable<MeetingsAPI.CommentList.Result> = .idle
    /// The last send of the staged comments, and how many listeners got it (G60).
    var commentDelivery: CommentDelivery = .idle
    @ObservationIgnored var commentsListening: MeetingsService.Listening?

    init(id: String, window: MeetingsWindowModel?, notices: NoticeStackModel? = nil, service: MeetingsService? = nil) {
        self.id = id
        self.window = window
        self.notices = notices ?? window?.makeNoticeStack() ?? NoticeStackModel(timing: { MeetingsPreferences.noticeTiming() })
        self.service = service ?? window?.service
    }

    func load() {
        reloadRecord()
        if let meeting = window?.meeting(id) {
            if Self.readsProposalsAtOpen(project: meeting.project) { loadProposals() }
        } else {
            // Opened by id before the list shows it (a launch, `tools meetings window <id>`): the record decides.
            proposalsAwaitRecord = true
        }
        if Self.firstReadWaitsForList(rowKnown: window?.meeting(id) != nil, listLoaded: window?.overview.value != nil,
                                      tabIsDefault: tabIsDefault, tab: tab) {
            tabAwaitsList = true
        } else {
            loadTab(tab)
        }
    }

    /// Opened by id before the list landed, on the default Transcript tab: the first tab read waits for the list,
    /// which moves a recording-only meeting to Screen. A launch on one read its transcript first, as a process that
    /// failed (448 ms, 2026-11-07). A tab the request named, and a list that is already here, read at once.
    static func firstReadWaitsForList(rowKnown: Bool, listLoaded: Bool, tabIsDefault: Bool, tab: Tab) -> Bool {
        !rowKnown && !listLoaded && tabIsDefault && tab == .transcript
    }

    /// The list landed or failed: a first tab read that waited for it runs now, on the tab the list chose.
    func listResolved() {
        guard tabAwaitsList else { return }
        tabAwaitsList = false
        listLanded(window?.meeting(id))
        loadTab(tab)
    }

    /// The proposals feed only the project picker. A meeting with no project reads them at once, since choosing a
    /// project is its next step; any other reads them when the pointer reaches the picker or the picker opens
    /// (`ensureProposals`). That is one `assign proposals` process, about 600 ms of CPU and a Calendar read, less per
    /// open of a meeting with a project.
    static func readsProposalsAtOpen(project: String?) -> Bool {
        project == nil
    }

    /// The first record of a meeting opened before the list showed it: its project decides whether proposals read now.
    private func recordLanded(_ record: MeetingRecordView) {
        guard proposalsAwaitRecord else { return }
        proposalsAwaitRecord = false
        if Self.readsProposalsAtOpen(project: record.project) { ensureProposals() }
    }

    /// The project picker is about to be used: its proposals read now if nothing read them yet.
    func ensureProposals() {
        if proposals == .idle { loadProposals() }
    }

    func show(_ tab: Tab) {
        self.tab = tab
        tabIsDefault = false
        HubMainBusy.measure("meetings.tab.\(tab.rawValue)")
        loadTab(tab)
    }

    func loadTab(_ tab: Tab) {
        switch tab {
        case .transcript:
            if case .idle = transcript { loadTranscript() } else if transcriptStale { readTranscript(quiet: true) }
        case .screen: if case .idle = timeline { loadTimeline() }
        case .speakers: if case .idle = speakers { loadSpeakers() }
        case .items: if case .idle = rows { loadRows() }
        case .context: break
        }
    }

    /// The transcript pane beside the rows shows: the transcript reads now if nothing read it yet.
    func ensureTranscript() {
        if case .idle = transcript { loadTranscript() } else if transcriptStale { readTranscript(quiet: true) }
    }

    func reloadRecord() { readRecord(quiet: false) }
    func loadTranscript() { readTranscript(quiet: false) }
    func loadTimeline() { readTimeline(quiet: false) }
    func loadSpeakers() { readSpeakers(quiet: false) }
    func loadProposals() { readProposals(quiet: false) }

    /// The record: the Meetings service's `meeting.show`, or `show <id> --json` when no service answers.
    static func recordRead(_ id: String) -> MeetingsRead<MeetingRecordView> {
        .service(MeetingsAPI.Show.self, .init(ref: id), orRun: ["show", id, "--json"])
    }

    /// The corrected transcript: `meeting.transcript`, or `transcript <id> --format json`.
    static func transcriptRead(_ id: String) -> MeetingsRead<MeetingTranscript> {
        .service(MeetingsAPI.Transcript.self, .init(ref: id), orRun: ["transcript", id, "--format", "json"], timeoutSeconds: 120)
    }

    /// The revision token per part: `meeting.revisions`, or `revisions <id> --json`.
    static func revisionsRead(_ id: String) -> MeetingsRead<MeetingRevisions> {
        .service(MeetingsAPI.Revisions.self, .init(ref: id), orRun: ["revisions", id, "--json"])
    }

    func readRecord(quiet: Bool) {
        read(\.record, generation: \.recordGeneration, Self.recordRead(id), quiet: quiet, revision: .record) { [weak self] record in
            self?.recordLanded(record)
        }
    }

    func readTranscript(quiet: Bool) {
        transcriptStale = false
        read(\.transcript, generation: \.transcriptGeneration, Self.transcriptRead(id), quiet: quiet, revision: .transcript)
    }

    func readTimeline(quiet: Bool) {
        let all = MeetingsPreferences.timelineLines() == .all
        read(\.timeline, generation: \.timelineGeneration,
             .command(["screen", id, "--timeline", "--json"] + (all ? ["--all"] : []), timeoutSeconds: 120),
             quiet: quiet, revision: .timeline)
    }

    /// Every OCR line of one frame, for the frame sheet's "All text" when the timeline was read with changed lines only.
    func frameLines(file: String) async throws -> [OcrBox] {
        let view = try await MeetingsCLI.json(ScreenTimeline.self, ["screen", id, "--timeline", "--json", "--frame", file],
                                              timeoutSeconds: 120)
        return view.frames.first?.lines ?? []
    }

    func readSpeakers(quiet: Bool) {
        read(\.speakers, generation: \.speakersGeneration,
             .service(MeetingsAPI.MeetingSpeakers.self, .init(meeting: id), orRun: ["speakers", "stats", id, "--json"], timeoutSeconds: 120),
             quiet: quiet, revision: .speakers)
    }

    private func readProposals(quiet: Bool) {
        read(\.proposals, generation: \.proposalsGeneration, .command(["assign", "proposals", id, "--json"]), quiet: quiet)
    }

    /// One read of a part: through the Meetings service when it answers the read, else as its command. A `quiet` read
    /// (a refresh) keeps what the pane shows until the answer lands, and an answer equal to the shown one is not set
    /// again, so an unchanged pane redraws nothing. A failed read forgets the part's revision token, so the next return
    /// reads it again.
    func read<Value: Decodable & Equatable>(
        _ part: ReferenceWritableKeyPath<MeetingDetailModel, Loadable<Value>>,
        generation: ReferenceWritableKeyPath<MeetingDetailModel, Int>,
        _ source: MeetingsRead<Value>, quiet: Bool, revision: RevisionPart? = nil,
        then landed: ((Value) -> Void)? = nil
    ) {
        guard !isDropped else { return }
        self[keyPath: generation] += 1
        let current = self[keyPath: generation]
        if !quiet { self[keyPath: part] = .loading(previous: self[keyPath: part].value) }
        inFlight[part]?.cancel()
        inFlight[part] = Task { [weak self] in
            do {
                let value = try await source.run()
                guard let self, !self.isDropped, current == self[keyPath: generation] else { return }
                self.settle(part, .loaded(value))
                landed?(value)
            } catch {
                guard let self, !Task.isCancelled, !self.isDropped, current == self[keyPath: generation] else { return }
                if let revision { self.readAt[revision] = nil }
                self.settle(part, .failed(asFailure(error), previous: self[keyPath: part].value))
            }
        }
    }

    /// The record and the rows read again quietly, both at once, and set in one main-actor turn when both answered, so
    /// the Items list re-runs once for the pair instead of once per part (a decision's refresh). A read of either part
    /// started meanwhile wins over that part's half.
    func readRecordAndRows() {
        guard rows != .idle else { return readRecord(quiet: true) }
        guard !isDropped else { return }
        recordGeneration += 1
        rowsGeneration += 1
        let recordTurn = recordGeneration, rowsTurn = rowsGeneration
        let recordSource = Self.recordRead(id)
        let rowsSource = Self.rowsRead(id, lowPriority: MeetingsPreferences.Rows.lowPriority.value(defaults))
        inFlight[\MeetingDetailModel.record]?.cancel()
        inFlight[\MeetingDetailModel.rows]?.cancel()
        pairRead?.cancel()
        pairRead = Task { [weak self] in
            async let record = Self.attempt(recordSource)
            async let rows = Self.attempt(rowsSource)
            let (recordResult, rowsResult) = await (record, rows)
            guard let self, !Task.isCancelled, !self.isDropped else { return }
            if recordTurn == self.recordGeneration {
                self.land(\.record, recordResult, revision: .record) { [weak self] in self?.recordLanded($0) }
            }
            if rowsTurn == self.rowsGeneration {
                self.land(\.rows, rowsResult, revision: nil) { [weak self] in self?.rowsLanded($0) }
            }
        }
    }

    private static func attempt<Value>(_ source: MeetingsRead<Value>) async -> Result<Value, Error> {
        do { return .success(try await source.run()) } catch { return .failure(error) }
    }

    func settleDecisionRecord(_ value: MeetingRecordView) {
        settle(\.record, .loaded(value))
    }

    /// A response patch supersedes reads started before this decision's committed snapshot.
    func cancelReadsBeforeDecisionPatch() {
        recordGeneration += 1
        rowsGeneration += 1
        inFlight[\MeetingDetailModel.record]?.cancel()
        inFlight[\MeetingDetailModel.rows]?.cancel()
        pairRead?.cancel()
    }

    /// One part's answer of a paired read, set as `read` sets it.
    private func land<Value: Equatable>(_ part: ReferenceWritableKeyPath<MeetingDetailModel, Loadable<Value>>,
                                        _ result: Result<Value, Error>, revision: RevisionPart?, then landed: (Value) -> Void) {
        switch result {
        case .success(let value):
            settle(part, .loaded(value))
            landed(value)
        case .failure(let error):
            if let revision { readAt[revision] = nil }
            settle(part, .failed(asFailure(error), previous: self[keyPath: part].value))
        }
    }

    /// Sets a part only when it changes: `@Observable` redraws every view that reads a property on each set, equal or not.
    func settle<Value: Equatable>(_ part: ReferenceWritableKeyPath<MeetingDetailModel, Loadable<Value>>, _ new: Loadable<Value>) {
        if self[keyPath: part] != new { self[keyPath: part] = new }
    }

    /// The window let this meeting go: every read in flight stops (its process ends, the server drops its call), and
    /// none starts again.
    func cancelReads() {
        isDropped = true
        for task in inFlight.values { task.cancel() }
        inFlight.removeAll()
        pairRead?.cancel()
    }

    // MARK: - Actions

    /// Runs one change; on success reads the record (and the window's list) again and shows `done`. `replacing` is
    /// the notice whose button started it (an Undo): the result takes that notice's place.
    private func change(_ key: String, _ args: [String], done: String?, reloadTranscript: Bool = false,
                        undo: (title: String, args: [String])? = nil, applied: (() -> Void)? = nil,
                        replacing: StackedNotice.ID? = nil) {
        guard !busy.contains(key) else {
            if let replacing { notices.release(replacing) }
            return
        }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                _ = try await MeetingsCLI.run(args, timeoutSeconds: 120)
                applied?()
                reloadRecord()
                window?.loadOverview()
                if reloadTranscript { transcriptChanged() }
                if let done {
                    let actions = undo.map { undo in
                        [StackedNotice.Action(undo.title, symbol: "arrow.uturn.backward", afterPress: .wait("Undoing…")) { [weak model = self] id in
                            model?.change(key + ".undo", undo.args, done: "Undone", reloadTranscript: reloadTranscript, replacing: id)
                        }]
                    } ?? []
                    notices.push(StackedNotice(text: done, actions: actions), replacing: replacing)
                } else if let replacing {
                    notices.dismiss(replacing)
                }
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in
                    model?.change(key, args, done: done, reloadTranscript: reloadTranscript, undo: undo, applied: applied)
                }, replacing: replacing)
            }
        }
    }

    func isBusy(_ key: String) -> Bool { busy.contains(key) }

    /// What a change that makes the transcript stale does to it. A transcript never read waits for its first show; a
    /// shown one reads quietly, so its lines and the scroll place stay until the answer lands; a hidden one keeps its
    /// lines and reads quietly when it shows again.
    enum TranscriptRefresh: Equatable { case none, readQuietly, markStale }

    static func transcriptRefresh(read: Bool, showing: Bool) -> TranscriptRefresh {
        guard read else { return .none }
        return showing ? .readQuietly : .markStale
    }

    func transcriptChanged() {
        switch Self.transcriptRefresh(read: transcript != .idle, showing: tab == .transcript) {
        case .none: break
        case .readQuietly: readTranscript(quiet: true)
        case .markStale: transcriptStale = true
        }
    }

    /// The changes that make the corrected transcript stale besides the record: it applies the project's dictionary,
    /// the confirmed items (a reject can take away an unclear mark), the renames and the answers.
    enum Change { case project, label, decision, rename, answer, context }

    static func reloadsTranscript(after change: Change) -> Bool {
        switch change {
        case .project, .decision, .rename, .answer: return true
        case .label, .context: return false
        }
    }

    func setProject(_ project: String?) {
        let reload = Self.reloadsTranscript(after: .project)
        if let project {
            journalChange("project", .set(project: project), done: "Project set to \(project)",
                          orRun: ["set", id, "--project", project], reloadTranscript: reload)
        } else {
            // "No project" has no journal action: the command clears it, without an Undo.
            change("project", ["assign", "apply", id, "--none"], done: "No project for this meeting", reloadTranscript: reload)
        }
    }

    /// One change of the meeting through the decision journal, as the window: its notice has an Undo that takes back
    /// exactly it (G64). Without a service the command `orRun` makes it, as before.
    func journalChange(_ key: String, _ action: DecisionAction, done: String, orRun args: [String], reloadTranscript: Bool) {
        guard let service else {
            change(key, args, done: done, reloadTranscript: reloadTranscript)
            return
        }
        guard !busy.contains(key) else { return }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                let result = try await service.call(MeetingsAPI.DecisionApply.self, .init(meeting: id, action: action, onDecided: "refuse"))
                readRecord(quiet: true)
                window?.loadOverview(quiet: true)
                if reloadTranscript { transcriptChanged() }
                guard let entry = result.entry else {
                    notices.push(StackedNotice(text: result.skipped.first?.reason ?? "Nothing changed"))
                    return
                }
                ownTokens.insert(entry.token)
                notices.push(StackedNotice(text: done, actions: [.undo { [weak self] id in
                    self?.revert(token: entry.token, items: nil, replacing: id)
                }]))
            } catch is MeetingsService.Unavailable {
                busy.remove(key)
                change(key, args, done: done, reloadTranscript: reloadTranscript)
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in
                    self?.journalChange(key, action, done: done, orRun: args, reloadTranscript: reloadTranscript)
                })
            }
        }
    }

    /// The window came back: a part already read reads again only when `meetings revisions` says what it reads changed
    /// (a correction or a confirm in the terminal, a new frame), and quietly. Proposals already read read again each
    /// time: they depend on the Calendar, which has no revision. Without revisions (an older CLI, a failed read) every
    /// part read before reads again, as before.
    /// `force` (the menu's Reload): every part read before reads again, whatever its token says, so a Reload repairs
    /// what a revision missed. `proposals: false` (a live meeting's rounds) leaves the proposals as they are.
    func refreshLoaded(force: Bool = false, proposals: Bool = true) {
        guard !isDropped else { return }
        refreshGeneration += 1
        let generation = refreshGeneration
        let id = id
        let key: AnyKeyPath = \MeetingDetailModel.refreshGeneration
        inFlight[key]?.cancel()
        inFlight[key] = Task { [weak self] in
            let revisions = try? await Self.revisionsRead(id).run()
            guard let self, !Task.isCancelled, !self.isDropped, generation == self.refreshGeneration else { return }
            let recordStale = self.mustRead(.record, revisions?.show)
            if recordStale || force { self.readRecord(quiet: true) }
            if self.transcript != .idle, self.mustRead(.transcript, revisions?.transcript) || force { self.readTranscript(quiet: true) }
            if self.speakers != .idle, self.mustRead(.speakers, revisions?.speakers) || force { self.readSpeakers(quiet: true) }
            if self.timeline != .idle, self.mustRead(.timeline, revisions?.timeline) || force { self.readTimeline(quiet: true) }
            if self.rows != .idle, recordStale || force { self.readRows(quiet: true) }
            if proposals, self.proposals != .idle { self.readProposals(quiet: true) }
        }
    }

    /// Whether a part reads again on this return, keeping the new token for the next one. The token was taken before
    /// the read starts, so the answer is at least as new as the token it keeps.
    private func mustRead(_ part: RevisionPart, _ token: String?) -> Bool {
        let seen = readAt[part]
        readAt[part] = token
        return Self.mustRead(seen: seen, now: token)
    }

    /// A part reads again unless both tokens are known and equal.
    static func mustRead(seen: String?, now: String?) -> Bool {
        guard let seen, let now else { return true }
        return seen != now
    }

    /// Renames the meeting through the journal (`set` with a title), with an Undo. An empty or unchanged title changes
    /// nothing.
    func rename(to typed: String) {
        let title = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = record.value?.title ?? window?.meeting(id)?.title
        guard !title.isEmpty, title != current else { return }
        journalChange("title", .set(title: title), done: "Renamed to \(title)", orRun: ["set", id, "--title", title],
                      reloadTranscript: false)
    }

    func toggleLabel(_ label: String, on: Bool) {
        journalChange("label.\(label)", on ? .set(labels: [label]) : .set(unlabel: [label]),
                      done: on ? "Label \(label) added" : "Label \(label) removed",
                      orRun: ["set", id, on ? "--label" : "--unlabel", label], reloadTranscript: false)
    }

    /// A journal result as the confirm command's answer, for the notes and the outcome that read it.
    static func decideResult(_ result: DecisionResult) -> DecideResult {
        DecideResult(decided: result.entry?.decided ?? [], token: result.entry?.token,
                     skipped: result.skipped.map { DecideResult.Skip(id: $0.id, reason: $0.reason) })
    }

    /// A confirm or a reject of one item through the journal (the bulk bar, the keyboard on an item with no row yet).
    func decide(_ item: MeetingItem, confirm: Bool, speaker: String? = nil) {
        guard !busyItems.contains(item.id) else { return }
        busyItems.insert(item.id)
        let action: DecisionAction = confirm ? .confirm([item.id], speaker: speaker) : .reject([item.id])
        Task {
            defer { busyItems.remove(item.id) }
            do {
                let decided = try await Self.applyDecision(meeting: id, action: action, reason: nil, service: service)
                if let token = decided.entry?.token { ownTokens.insert(token) }
                let result = Self.decideResult(decided)
                let token: String?
                switch Self.decideOutcome(result, item: item.id) {
                case .decided(let undoToken):
                    token = undoToken
                case .skipped(let reason):
                    // Another window or the terminal decided it first: show why, and read what is saved now.
                    notices.push(StackedNotice(text: Self.skipNote(title: MeetingsWords.itemTitle(item), confirm: confirm, reason: reason),
                                               tone: .warning))
                    reloadRecord()
                    window?.loadOverview()
                    return
                }
                mark(item.id, status: confirm ? "confirmed" : "rejected")
                reloadRecord()
                window?.loadOverview()
                showDecided(item, confirm: confirm, token: token)
                if Self.reloadsTranscript(after: .decision) { transcriptChanged() }
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in model?.decide(item, confirm: confirm, speaker: speaker) })
            }
        }
    }

    /// The notice of one confirm or reject. With the decision's token it carries an Undo that takes back exactly that
    /// decision, and it stays the window's notice time (Settings → Meetings → Window); a second decision adds its own.
    @discardableResult
    func showDecided(_ item: MeetingItem, confirm: Bool, token: String?) -> StackedNotice.ID {
        let actions: [StackedNotice.Action] = token.map { token in
            [.undo { [weak model = self] id in model?.reopen(item, token: token, replacing: id) }]
        } ?? []
        return notices.push(StackedNotice(text: "\(confirm ? "Confirmed" : "Rejected") \(MeetingsWords.itemTitle(item))",
                                          actions: actions))
    }

    /// What one confirm or reject did to its item. `decided` carries the token an Undo needs: without one (an older
    /// CLI) `reopen` would take back whatever decision the item holds then, so no Undo is offered. `skipped` is a
    /// decision the CLI did not make, most often because another window or the terminal made it first.
    enum DecideOutcome: Equatable {
        case decided(undoToken: String?)
        case skipped(reason: String)
    }

    static func decideOutcome(_ result: DecideResult, item: String) -> DecideOutcome {
        if result.decided.contains(item) { return .decided(undoToken: result.token) }
        return .skipped(reason: result.skipped.first { $0.id == item }?.reason ?? "the command decided nothing")
    }

    /// The note for a skipped decision, in the CLI's own words.
    static func skipNote(title: String, confirm: Bool, reason: String) -> String {
        "\(title) was not \(confirm ? "confirmed" : "rejected"): \(reason)\(reason.hasSuffix(".") ? "" : ".")"
    }

    /// `reopen`'s arguments: the token names the decision this Undo takes back, so the CLI refuses it once another
    /// window or the terminal decided the item again.
    static func reopenArgs(meeting: String, item: String, token: String?) -> [String] {
        ["reopen", meeting, item] + (token.map { ["--token", $0] } ?? [])
    }

    /// The Undo of a confirm or a reject: the decision's token taken back through the journal (`decision.revert`, or
    /// `reopen --token`); without a token (an older record) `tools meetings reopen`. The result takes the place of the
    /// notice `replacing`.
    func reopen(_ item: MeetingItem, token: String?, replacing: StackedNotice.ID? = nil) {
        if let token {
            revert(token: token, items: [item.id], replacing: replacing)
            return
        }
        let key = "reopen.\(item.id)"
        guard !busy.contains(key) else {
            if let replacing { notices.release(replacing) }
            return
        }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                _ = try await MeetingsCLI.run(Self.reopenArgs(meeting: id, item: item.id, token: token))
                notices.push(StackedNotice(text: "Suggested again: \(MeetingsWords.itemTitle(item))"), replacing: replacing)
            } catch let failure as MeetingsCLI.Failure where failure.code == "item-changed" {
                notices.push(StackedNotice(text: "Not undone: this item was decided again in another window or the terminal.",
                                           more: failure.detail, tone: .error), replacing: replacing)
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in model?.reopen(item, token: token) }, replacing: replacing)
            }
            reloadRecord()
            window?.loadOverview()
            transcriptChanged()
        }
    }

    /// Moves a decided item to its new group at once; the reload that follows brings the saved record.
    func mark(_ itemID: String, status: String) {
        guard var value = record.value, let index = value.items.firstIndex(where: { $0.id == itemID }) else { return }
        value.items[index].status = status
        record = .loaded(value)
    }

    /// The name a rename field commits, or nil when it changes nothing. It compares with the saved rename, so the
    /// label's own name is a real change: it takes the rename away.
    static func renameTarget(label: String, saved: String?, typed: String) -> String? {
        let trimmed = typed.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != (saved ?? label) else { return nil }
        return trimmed
    }

    func rename(label: String, to name: String) {
        guard let trimmed = Self.renameTarget(label: label, saved: record.value?.speakers.labels[label], typed: name) else { return }
        journalChange("rename.\(label)", .rename(label, to: trimmed),
                      done: trimmed == label ? "\(label) has its own name again" : "\(label) is \(trimmed) in this meeting",
                      orRun: ["speakers", "rename", id, label, trimmed], reloadTranscript: true)
        // The speaker stats count the source's own labels, so a rename leaves them as they are. Reading them again here
        // blanked the list and dropped the next field the reader had moved to.
    }

    func addContext(paths: [String]) {
        for path in paths {
            change("context.add.\(path)", ["context", "add", id, path], done: "Added \((path as NSString).lastPathComponent)")
        }
    }

    func removeContext(_ ref: MeetingContextRef) {
        change("context.remove.\(ref.id)", ["context", "remove", id, ref.id], done: "Removed \(MeetingsWords.contextTitle(ref))",
               undo: (title: "Undo", args: Self.readdArgs(meeting: id, ref)))
    }

    /// Plays a transcript time in the window's Moment player: inside the loaded clip it seeks, else the Moment at that
    /// time (or the whole meeting, in Meeting view) takes the top of the stack. The dock names it and stops it.
    func play(at seconds: Double, from source: MomentSource = .transcript) {
        window?.player.playTime(seconds, in: id, from: source)
    }

    /// Plays a Moment target of this meeting (a row's, a time in a question, a speaker's turn), placed on the stack as
    /// its source says.
    func play(_ target: MomentTarget, from source: MomentSource) {
        window?.player.play(target, in: id, from: source)
    }

    func openInRecorder() {
        guard AppParts.isLinked("recorder") else { return }
        busy.insert("recorder")
        Task {
            defer { busy.remove("recorder") }
            do {
                let result = try await MeetingsCLI.bridge.run(subcommand: "recorder", args: ["edit", id], timeoutSeconds: 180)
                if result.exitCode != 0 {
                    notices.push(StackedNotice(text: MeetingsCLI.sentence(fromStderr: result.stderr) ?? "The recorder editor did not open.",
                                               more: result.stderr, tone: .error,
                                               actions: [.retry { [weak model = self] in model?.openInRecorder() }]))
                }
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in model?.openInRecorder() })
            }
        }
    }

    /// Writes the polished markdown into the project's folder. With no folder yet, asks for one and keeps it on the
    /// project (`projects.<p>.export.folder`), so the next export goes there at once.
    func export() {
        guard let record = record.value else { return }
        let folder = record.project.flatMap { window?.settings.value?.projects[$0]?.export?.folder }
        if folder == nil {
            guard let chosen = Self.chooseFolder(project: record.project) else { return }
            if let project = record.project {
                busy.insert("export")
                Task {
                    defer { busy.remove("export") }
                    do {
                        _ = try await MeetingsCLI.run(["config", "set", MeetingsCLI.path("projects", project, "export", "folder"),
                                                       MeetingsCLI.jsonArgument(chosen)])
                        window?.loadSettings()
                        await runExport(to: nil)
                    } catch {
                        notices.push(.meetingsFailure(error))
                    }
                }
            } else {
                Task { await runExport(to: chosen) }
            }
            return
        }
        Task { await runExport(to: nil) }
    }

    /// `ifEdited` overrides the config's choice for an edited note (Settings → Meetings → Projects → Exports).
    private func runExport(to folder: String?, ifEdited: String? = nil) async {
        busy.insert("export")
        defer { busy.remove("export") }
        do {
            let args = ["export", id, "--json"] + (folder.map { ["--to", $0] } ?? []) + (ifEdited.map { ["--if-edited", $0] } ?? [])
            let result = try await MeetingsCLI.json(ExportResult.self, args, timeoutSeconds: 120)
            let kept = result.kept.map { "\(($0 as NSString).lastPathComponent) holds edits the last export did not write, so it stays as it was." }
            let more = [kept, result.warning].compactMap { $0 }
            notices.push(StackedNotice(text: result.noticeText, detail: (result.folder as NSString).abbreviatingWithTildeInPath,
                                       more: more.isEmpty ? nil : more.joined(separator: "\n"),
                                       actions: [.init("Show", symbol: "folder", afterPress: .keep) { _ in PathOpener.reveal(result.path) }]))
            switch MeetingsPreferences.afterExport() {
            case .genesis: PathOpener.genesisMarkdown(result.path)
            case .finder: PathOpener.reveal(result.path)
            case .nothing: break
            }
        } catch let failure as MeetingsCLI.Failure where failure.code == "export-edited" {
            notices.push(StackedNotice(text: failure.sentence, more: failure.detail, tone: .error,
                                       actions: [.init("Replace", symbol: "doc.badge.arrow.up") { [weak model = self] _ in
                                           Task { await model?.runExport(to: folder, ifEdited: "replace") }
                                       }]))
        } catch {
            notices.push(.meetingsFailure(error) { [weak model = self] in Task { await model?.runExport(to: folder, ifEdited: ifEdited) } })
        }
    }

    private static func chooseFolder(project: String?) -> String? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Export Here"
        panel.message = project.map { "Choose the folder for the notes of \($0) meetings. Later exports of the project go there too." }
            ?? "Choose the folder for this meeting's note."
        guard panel.runModal() == .OK else { return nil }
        return panel.url?.path
    }
}

/// The words the window uses for the data's values, in one place, so the row, the button and the note agree.
enum MeetingsWords {
    static func itemKind(_ item: MeetingItem) -> String {
        switch item.kind {
        case "speaker-range": return "Speaker range"
        case "label": return "Mixed voices"
        case "join": return "Join lines"
        case "term": return "Word"
        case "question": return "Question"
        default: return item.kind
        }
    }

    static func itemTitle(_ item: MeetingItem) -> String {
        switch item.kind {
        case "speaker-range":
            let from = MeetingsFormat.clock(item.fromSec ?? 0), to = MeetingsFormat.clock(item.toSec ?? 0)
            let range = from == to ? "at \(from)" : "from \(from) to \(to)"
            return "\(item.label ?? "?") \(range) is \(item.speaker ?? "someone else")"
        case "label": return "\(item.label ?? "?") holds several voices"
        case "join": return "Join the line at \(MeetingsFormat.clock(item.atSec ?? 0))"
        case "term":
            if let proposed = item.proposed { return "“\(item.heard ?? "")” → “\(proposed)”" }
            if let quote = item.quote { return "“\(item.heard ?? "")” → “\(quote.text)” (from \(quote.source))" }
            return "“\(item.heard ?? "")”"
        case "question": return item.question ?? "Question"
        default: return item.id
        }
    }

    /// A typed answer as the listen door takes it, or nil when there is nothing to send.
    static func typedAnswer(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func confidence(_ value: Double?) -> String? {
        value.map { "\(Int(($0 * 100).rounded())) %" }
    }

    static func status(_ status: String) -> String {
        switch status {
        case "suggested": return "Suggested"
        case "confirmed": return "Confirmed"
        case "rejected": return "Rejected"
        default: return status
        }
    }

    static func contextTitle(_ ref: MeetingContextRef) -> String {
        if let title = ref.title, !title.isEmpty { return title }
        return ref.kind == "file" ? (ref.ref as NSString).lastPathComponent : ref.ref
    }

    static func origin(_ origin: String?) -> String? {
        switch origin {
        case "platform": return "named by the call"
        case "llm": return "named by the transcript polish"
        case "self": return "you"
        case "unknown": return "not named yet"
        case nil: return nil
        default: return origin
        }
    }

    static func pairedBy(_ source: PairedBy) -> String {
        if source.kind == "calendar" {
            let when = MeetingsFormat.date(source.start).map { $0.formatted(date: .abbreviated, time: .omitted) }
            return ["calendar entry", source.title.map { "“\($0)”" }, when].compactMap { $0 }.joined(separator: " ")
        }
        return source.note.map { "by hand: \($0)" } ?? "by hand"
    }
}

// MARK: - Bulk decide

extension MeetingDetailModel {
    /// The suggestions "confirm all at or above" decides: the CLI's own pick (`confirm --min-confidence`), less what it
    /// skips and leaves for the reader (a question, a speaker range with no speaker, a term with no spelling).
    static func confirmable(_ items: [MeetingItem], atOrAbove threshold: Double) -> [MeetingItem] {
        items.filter { item in
            item.canConfirm && (item.confidence ?? 0) >= threshold
        }
    }

    /// The note after a bulk confirm: how many, at which line, and how many wait for the reader.
    static func bulkNote(_ result: DecideResult, threshold: Double) -> String {
        let line = threshold > 0 ? " at \(MeetingsWords.confidence(threshold) ?? "") or more" : ""
        let confirmed = result.decided.isEmpty ? "Nothing to confirm\(line)" : "Confirmed \(Plural.count(result.decided.count, "item"))\(line)"
        return result.skipped.isEmpty ? confirmed : "\(confirmed); \(Plural.count(result.skipped.count, "item")) still \(result.skipped.count == 1 ? "waits" : "wait") for you"
    }

    /// Confirms every suggestion at or above `threshold` in one decision through the journal (`confirm --min-confidence`
    /// without a service), with one Undo for all of them.
    func confirmAll(atOrAbove threshold: Double) {
        let key = "confirm.all"
        guard !busy.contains(key) else { return }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                var action = DecisionAction.confirm([])
                action.minConfidence = threshold
                let decided = try await Self.applyDecision(meeting: id, action: action, reason: nil, service: service)
                if let token = decided.entry?.token { ownTokens.insert(token) }
                let result = Self.decideResult(decided)
                for itemID in result.decided { mark(itemID, status: "confirmed") }
                reloadRecord()
                window?.loadOverview()
                let undo: [StackedNotice.Action] = !result.decided.isEmpty ? result.token.map { token in
                    [.undo { [weak model = self] id in model?.reopenAll(result.decided, token: token, replacing: id) }]
                } ?? [] : []
                notices.push(StackedNotice(text: Self.bulkNote(result, threshold: threshold),
                                           more: result.skipped.isEmpty ? nil : result.skipped.map { "\($0.id): \($0.reason)" }.joined(separator: "\n"),
                                           actions: undo))
                if !result.decided.isEmpty, Self.reloadsTranscript(after: .decision) { transcriptChanged() }
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in model?.confirmAll(atOrAbove: threshold) })
            }
        }
    }

    /// `reopen`'s arguments for several items: one token took them all, so one Undo gives them all back.
    static func reopenArgs(meeting: String, items: [String], token: String?) -> [String] {
        ["reopen", meeting] + items + (token.map { ["--token", $0] } ?? [])
    }

    /// The Undo of a bulk confirm. The result takes the place of the notice `replacing`.
    func reopenAll(_ items: [String], token: String?, replacing: StackedNotice.ID? = nil) {
        let key = "reopen.all"
        guard !busy.contains(key) else {
            if let replacing { notices.release(replacing) }
            return
        }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                if let token {
                    _ = try await Self.revertDecision(meeting: id, token: token, items: items, service: service)
                } else {
                    _ = try await MeetingsCLI.run(Self.reopenArgs(meeting: id, items: items, token: nil))
                }
                notices.push(StackedNotice(text: "Suggested again: \(Plural.count(items.count, "item"))"), replacing: replacing)
            } catch let failure as MeetingsCLI.Failure where failure.code == "item-changed" {
                notices.push(StackedNotice(text: "Not undone: some of these items were decided again in another window or the terminal.",
                                           more: failure.detail, tone: .error), replacing: replacing)
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in model?.reopenAll(items, token: token) }, replacing: replacing)
            }
            reloadRecord()
            window?.loadOverview()
            transcriptChanged()
        }
    }
}

// MARK: - A meeting with no transcript source

extension MeetingDetailModel {
    /// The empty state of a pane the CLI refuses with `[no-transcript-source]`; its button opens the screen recording.
    func noTranscriptSource(_ what: String) -> NoTranscriptSource {
        let screen = window?.meeting(id)?.hasRecording ?? (record.value?.recording != nil)
        return NoTranscriptSource(what: what, showScreen: screen ? { [weak self] in self?.show(.screen) } : nil)
    }

    /// The tab a meeting opens on: its screen recording when it has nothing else, since the transcript, speakers and
    /// items all need a source with audio.
    static func firstTab(for meeting: OverviewMeeting?) -> Tab {
        guard let meeting, meeting.badges.recordingOnly || (!meeting.hasTranscript && meeting.hasRecording) else { return .transcript }
        return .screen
    }
}

// MARK: - Suggest

extension MeetingDetailModel {
    /// Runs the rules on the transcript (`tools meetings suggest`), from the Items tab's empty state.
    func suggest() {
        change("suggest", ["suggest", id], done: "The rules ran on the transcript")
    }
}

// MARK: - Context: links and notes

extension MeetingDetailModel {
    enum ContextAddition: Equatable {
        case link(String)
        case note(String)
    }

    static func contextAddArgs(meeting: String, _ addition: ContextAddition, title: String?) -> [String] {
        var args = ["context", "add", meeting]
        switch addition {
        case .link(let url): args.append(url)
        case .note(let text): args += ["--note", text]
        }
        if let title { args += ["--title", title] }
        return args
    }

    /// Adds a link or a note; `added` runs once the CLI saved it, so a composer clears its fields only then.
    func addContext(_ addition: ContextAddition, title: String?, added: @escaping () -> Void) {
        let (key, name): (String, String)
        switch addition {
        case .link(let url): (key, name) = ("context.add.link", title ?? url)
        case .note: (key, name) = ("context.add.note", title ?? "the note")
        }
        change(key, Self.contextAddArgs(meeting: id, addition, title: title), done: "Added \(name)", applied: added)
    }

    /// What adds a removed entry back, for the Undo of a remove: a note is its text, a file or a link its reference.
    static func readdArgs(meeting: String, _ ref: MeetingContextRef) -> [String] {
        var args = ["context", "add", meeting]
        if ref.kind == "note" {
            args += ["--note", ref.ref]
        } else {
            args.append(ref.ref)
            if let note = ref.note { args += ["--note", note] }
        }
        if let title = ref.title { args += ["--title", title] }
        return args
    }
}

extension MeetingsWords {
    /// The signs about one label, as sentences under it.
    static func speakerHints(_ hints: [SpeakerHint], for label: String) -> [String] {
        speakerHintLines(hints, for: label).map(\.text)
    }

    /// The signs of one label as lines, each with the stretches its chips play or show. Several silences of one label
    /// are one line with a chip each: three "Silent from … to …" sentences in a row read as a wall, and their times
    /// were plain text nobody could click.
    static func speakerHintLines(_ hints: [SpeakerHint], for label: String) -> [SpeakerHintLine] {
        let own = hints.filter { $0.label == label }
        let silences = own.filter { $0.kind == "label-drift" && $0.fromSec != nil && $0.toSec != nil }
        var lines: [SpeakerHintLine] = []
        var silenceShown = false
        for hint in own {
            let isSilence = silences.contains(hint)
            if isSilence, silenceShown { continue }
            if isSilence {
                silenceShown = true
                let ranges = silences.map { SpeakerHint.Range(lines: 0, fromSec: $0.fromSec, toSec: $0.toSec) }
                let levels: [String] = ["strong", "normal", "weak"]
                let strength = levels.first { level in silences.contains { $0.strength == level } }
                let sentence = silences.count == 1 ? hintSentence(hint)
                    : "Silent \(silences.count) times while in the call, so the voice is under other labels"
                lines.append(SpeakerHintLine(sentence: sentence, strength: strength, ranges: ranges))
            } else {
                lines.append(SpeakerHintLine(sentence: hintSentence(hint), strength: hint.strength, ranges: hint.ranges ?? []))
            }
        }
        // The strongest sign first, each weight in the engine's order: a weak note stood above the warning it sat with.
        let weight = { (line: SpeakerHintLine) in ["strong", "normal", "weak"].firstIndex(of: line.strength ?? "") ?? 3 }
        return lines.enumerated().sorted { (weight($0.element), $0.offset) < (weight($1.element), $1.offset) }.map(\.element)
    }

    /// What one sign means for the label it sits under. A kind this build does not know shows its name.
    private static func hintSentence(_ hint: SpeakerHint) -> String {
        let lines = hint.ranges?.reduce(0) { $0 + $1.lines } ?? 0
        let linesAre = "\(Plural.count(lines, "line")) \(lines == 1 ? "is" : "are")"
        switch hint.kind {
        case "several-people":
            return "May hold several people"
        case "label-drift":
            let span = hint.fromSec.flatMap { from in hint.toSec.map { " from \(MeetingsFormat.clock(from)) to \(MeetingsFormat.clock($0))" } }
            return "Silent\(span ?? "") while in the call, so the voice is under other labels"
        case "absent-speaker":
            return "Speaks while not in the call, so \(linesAre) someone else"
        case "sole-attendee":
            let you = hint.isSelf == true
            let who = you ? "you" : hint.person ?? "one person"
            return "Only \(who) \(you ? "were" : "was") in the call, so its \(linesAre) \(who)"
        case "leave-then-continues":
            return "Says goodbye and speaks again \(Plural.count(hint.leaves?.count ?? 1, "time")), so another voice may follow"
        case "split-voice":
            return "One turn next to \(hint.neighbour ?? "another label"), maybe one voice split in two"
        default:
            let words = hint.kind.replacingOccurrences(of: "-", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    /// "0:12 to 25:40": where a label speaks first and last.
    /// Facts joined by " · " that wrap only between facts. A narrow column broke "00:03 to 2:25:58" after its first time
    /// and "1 h 02 min" after "1 h", so one fact read as two.
    static func factsLine(_ facts: [String]) -> String {
        facts.map { $0.replacingOccurrences(of: " ", with: "\u{00A0}") }.joined(separator: " · ")
    }

    static func speakerSpan(_ speaker: SpeakerStat) -> String? {
        guard let first = speaker.firstSec, let last = speaker.lastSec else { return nil }
        return "\(MeetingsFormat.clock(first)) to \(MeetingsFormat.clock(last))"
    }
}

extension MeetingDetailModel {
    /// The meeting's list row arrived after it opened (a launch by its id): a meeting with only a screen recording
    /// moves to Screen, unless a request named a tab or the reader picked one.
    func listLanded(_ meeting: OverviewMeeting?) {
        guard tabIsDefault, meeting != nil else { return }
        let first = Self.firstTab(for: meeting)
        if first != tab { show(first) }
    }
}

extension MeetingsWords {
    /// The line under a context entry: a titled note's own text (its title alone hid it), or the note kept with a file
    /// or a link.
    static func contextNote(_ ref: MeetingContextRef) -> String? {
        if ref.kind == "note" { return ref.title?.isEmpty == false ? ref.ref : nil }
        return ref.note
    }
}
