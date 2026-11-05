import AppKit
import Foundation
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

    init(id: String, window: MeetingsWindowModel?) {
        self.id = id
        self.window = window
    }

    func load() {
        reloadRecord()
        loadProposals()
        loadTab(tab)
    }

    func show(_ tab: Tab) {
        self.tab = tab
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

    func reloadRecord() {
        record = .loading(previous: record.value)
        Task {
            do {
                record = .loaded(try await MeetingsCLI.json(MeetingRecordView.self, ["show", id, "--json"]))
            } catch {
                record = .failed(asFailure(error), previous: record.value)
            }
        }
    }

    func loadTranscript() {
        transcript = .loading(previous: transcript.value)
        Task {
            do {
                transcript = .loaded(try await MeetingsCLI.json(MeetingTranscript.self, ["transcript", id, "--format", "json"], timeoutSeconds: 120))
            } catch {
                transcript = .failed(asFailure(error), previous: transcript.value)
            }
        }
    }

    func loadTimeline() {
        timeline = .loading(previous: timeline.value)
        let all = MeetingsPreferences.timelineLines() == .all
        Task {
            do {
                timeline = .loaded(try await MeetingsCLI.json(
                    ScreenTimeline.self, ["screen", id, "--timeline", "--json"] + (all ? ["--all"] : []), timeoutSeconds: 120))
            } catch {
                timeline = .failed(asFailure(error), previous: timeline.value)
            }
        }
    }

    func loadSpeakers() {
        speakers = .loading(previous: speakers.value)
        Task {
            do {
                speakers = .loaded(try await MeetingsCLI.json(SpeakerStats.self, ["speakers", "stats", id, "--json"], timeoutSeconds: 120))
            } catch {
                speakers = .failed(asFailure(error), previous: speakers.value)
            }
        }
    }

    func loadProposals() {
        proposals = .loading(previous: proposals.value)
        Task {
            do {
                proposals = .loaded(try await MeetingsCLI.json(AssignProposals.self, ["assign", "proposals", id, "--json"]))
            } catch {
                proposals = .failed(asFailure(error), previous: proposals.value)
            }
        }
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

    /// The window came back: what a terminal changed since (a correction, a dictionary entry, a rename) shows in every
    /// tab already read; a tab not read yet reads when it shows.
    func refreshLoaded() {
        reloadRecord()
        loadProposals()
        if transcript != .idle { loadTranscript() }
        if speakers != .idle { loadSpeakers() }
        if timeline != .idle { loadTimeline() }
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

    func rename(label: String, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != label else { return }
        change("rename.\(label)", ["speakers", "rename", id, label, trimmed], done: "\(label) is \(trimmed) in this meeting",
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
        change("context.remove.\(ref.id)", ["context", "remove", id, ref.id], done: "Removed \(MeetingsWords.contextTitle(ref))")
    }

    /// Plays the meeting's audio from a transcript time in the meetings player (VLC, else ffplay).
    func play(at seconds: Double) {
        change("play", ["play", id, "--at", String(Int(seconds.rounded(.down)))], done: nil)
    }

    func openInRecorder() {
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
            let range = "\(MeetingsFormat.clock(item.fromSec ?? 0))–\(MeetingsFormat.clock(item.toSec ?? 0))"
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
