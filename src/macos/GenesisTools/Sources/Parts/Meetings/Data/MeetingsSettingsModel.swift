import AppKit
import Foundation
import Observation

/// One project's match rules as a person edits them: the preview reads them at once, and Save writes them.
struct MatchRulesDraft: Equatable {
    var folders: [String]
    var calendars: [String]
    var titleWords: [String]

    var json: [String: Any] {
        ["folders": ["wisprflow": folders], "calendars": calendars, "titleWords": titleWords]
    }
}

/// The Settings → Meetings pages: the meetings config (read with `config.read` and written with `config.set` and
/// `config.unset` through the Meetings service, or `config show`, `config set` and `config unset` when no service
/// answers; library reads and writes use the same typed service with a command compatibility fallback), the cost of each capture
/// choice, the match preview and the phrase test.
@Observable
@MainActor
final class MeetingsSettingsModel {
    private(set) var settings: Loadable<MeetingsSettings> = .idle
    /// The settings as JSON from the same read, so each write names the value it replaces.
    private(set) var settingsRaw: JSONValue?
    private(set) var cost: Loadable<CaptureCost> = .idle
    internal(set) var preview: Loadable<[MatchPreviewRow]> = .idle
    private(set) var dictionary: Loadable<DictionaryShow> = .idle
    private(set) var phraseResult: PhraseTest?
    /// Per project, the people of its meetings not paired with it yet (`projects.meetingPeople`); read when its card
    /// shows its people, and again after each settings read, keeping the rows on screen meanwhile.
    var meetingPeople: [String: Loadable<[MeetingsAPI.ProjectsMeetingPeople.Person]>] = [:]
    /// Paths with a write in flight, so their control waits and a second change does not race the first.
    internal(set) var writing: Set<String> = []
    /// The newest value asked for a path while its write before it still runs; it is written when that one ends.
    @ObservationIgnored private var queuedSets: [String: (path: [String], value: Any, done: String?)] = [:]
    var drafts: [String: MatchRulesDraft] = [:]
    /// The notices of the pages' actions, floating over the visible page.
    @ObservationIgnored let notices: NoticeStackModel
    /// The phrase test runs as the reader types: its failure replaces the one before instead of piling up.
    @ObservationIgnored private let phraseFailureID = StackedNotice.ID()
    /// The dictionary page's scope: nil is the global dictionary.
    var dictionaryScope: String? {
        didSet { if oldValue != dictionaryScope { loadDictionary(); testPhrase(phrase) } }
    }
    var phrase = ""
    /// False in a snapshot: nothing is written.
    let writes: Bool
    /// The Meetings service the config reads and writes go through; nil runs them as commands (XCTest, the preview).
    @ObservationIgnored let service: MeetingsService?
    /// A test can deny command execution without touching the real settings or starting a child process.
    @ObservationIgnored private let command: (([String]) async throws -> Data)?
    private var previewTask: Task<Void, Never>?
    private var phraseTask: Task<Void, Never>?
    /// The one read of the values the rule fields offer, shared by every field of every project; Settings opened
    /// again reads it again.
    @ObservationIgnored var suggestionsTask: Task<MeetingsAPI.ProjectsSuggestions.Result, Error>?

    /// `service` nil is the shared one (`MeetingsService.shared`, itself nil under XCTest and in the preview).
    init(writes: Bool = true, notices: NoticeStackModel? = nil, service: MeetingsService? = nil,
         command: (([String]) async throws -> Data)? = nil) {
        self.writes = writes
        self.service = service ?? MeetingsService.shared
        self.command = command
        self.notices = notices ?? MeetingsPreferences.makeNoticeStack()
    }

    /// Every read has ended, with data or with its error (a snapshot waits for this).
    var settled: Bool {
        !settings.isLoading && settings != .idle && !cost.isLoading && cost != .idle && !preview.isLoading && preview != .idle
    }

    /// The reads beside the settings that a page shows, so each page starts only its own.
    struct Reads: OptionSet {
        let rawValue: Int
        static let cost = Reads(rawValue: 1)
        static let preview = Reads(rawValue: 2)
        static let dictionary = Reads(rawValue: 4)
        static let all: Reads = [.cost, .preview, .dictionary]
    }

    /// The settings and `reads`; a snapshot reads all of them and waits for them.
    func load(_ reads: Reads = .all) {
        loadSettings()
        if reads.contains(.cost) { loadCost() }
        if reads.contains(.preview) { loadPreview() }
        if reads.contains(.dictionary) { loadDictionary() }
    }

    /// A page showed: the settings and the page's own reads, each the first time only.
    func ensure(_ reads: Reads) {
        if settings == .idle { loadSettings() }
        if reads.contains(.cost), cost == .idle { loadCost() }
        if reads.contains(.preview), preview == .idle { loadPreview() }
        if reads.contains(.dictionary), dictionary == .idle { loadDictionary() }
    }

    /// Settings opened again: each read a page already made reads again; the others wait for their page.
    func reloadRead() {
        var reads: Reads = []
        if cost != .idle { reads.insert(.cost) }
        if preview != .idle { reads.insert(.preview) }
        if dictionary != .idle { reads.insert(.dictionary) }
        suggestionsTask = nil
        if settings != .idle || !reads.isEmpty { load(reads) }
    }

    func loadSettings() {
        settings = .loading(previous: settings.value)
        Task {
            do {
                let shown = try await MeetingsWindowModel.settingsRead.run(service: service, command: { [self] args, _ in
                    try await readCommand(ConfigShow.self, args)
                })
                let value = shown.value
                let previous = settings.value
                let dirty = Set(drafts.keys.filter { name in
                    guard let previous else { return true }
                    return drafts[name] != savedRules(name, in: previous)
                })
                settingsRaw = shown.raw
                settings = .loaded(value)
                for name in value.projectNames where !dirty.contains(name) {
                    drafts[name] = savedRules(name, in: value)
                }
                // A pairing made anywhere (here, the terminal, an answered question) changes who is left to pair.
                for name in meetingPeople.keys { loadMeetingPeople(name) }
            } catch {
                settings = .failed(asFailure(error), previous: settings.value)
            }
        }
    }

    func loadCost() {
        cost = .loading(previous: cost.value)
        Task {
            do {
                cost = .loaded(try await readCommand(CaptureCost.self, ["record", "cost", "--json"]))
            } catch {
                cost = .failed(asFailure(error), previous: cost.value)
            }
        }
    }

    /// The last 20 meetings against the saved rules and the drafts; each edit asks again after a short pause.
    func loadPreview(after delay: Duration = .zero) {
        previewTask?.cancel()
        let draft = changedDrafts()
        previewTask = Task {
            if delay > .zero {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled else { return }
            }
            preview = .loading(previous: preview.value)
            var args = ["projects", "preview", "--json"]
            if !draft.isEmpty { args += ["--draft", MeetingsCLI.jsonArgument(draft)] }
            do {
                let params = try MeetingsService.decode(MeetingsAPI.ProjectsPreview.Params.self,
                                                        draft.isEmpty ? [:] : ["draft": draft])
                let rows = try await readLibrary(MeetingsAPI.ProjectsPreview.self, params, orRun: args)
                guard !Task.isCancelled else { return }
                preview = .loaded(rows)
            } catch {
                guard !Task.isCancelled else { return }
                preview = .failed(asFailure(error), previous: preview.value)
            }
        }
    }

    func loadDictionary() {
        dictionary = .loading(previous: dictionary.value)
        let scope = dictionaryScope
        Task {
            do {
                let value = try await readLibrary(MeetingsAPI.DictionaryShowEntries.self, .init(project: scope),
                                                  orRun: ["dictionary", "show", "--json"] + (scope.map { ["--project", $0] } ?? []))
                guard scope == dictionaryScope else { return }
                dictionary = .loaded(value)
            } catch {
                dictionary = .failed(asFailure(error), previous: dictionary.value)
            }
        }
    }

    // MARK: Writes

    /// One `config edit` change: the new value (nil unsets the key) and the value this page read there.
    static func editJSON(_ path: [String], _ value: Any?, in raw: JSONValue?) -> [String: Any] {
        var edit: [String: Any] = ["path": MeetingsCLI.jsonArgument(path)]
        if let value { edit["value"] = value } else { edit["unset"] = true }
        if let raw { edit["expect"] = raw.at(path).foundation }
        return edit
    }

    /// Writes one config value (`config.set`, or `config set`) and reads the settings again. A refused value shows the
    /// schema's sentence; the control goes back to the saved value with the reload.
    ///
    /// A value set while the write before it of the same path still runs is kept, the newest one only, and written
    /// when that write ends: it then names the saved value as the one it replaces. Dropped, the second of two quick
    /// steps of a number field was lost.
    func set(_ path: [String], _ value: Any, done: String? = nil) {
        let key = path.joined(separator: ".")
        guard writes else { return }
        guard !writing.contains(key) else {
            queuedSets[key] = (path, value, done)
            return
        }
        run(key: key, .config(.set(path, JSONValue(foundation: value), readFrom: settingsRaw)),
            done: done, saved: { $0.settingsRaw = $0.settingsRaw?.setting(path, to: JSONValue(foundation: value)) }) {
            if let next = $0.queuedSets.removeValue(forKey: key) {
                // Its own end reads the settings again.
                $0.set(next.path, next.value, done: next.done)
                return
            }
            $0.loadSettings()
            if path.first == "global", path.dropFirst().first == "capture" { $0.loadCost() }
        }
    }

    /// Puts one config value back to its default (`config.unset`, or `config unset`) and reads the settings again.
    func unset(_ path: [String], done: String? = nil) {
        run(key: path.joined(separator: "."), .config(.unset(path, readFrom: settingsRaw)), done: done) { $0.loadSettings() }
    }

    /// The Window page's tone Play button (`tone.preview`).
    func previewTone(_ sound: MeetingsAPI.ToneSoundSetting) {
        Task {
            do {
                if let message = try await TonePreviewPlayer.play(sound, service: service) {
                    notices.push(StackedNotice(text: message))
                }
            } catch is MeetingsService.Unavailable {
                notices.push(StackedNotice(text: TonePreviewPlayer.unavailableText))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.previewTone(sound) })
            }
        }
    }

    func setAutostart(_ on: Bool) {
        run(key: "autostart", ["autostart", on ? "on" : "off"], done: on ? "Meetings are recorded with Wispr Flow" : "Autostart is off") {
            $0.loadSettings()
        }
    }

    func addProject(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        run(key: "project.add", MeetingsAPI.ProjectsAdd.self, .init(name: trimmed),
            orRun: ["projects", "add", trimmed], done: "Added the project \(trimmed)") { $0.loadSettings() }
    }

    func changeLabels(_ project: String, add: [String] = [], remove: [String] = []) {
        var args = ["projects", "labels", project]
        if !add.isEmpty { args += ["--add"] + add }
        if !remove.isEmpty { args += ["--remove"] + remove }
        run(key: "labels.\(project)", MeetingsAPI.ProjectsLabels.self,
            .init(project: project, add: add.isEmpty ? nil : add, remove: remove.isEmpty ? nil : remove),
            orRun: args, done: nil) { $0.loadSettings() }
    }

    func unpair(entry: String, title: String, preview: UnpairPreview) {
        run(key: "unpair.\(entry)", MeetingsAPI.ProjectsUnpair.self, .init(entry: entry),
            orRun: ["projects", "unpair", "--entry", entry],
            done: "Removed what \(title) paired: \(preview.words)") { $0.loadSettings() }
    }

    func unpair(person: PairedPerson, from project: String) {
        run(key: "unpair.\(project).\(person.id)", MeetingsAPI.ProjectsUnpair.self,
            .init(project: project, person: .init(name: person.name, email: person.email)),
            orRun: ["projects", "unpair", project, "--person", person.email ?? person.name],
            done: "\(person.name) is no longer paired with \(project)") { $0.loadSettings() }
    }

    func chooseExportFolder(_ project: String) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Use"
        panel.message = "Choose the folder for the notes of \(project) meetings"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        set(["projects", project, "export", "folder"], url.path, done: "Exports of \(project) go to \(url.lastPathComponent)")
    }

    func clearExportFolder(_ project: String) {
        run(key: "projects.\(project).export", .config(.unset(["projects", project, "export"], readFrom: settingsRaw)),
            done: "\(project) exports ask for a folder again") { $0.loadSettings() }
    }

    /// The `config edit` changes of a project's draft rules: only the lists that changed, each naming the saved list it
    /// replaces, so they land together or not at all.
    static func ruleEdits(_ project: String, draft: MatchRulesDraft, saved: MatchRulesDraft, raw: JSONValue?) -> [[String: Any]] {
        var edits: [[String: Any]] = []
        if draft.folders != saved.folders {
            edits.append(editJSON(["sources", "wisprflow", "match", project, "folders"], draft.folders, in: raw))
        }
        if draft.calendars != saved.calendars {
            edits.append(editJSON(["projects", project, "match", "calendar", "calendars"], draft.calendars, in: raw))
        }
        if draft.titleWords != saved.titleWords {
            edits.append(editJSON(["projects", project, "match", "title", "words"], draft.titleWords, in: raw))
        }
        return edits
    }

    /// Writes the draft rules of one project in one `config edit`, then previews against the saved rules.
    func saveRules(_ project: String) {
        guard let draft = drafts[project], let settings = settings.value else { return }
        let edits = Self.ruleEdits(project, draft: draft, saved: savedRules(project, in: settings), raw: settingsRaw)
        guard edits.isEmpty == false, self.writes else { return }
        writing.insert("rules.\(project)")
        Task {
            defer { writing.remove("rules.\(project)") }
            do {
                let params = try MeetingsService.decode(MeetingsAPI.ConfigEdit.Params.self, ["edits": edits])
                _ = try await writeLibrary(MeetingsAPI.ConfigEdit.self, params,
                                           orRun: ["config", "edit", MeetingsCLI.jsonArgument(edits)])
                notices.push(StackedNotice(text: "Saved the \(project) rules"))
            } catch let failure as MeetingsCLI.Failure where failure.code == "config-stale" {
                // The draft stays: the reload brings the other editor's rules into the saved side to compare with.
                notices.push(Self.staleNotice(failure))
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in model?.saveRules(project) })
            }
            loadSettings()
            loadPreview()
        }
    }

    func discardRules(_ project: String) {
        guard let settings = settings.value else { return }
        drafts[project] = savedRules(project, in: settings)
        loadPreview()
    }

    func editDraft(_ project: String, _ change: (inout MatchRulesDraft) -> Void) {
        guard var draft = drafts[project] else { return }
        change(&draft)
        drafts[project] = draft
        loadPreview(after: .milliseconds(400))
    }

    func hasUnsavedRules(_ project: String) -> Bool {
        guard let settings = settings.value, let draft = drafts[project] else { return false }
        return draft != savedRules(project, in: settings)
    }

    func savedRules(_ project: String, in settings: MeetingsSettings) -> MatchRulesDraft {
        let config = settings.projects[project]
        return MatchRulesDraft(folders: settings.wispr?.match[project]?.folders ?? [],
                               calendars: config?.match?.calendar?.calendars ?? [],
                               titleWords: config?.match?.title?.words ?? [])
    }

    private func changedDrafts() -> [String: Any] {
        guard let settings = settings.value else { return [:] }
        let sent = Self.previewDrafts(drafts, exists: { settings.projects[$0] != nil }, saved: { savedRules($0, in: settings) })
        var out: [String: Any] = [:]
        for (name, draft) in sent { out[name] = draft.json }
        return out
    }

    /// The drafts a preview sends: changed ones of projects that still exist. A draft of a project renamed or removed
    /// since stays in the model (its edits are not lost) but would preview a match for a name the config no longer has.
    static func previewDrafts(_ drafts: [String: MatchRulesDraft], exists: (String) -> Bool,
                              saved: (String) -> MatchRulesDraft) -> [String: MatchRulesDraft] {
        drafts.filter { name, draft in exists(name) && draft != saved(name) }
    }

    // MARK: Dictionary

    /// `dictionary add`'s arguments. `replacing` is the value of the entry a rename replaces: the CLI swaps both in one
    /// write, so a refused entry keeps the old one.
    /// The CLI's add replaces the whole entry, so every field the entry keeps is passed: spoken forms, the meaning, and
    /// a fix's letter case.
    static func addEntryArgs(type: String, value: String, substitution: String?, spoken: [String] = [], meaning: String? = nil,
                             caseSensitive: Bool = false, scope: String?, replacing: String? = nil,
                             ifAbsent: Bool = false) -> [String] {
        var args = ["dictionary", "add", value]
        if let substitution, !substitution.isEmpty { args.append(substitution) }
        args += ["--type", type]
        if let scope { args += ["--project", scope] }
        if type == "term" {
            for form in spoken { args += ["--spoken", form] }
            if let meaning, !meaning.isEmpty { args += ["--meaning", meaning] }
        }
        if type == "fix", caseSensitive { args.append("--case-sensitive") }
        if let replacing, replacing != value { args += ["--replace", replacing] }
        if ifAbsent { args.append("--if-absent") }
        return args
    }

    /// Saves an entry in `scope` (the page's scope unless named: an Undo names the scope its remove had).
    func addEntry(type: String, value: String, substitution: String?, spoken: [String] = [], meaning: String? = nil,
                  caseSensitive: Bool = false, replacing: String? = nil, scope: String?? = nil, ifAbsent: Bool = false) {
        let args = Self.addEntryArgs(type: type, value: value, substitution: substitution, spoken: spoken, meaning: meaning,
                                     caseSensitive: caseSensitive, scope: scope ?? dictionaryScope, replacing: replacing,
                                     ifAbsent: ifAbsent)
        let entry = SavedDictionaryEntry(type: type, value: value,
                                        substitution: ["fix", "abbr"].contains(type) ? substitution : nil,
                                        spoken: type == "term" && !spoken.isEmpty ? spoken : nil,
                                        meaning: type == "term" && meaning?.isEmpty == false ? meaning : nil,
                                        caseSensitive: type == "fix" && caseSensitive ? true : nil)
        run(key: "dictionary.\(replacing ?? value)", MeetingsAPI.DictionaryAdd.self,
            .init(entry: entry, project: scope ?? dictionaryScope,
                  replace: replacing != value ? replacing : nil, ifAbsent: ifAbsent ? true : nil),
            orRun: args, done: "Saved \(value)") {
            $0.loadDictionary()
            $0.testPhrase($0.phrase)
        }
    }

    func removeEntry(_ entry: DictionaryEntry) {
        var args = ["dictionary", "remove", entry.value]
        let scope = entry.level?.hasPrefix("project ") == true ? dictionaryScope : nil
        if let scope { args += ["--project", scope] }
        let restore = entry
        // The Undo restores into the level the entry left, whatever scope the page shows by then, and only while
        // nobody made the entry again there.
        run(key: "dictionary.\(entry.value)", MeetingsAPI.DictionaryRemove.self,
            .init(value: entry.value, project: scope), orRun: args, done: "Removed \(entry.value)", undo: { [weak model = self] in
            model?.addEntry(type: restore.type, value: restore.value, substitution: restore.substitution,
                           spoken: restore.spoken ?? [], meaning: restore.meaning, caseSensitive: restore.caseSensitive == true,
                           scope: .some(scope), ifAbsent: true)
        }) {
            $0.loadDictionary()
            $0.testPhrase($0.phrase)
        }
    }

    /// What the scope's dictionary does to the phrase; asks again 300 ms after the last key.
    func testPhrase(_ text: String) {
        phrase = text
        phraseTask?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            phraseResult = nil
            notices.dismiss(phraseFailureID)
            return
        }
        let scope = dictionaryScope
        phraseTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            do {
                let result = try await readLibrary(MeetingsAPI.DictionaryTest.self, .init(phrase: trimmed, project: scope),
                                                   orRun: ["dictionary", "test", trimmed, "--json"] + (scope.map { ["--project", $0] } ?? []))
                guard !Task.isCancelled else { return }
                phraseResult = result
                notices.dismiss(phraseFailureID)
            } catch {
                guard !Task.isCancelled else { return }
                notices.push(.meetingsFailure(error, id: phraseFailureID))
            }
        }
    }

    // MARK: Runner

    private func runCommand(_ args: [String]) async throws -> Data {
        if let command { return try await command(args) }
        return try await MeetingsCLI.run(args)
    }

    private func readCommand<Value: Decodable>(_ type: Value.Type, _ args: [String]) async throws -> Value {
        if let command { return try JSONDecoder().decode(type, from: await command(args)) }
        return try await MeetingsRead<Value>.command(args).run(service: nil)
    }

    /// Another editor changed the setting after this page read it: nothing was written, and the page reads it again.
    static func staleNotice(_ failure: MeetingsCLI.Failure) -> StackedNotice {
        StackedNotice(text: "Not saved: this setting changed in another window or the terminal. The page shows its new value now.",
                      more: failure.detail, tone: .error)
    }

    func isWriting(_ key: String) -> Bool { writing.contains(key) }

    /// What a write runs: a typed library/config operation, or a command without a service route.
    enum Step {
        case command([String])
        case config(MeetingsConfigWrite)
        case library(@MainActor () async throws -> Void)
    }

    private func readLibrary<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params,
                                                       orRun args: [String]) async throws -> M.Result {
        let read = MeetingsRead.service(method, params, orRun: args)
        return try await read.run(service: service, command: { [self] args, _ in
            try await readCommand(M.Result.self, args)
        })
    }

    /// Only an unavailable service known not to have applied a write permits the compatibility command.
    /// A refusal, cancellation, lost reply or invalid reply remains the result of that one attempt.
    func writeLibrary<M: MeetingsServiceMethod>(_ method: M.Type, _ params: M.Params, orRun args: [String],
                                                resultFromCommand: Bool = false) async throws -> M.Result? {
        if let service {
            do { return try await service.call(method, params) }
            catch let failure as MeetingsService.Unavailable where failure.safeToRetry {
                try Task.checkCancellation()
            }
        }
        try Task.checkCancellation()
        if resultFromCommand { return try await readCommand(M.Result.self, args) }
        _ = try await runCommand(args)
        return nil
    }

    private func run<M: MeetingsServiceMethod>(key: String, _ method: M.Type, _ params: M.Params,
                                               orRun args: [String], done: String?, undo: (@MainActor () -> Void)? = nil,
                                               saved: ((MeetingsSettingsModel) -> Void)? = nil,
                                               then: @escaping (MeetingsSettingsModel) -> Void) {
        run(key: key, .library { [self] in
            _ = try await writeLibrary(method, params, orRun: args)
        }, done: done, undo: undo, saved: saved, then: then)
    }

    private func run(key: String, _ args: [String], done: String?, undo: (@MainActor () -> Void)? = nil,
                     saved: ((MeetingsSettingsModel) -> Void)? = nil, then: @escaping (MeetingsSettingsModel) -> Void) {
        run(key: key, .command(args), done: done, undo: undo, saved: saved, then: then)
    }

    /// `saved` runs after a write succeeded, before the reload: this page's next write then names its own value, not
    /// the one before it.
    private func run(key: String, _ step: Step, done: String?, undo: (@MainActor () -> Void)? = nil,
                     saved: ((MeetingsSettingsModel) -> Void)? = nil, then: @escaping (MeetingsSettingsModel) -> Void) {
        guard writes else { return }
        guard !writing.contains(key) else { return }
        writing.insert(key)
        Task {
            do {
                switch step {
                case .command(let args): _ = try await runCommand(args)
                case .config(let write): try await write.run(service: service)
                case .library(let perform): try await perform()
                }
                saved?(self)
                if let done {
                    // The Undo closes this notice; what it undid reports as a notice of its own.
                    let actions = undo.map { undo in
                        [StackedNotice.Action("Undo", symbol: "arrow.uturn.backward") { _ in undo() }]
                    } ?? []
                    notices.push(StackedNotice(text: done, actions: actions))
                }
            } catch let failure as MeetingsCLI.Failure where failure.code == "config-stale" {
                notices.push(Self.staleNotice(failure))
                loadSettings()
            } catch let failure as MeetingsCLI.Failure where failure.code == "dictionary-exists" {
                // An Undo found the entry made again: a retry would be refused the same way.
                notices.push(StackedNotice(text: failure.sentence, more: failure.detail, tone: .error))
            } catch {
                notices.push(.meetingsFailure(error) { [weak model = self] in
                    model?.run(key: key, step, done: done, undo: undo, saved: saved, then: then)
                })
            }
            // Before `then`: a value kept for this path is written from there.
            writing.remove(key)
            then(self)
        }
    }
}

// MARK: - Rename and remove a project

/// What `tools meetings projects remove --json` prints.
struct ProjectRemoval: Decodable, Equatable {
    let name: String
    /// The meetings that had the project and now have none (`--unassign`).
    let unassigned: [String]
    /// The removed settings, kept as JSON.
    let backup: String
}

extension MeetingsSettingsModel {
    static func renameArgs(_ from: String, to: String) -> [String] { ["projects", "rename", from, to] }

    static func removeArgs(_ name: String, unassign: Bool) -> [String] {
        ["projects", "remove", name, "--json"] + (unassign ? ["--unassign"] : [])
    }

    /// The CLI refuses to remove a project meetings still have with `[project-in-use]`
    /// (src/utils/meetings/conflict.ts); `--unassign` is then the way to go on.
    static let projectInUse = "project-in-use"

    static func offersUnassign(_ failure: MeetingsCLI.Failure) -> Bool { failure.code == projectInUse }

    static func removalNote(_ removal: ProjectRemoval) -> String {
        removal.unassigned.isEmpty
            ? "Removed the project \(removal.name)"
            : "Removed the project \(removal.name); \(Plural.count(removal.unassigned.count, "meeting")) now \(removal.unassigned.count == 1 ? "has" : "have") no project"
    }

    /// Renames a project everywhere it is named (`projects rename`): its settings, its pairings and its meetings. Undo
    /// renames it back; `renamed` runs once the CLI saved it.
    func renameProject(_ from: String, to typed: String, renamed: (() -> Void)? = nil) {
        let to = typed.trimmingCharacters(in: .whitespaces)
        guard !to.isEmpty, to != from else { return }
        run(key: "project.rename.\(from)", MeetingsAPI.ProjectsRename.self, .init(from: from, to: to),
            orRun: Self.renameArgs(from, to: to), done: "Renamed \(from) to \(to)",
            undo: { [weak self] in self?.renameProject(to, to: from) }, saved: { model in
                if model.writes { MeetingsPreferences.renameOpenProject(from, to: to) }
                renamed?()
            }) { $0.loadSettings() }
    }

    /// Removes a project (`projects remove`); its settings go into a backup first. While meetings have it the CLI
    /// refuses, and the note offers the removal that leaves those meetings without a project.
    func removeProject(_ name: String, unassign: Bool = false) {
        let key = "project.remove.\(name)"
        guard writes, !writing.contains(key) else { return }
        writing.insert(key)
        Task {
            defer { writing.remove(key) }
            do {
                guard let removal = try await writeLibrary(MeetingsAPI.ProjectsRemove.self,
                                                            .init(name: name, unassign: unassign ? true : nil),
                                                            orRun: Self.removeArgs(name, unassign: unassign),
                                                            resultFromCommand: true) else { return }
                notices.push(StackedNotice(text: Self.removalNote(removal),
                                           detail: "Its settings are kept in \((removal.backup as NSString).abbreviatingWithTildeInPath)"))
            } catch let failure as MeetingsCLI.Failure where !unassign && Self.offersUnassign(failure) {
                notices.push(StackedNotice(text: failure.sentence, more: failure.detail, tone: .error,
                                           actions: [.init("Remove and leave them without a project", symbol: "trash") { [weak self] _ in
                                               self?.removeProject(name, unassign: true)
                                           }]))
            } catch {
                notices.push(.meetingsFailure(error) { [weak self] in self?.removeProject(name, unassign: unassign) })
            }
            loadSettings()
        }
    }
}

