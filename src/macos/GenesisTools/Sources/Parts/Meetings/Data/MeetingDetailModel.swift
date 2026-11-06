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
    var tab: Tab = .transcript
    /// The tab is the one the meeting opened on by itself, not one a request named or the reader picked.
    var tabIsDefault = false
    private(set) var record: Loadable<MeetingRecordView> = .idle
    private(set) var transcript: Loadable<MeetingTranscript> = .idle
    private(set) var timeline: Loadable<ScreenTimeline> = .idle
    private(set) var speakers: Loadable<SpeakerStats> = .idle
    private(set) var proposals: Loadable<AssignProposals> = .idle
    /// Item ids with a command in flight: their buttons wait, so a second press cannot run it twice.
    private(set) var busyItems: Set<String> = []
    private(set) var busy: Set<String> = []
    var notice: MeetingsNotice?
    private var undoTask: Task<Void, Never>?
    private var recordGeneration = 0
    private var transcriptGeneration = 0
    private var timelineGeneration = 0
    private var speakersGeneration = 0
    private var proposalsGeneration = 0
    @ObservationIgnored private var refreshGeneration = 0
    /// The read in flight per part. A new read of a part cancels the one before it, which stops its process or server
    /// call; `cancelReads()` stops them all.
    @ObservationIgnored private var inFlight: [AnyKeyPath: Task<Void, Never>] = [:]
    /// The window let this meeting go (another one opened): no read starts, and one that still lands is ignored.
    @ObservationIgnored private(set) var isDropped = false
    /// Opened before the list showed the meeting: whether proposals read waits for its record.
    @ObservationIgnored private var proposalsAwaitRecord = false
    /// The first tab read waits for the list (`firstReadWaitsForList`).
    @ObservationIgnored private var tabAwaitsList = false

    /// A part of the pane with a `meetings revisions` token.
    enum RevisionPart: Hashable { case record, transcript, speakers, timeline }
    /// The token each part was read at. A return to the window reads a part again only when its token changed; a part
    /// read without one (the first open) reads on the first return and keeps a token from then on.
    @ObservationIgnored private var readAt: [RevisionPart: String] = [:]

    init(id: String, window: MeetingsWindowModel?) {
        self.id = id
        self.window = window
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
        case .transcript: if case .idle = transcript { loadTranscript() }
        case .screen: if case .idle = timeline { loadTimeline() }
        case .speakers: if case .idle = speakers { loadSpeakers() }
        case .items, .context: break
        }
    }

    func reloadRecord() { readRecord(quiet: false) }
    func loadTranscript() { readTranscript(quiet: false) }
    func loadTimeline() { readTimeline(quiet: false) }
    func loadSpeakers() { readSpeakers(quiet: false) }
    func loadProposals() { readProposals(quiet: false) }

    private func readRecord(quiet: Bool) {
        read(\.record, generation: \.recordGeneration, ["show", id, "--json"], quiet: quiet, revision: .record) { [weak self] record in
            self?.recordLanded(record)
        }
    }

    private func readTranscript(quiet: Bool) {
        read(\.transcript, generation: \.transcriptGeneration, ["transcript", id, "--format", "json"], timeoutSeconds: 120,
             quiet: quiet, revision: .transcript)
    }

    private func readTimeline(quiet: Bool) {
        let all = MeetingsPreferences.timelineLines() == .all
        read(\.timeline, generation: \.timelineGeneration, ["screen", id, "--timeline", "--json"] + (all ? ["--all"] : []),
             timeoutSeconds: 120, quiet: quiet, revision: .timeline)
    }

    private func readSpeakers(quiet: Bool) {
        read(\.speakers, generation: \.speakersGeneration, ["speakers", "stats", id, "--json"], timeoutSeconds: 120,
             quiet: quiet, revision: .speakers)
    }

    private func readProposals(quiet: Bool) {
        read(\.proposals, generation: \.proposalsGeneration, ["assign", "proposals", id, "--json"], quiet: quiet)
    }

    /// One read of a part. A `quiet` read (a refresh) keeps what the pane shows until the answer lands, and an answer
    /// equal to the shown one is not set again, so an unchanged pane redraws nothing. A failed read forgets the part's
    /// revision token, so the next return reads it again.
    private func read<Value: Decodable & Equatable>(
        _ part: ReferenceWritableKeyPath<MeetingDetailModel, Loadable<Value>>,
        generation: ReferenceWritableKeyPath<MeetingDetailModel, Int>,
        _ args: [String], timeoutSeconds: Int = 60, quiet: Bool, revision: RevisionPart? = nil,
        then landed: ((Value) -> Void)? = nil
    ) {
        guard !isDropped else { return }
        self[keyPath: generation] += 1
        let current = self[keyPath: generation]
        if !quiet { self[keyPath: part] = .loading(previous: self[keyPath: part].value) }
        inFlight[part]?.cancel()
        inFlight[part] = Task { [weak self] in
            do {
                let value = try await MeetingsCLI.json(Value.self, args, timeoutSeconds: timeoutSeconds)
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

    /// Sets a part only when it changes: `@Observable` redraws every view that reads a property on each set, equal or not.
    private func settle<Value: Equatable>(_ part: ReferenceWritableKeyPath<MeetingDetailModel, Loadable<Value>>, _ new: Loadable<Value>) {
        if self[keyPath: part] != new { self[keyPath: part] = new }
    }

    /// The window let this meeting go: every read in flight stops (its process ends, the server drops its call), and
    /// none starts again.
    func cancelReads() {
        isDropped = true
        for task in inFlight.values { task.cancel() }
        inFlight.removeAll()
    }

    // MARK: - Actions

    /// Runs one change; on success reads the record (and the window's list) again and shows `done`.
    private func change(_ key: String, _ args: [String], done: String?, reloadTranscript: Bool = false,
                        undo: (title: String, args: [String])? = nil, applied: (() -> Void)? = nil) {
        guard !busy.contains(key) else { return }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                _ = try await MeetingsCLI.run(args, timeoutSeconds: 120)
                applied?()
                reloadRecord()
                window?.loadOverview()
                if reloadTranscript { loadTranscript() }
                if let done {
                    var note = MeetingsNotice(text: done, tone: .success)
                    if let undo {
                        note.actionTitle = undo.title
                        note.actionSymbol = "arrow.uturn.backward"
                        note.action = { [weak model = self] in model?.change(key + ".undo", undo.args, done: "Undone", reloadTranscript: reloadTranscript) }
                    }
                    notice = note
                }
            } catch {
                notice = .failure(error) { [weak model = self] in
                    model?.change(key, args, done: done, reloadTranscript: reloadTranscript, undo: undo, applied: applied)
                }
            }
        }
    }

    func isBusy(_ key: String) -> Bool { busy.contains(key) }

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
            change("project", ["set", id, "--project", project], done: "Project set to \(project)", reloadTranscript: reload)
        } else {
            change("project", ["assign", "apply", id, "--none"], done: "No project for this meeting", reloadTranscript: reload)
        }
    }

    /// The window came back: a part already read reads again only when `meetings revisions` says what it reads changed
    /// (a correction or a confirm in the terminal, a new frame), and quietly. Proposals already read read again each
    /// time: they depend on the Calendar, which has no revision. Without revisions (an older CLI, a failed read) every
    /// part read before reads again, as before.
    /// `force` (the menu's Reload): every part read before reads again, whatever its token says, so a Reload repairs
    /// what a revision missed.
    func refreshLoaded(force: Bool = false) {
        guard !isDropped else { return }
        refreshGeneration += 1
        let generation = refreshGeneration
        let id = id
        let key: AnyKeyPath = \MeetingDetailModel.refreshGeneration
        inFlight[key]?.cancel()
        inFlight[key] = Task { [weak self] in
            let revisions = try? await MeetingsCLI.json(MeetingRevisions.self, ["revisions", id, "--json"])
            guard let self, !Task.isCancelled, !self.isDropped, generation == self.refreshGeneration else { return }
            if self.mustRead(.record, revisions?.show) || force { self.readRecord(quiet: true) }
            if self.transcript != .idle, self.mustRead(.transcript, revisions?.transcript) || force { self.readTranscript(quiet: true) }
            if self.speakers != .idle, self.mustRead(.speakers, revisions?.speakers) || force { self.readSpeakers(quiet: true) }
            if self.timeline != .idle, self.mustRead(.timeline, revisions?.timeline) || force { self.readTimeline(quiet: true) }
            if self.proposals != .idle { self.readProposals(quiet: true) }
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

    func toggleLabel(_ label: String, on: Bool) {
        change("label.\(label)", ["set", id, on ? "--label" : "--unlabel", label], done: on ? "Label \(label) added" : "Label \(label) removed")
    }

    func decide(_ item: MeetingItem, confirm: Bool, speaker: String? = nil) {
        guard !busyItems.contains(item.id) else { return }
        busyItems.insert(item.id)
        var args = [confirm ? "confirm" : "reject", id, item.id, "--json"]
        if let speaker { args += ["--speaker", speaker] }
        Task {
            defer { busyItems.remove(item.id) }
            do {
                let result = try await MeetingsCLI.json(DecideResult.self, args)
                mark(item.id, status: confirm ? "confirmed" : "rejected")
                reloadRecord()
                window?.loadOverview()
                var note = MeetingsNotice(text: "\(confirm ? "Confirmed" : "Rejected") \(MeetingsWords.itemTitle(item))", tone: .success)
                note.actionTitle = "Undo"
                note.actionSymbol = "arrow.uturn.backward"
                note.action = { [weak model = self] in model?.reopen(item, token: result.token) }
                notice = note
                scheduleUndoExpiry(for: note.id)
                if Self.reloadsTranscript(after: .decision) { transcript = .idle; if tab == .transcript { loadTranscript() } }
            } catch {
                notice = .failure(error) { [weak model = self] in model?.decide(item, confirm: confirm, speaker: speaker) }
            }
        }
    }

    /// `reopen`'s arguments: the token names the decision this Undo takes back, so the CLI refuses it once another
    /// window or the terminal decided the item again.
    static func reopenArgs(meeting: String, item: String, token: String?) -> [String] {
        ["reopen", meeting, item] + (token.map { ["--token", $0] } ?? [])
    }

    /// The Undo of a confirm or a reject: `tools meetings reopen`.
    func reopen(_ item: MeetingItem, token: String?) {
        let key = "reopen.\(item.id)"
        guard !busy.contains(key) else { return }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                _ = try await MeetingsCLI.run(Self.reopenArgs(meeting: id, item: item.id, token: token))
                notice = MeetingsNotice(text: "Suggested again: \(MeetingsWords.itemTitle(item))", tone: .success)
            } catch let failure as MeetingsCLI.Failure where failure.code == "item-changed" {
                notice = MeetingsNotice(text: "Not undone: this item was decided again in another window or the terminal.",
                                        more: failure.detail, tone: .error)
            } catch {
                notice = .failure(error) { [weak model = self] in model?.reopen(item, token: token) }
            }
            reloadRecord()
            window?.loadOverview()
            transcript = .idle
            if tab == .transcript { loadTranscript() }
        }
    }

    /// Moves a decided item to its new group at once; the reload that follows brings the saved record.
    private func mark(_ itemID: String, status: String) {
        guard var value = record.value, let index = value.items.firstIndex(where: { $0.id == itemID }) else { return }
        value.items[index].status = status
        record = .loaded(value)
    }

    /// The Undo button stays for the window's setting (Settings → Meetings → Window), then the note goes.
    private func scheduleUndoExpiry(for noteID: UUID) {
        undoTask?.cancel()
        let seconds = MeetingsPreferences.undoSeconds()
        undoTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let self, self.notice?.id == noteID else { return }
            self.notice = nil
        }
    }

    /// Answers an open question without listening: the same as `listen --item <id> --answer <choice>`.
    func answer(_ item: MeetingItem, with choice: String) {
        change("answer.\(item.id)", ["listen", id, "--item", item.id, "--answer", choice], done: "Answered: \(choice)", reloadTranscript: true)
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
        change("rename.\(label)", ["speakers", "rename", id, label, trimmed],
               done: trimmed == label ? "\(label) has its own name again" : "\(label) is \(trimmed) in this meeting",
               reloadTranscript: true)
        speakers = .idle
        if tab == .speakers { loadSpeakers() }
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

    /// Plays the meeting's audio from a transcript time in the player that Settings → Meetings → Window picks; the bar
    /// under the window shows where it is and stops it.
    func play(at seconds: Double) {
        window?.playback.play(meeting: id, at: seconds, player: MeetingsPreferences.player().cliPlayer)
    }

    func openInRecorder() {
        guard AppParts.isLinked("recorder") else { return }
        busy.insert("recorder")
        Task {
            defer { busy.remove("recorder") }
            do {
                let result = try await MeetingsCLI.bridge.run(subcommand: "recorder", args: ["edit", id], timeoutSeconds: 180)
                if result.exitCode != 0 {
                    notice = MeetingsNotice(text: MeetingsCLI.sentence(fromStderr: result.stderr) ?? "The recorder editor did not open.",
                                            more: result.stderr, tone: .error, actionTitle: "Retry") { [weak model = self] in model?.openInRecorder() }
                }
            } catch {
                notice = .failure(error) { [weak model = self] in model?.openInRecorder() }
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
                        notice = .failure(error)
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
            var note = MeetingsNotice(text: result.noticeText, detail: (result.folder as NSString).abbreviatingWithTildeInPath, tone: .success)
            let kept = result.kept.map { "\(($0 as NSString).lastPathComponent) holds edits the last export did not write, so it stays as it was." }
            let more = [kept, result.warning].compactMap { $0 }
            if !more.isEmpty { note.more = more.joined(separator: "\n") }
            note.actionTitle = "Show"
            note.actionSymbol = "folder"
            note.action = { PathOpener.reveal(result.path) }
            notice = note
            switch MeetingsPreferences.afterExport() {
            case .genesis: PathOpener.genesisMarkdown(result.path)
            case .finder: PathOpener.reveal(result.path)
            case .nothing: break
            }
        } catch let failure as MeetingsCLI.Failure where failure.code == "export-edited" {
            notice = MeetingsNotice(text: failure.sentence, more: failure.detail, tone: .error, actionTitle: "Replace",
                                    actionSymbol: "doc.badge.arrow.up") { [weak model = self] in
                Task { await model?.runExport(to: folder, ifEdited: "replace") }
            }
        } catch {
            notice = .failure(error) { [weak model = self] in Task { await model?.runExport(to: folder, ifEdited: ifEdited) } }
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
            item.status == "suggested" && item.kind != "question" && (item.confidence ?? 0) >= threshold
                && !(item.kind == "speaker-range" && item.speaker == nil) && !item.needsSpelling
        }
    }

    /// The note after a bulk confirm: how many, at which line, and how many wait for the reader.
    static func bulkNote(_ result: DecideResult, threshold: Double) -> String {
        let line = threshold > 0 ? " at \(MeetingsWords.confidence(threshold) ?? "") or more" : ""
        let confirmed = result.decided.isEmpty ? "Nothing to confirm\(line)" : "Confirmed \(Plural.count(result.decided.count, "item"))\(line)"
        return result.skipped.isEmpty ? confirmed : "\(confirmed); \(Plural.count(result.skipped.count, "item")) still \(result.skipped.count == 1 ? "waits" : "wait") for you"
    }

    /// Confirms every suggestion at or above `threshold` in one `tools meetings confirm --min-confidence`, with one Undo
    /// for all of them.
    func confirmAll(atOrAbove threshold: Double) {
        let key = "confirm.all"
        guard !busy.contains(key) else { return }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                let result = try await MeetingsCLI.json(
                    DecideResult.self, ["confirm", id, "--min-confidence", String(threshold), "--json"], timeoutSeconds: 120)
                for itemID in result.decided { mark(itemID, status: "confirmed") }
                reloadRecord()
                window?.loadOverview()
                var note = MeetingsNotice(text: Self.bulkNote(result, threshold: threshold), tone: .success)
                note.more = result.skipped.isEmpty ? nil : result.skipped.map { "\($0.id): \($0.reason)" }.joined(separator: "\n")
                if !result.decided.isEmpty {
                    note.actionTitle = "Undo"
                    note.actionSymbol = "arrow.uturn.backward"
                    note.action = { [weak model = self] in model?.reopenAll(result.decided, token: result.token) }
                }
                notice = note
                scheduleUndoExpiry(for: note.id)
                if !result.decided.isEmpty, Self.reloadsTranscript(after: .decision) {
                    transcript = .idle
                    if tab == .transcript { loadTranscript() }
                }
            } catch {
                notice = .failure(error) { [weak model = self] in model?.confirmAll(atOrAbove: threshold) }
            }
        }
    }

    /// `reopen`'s arguments for several items: one token took them all, so one Undo gives them all back.
    static func reopenArgs(meeting: String, items: [String], token: String?) -> [String] {
        ["reopen", meeting] + items + (token.map { ["--token", $0] } ?? [])
    }

    /// The Undo of a bulk confirm.
    func reopenAll(_ items: [String], token: String?) {
        let key = "reopen.all"
        guard !busy.contains(key) else { return }
        busy.insert(key)
        Task {
            defer { busy.remove(key) }
            do {
                _ = try await MeetingsCLI.run(Self.reopenArgs(meeting: id, items: items, token: token))
                notice = MeetingsNotice(text: "Suggested again: \(Plural.count(items.count, "item"))", tone: .success)
            } catch let failure as MeetingsCLI.Failure where failure.code == "item-changed" {
                notice = MeetingsNotice(text: "Not undone: some of these items were decided again in another window or the terminal.",
                                        more: failure.detail, tone: .error)
            } catch {
                notice = .failure(error) { [weak model = self] in model?.reopenAll(items, token: token) }
            }
            reloadRecord()
            window?.loadOverview()
            transcript = .idle
            if tab == .transcript { loadTranscript() }
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
        hints.filter { $0.label == label }.map { hint in
            let strength = hint.strength.map { " (\($0) sign)" } ?? ""
            switch hint.kind {
            case "several-people": return "May hold several people\(strength)"
            case "label-drift": return "May switch to another person partway\(strength)"
            default: return hint.kind.replacingOccurrences(of: "-", with: " ").capitalized + strength
            }
        }
    }

    /// "0:12 to 25:40": where a label speaks first and last.
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
