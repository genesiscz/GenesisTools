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

/// The Settings → Meetings pages: the meetings config (read with `config show`, written with `config set` and the
/// projects and dictionary commands), the cost of each capture choice, the match preview and the phrase test.
@Observable
@MainActor
final class MeetingsSettingsModel {
    private(set) var settings: Loadable<MeetingsSettings> = .idle
    /// The settings as JSON from the same read, so each write names the value it replaces.
    private(set) var settingsRaw: JSONValue?
    private(set) var cost: Loadable<CaptureCost> = .idle
    private(set) var preview: Loadable<[MatchPreviewRow]> = .idle
    private(set) var dictionary: Loadable<DictionaryShow> = .idle
    private(set) var phraseResult: PhraseTest?
    /// Paths with a write in flight, so their control waits and a second change does not race the first.
    private(set) var writing: Set<String> = []
    var drafts: [String: MatchRulesDraft] = [:]
    var notice: MeetingsNotice?
    /// The dictionary page's scope: nil is the global dictionary.
    var dictionaryScope: String? {
        didSet { if oldValue != dictionaryScope { loadDictionary(); testPhrase(phrase) } }
    }
    var phrase = ""
    /// False in a snapshot: nothing is written.
    let writes: Bool
    private var previewTask: Task<Void, Never>?
    private var phraseTask: Task<Void, Never>?

    init(writes: Bool = true) {
        self.writes = writes
    }

    /// Every read has ended, with data or with its error (a snapshot waits for this).
    var settled: Bool {
        !settings.isLoading && settings != .idle && !cost.isLoading && cost != .idle && !preview.isLoading && preview != .idle
    }

    func load() {
        loadSettings()
        loadCost()
        loadPreview()
        loadDictionary()
    }

    func loadSettings() {
        settings = .loading(previous: settings.value)
        Task {
            do {
                let shown = try await MeetingsCLI.json(ConfigShow.self, ["config", "show", "--json"])
                let value = shown.value
                settingsRaw = shown.raw
                settings = .loaded(value)
                for name in value.projectNames where drafts[name] == nil {
                    drafts[name] = savedRules(name, in: value)
                }
            } catch {
                settings = .failed(asFailure(error), previous: settings.value)
            }
        }
    }

    func loadCost() {
        cost = .loading(previous: cost.value)
        Task {
            do {
                cost = .loaded(try await MeetingsCLI.json(CaptureCost.self, ["record", "cost", "--json"]))
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
                let rows = try await MeetingsCLI.json([MatchPreviewRow].self, args)
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
                let value = try await MeetingsCLI.json(DictionaryShow.self, ["dictionary", "show", "--json"] + (scope.map { ["--project", $0] } ?? []))
                guard scope == dictionaryScope else { return }
                dictionary = .loaded(value)
            } catch {
                dictionary = .failed(asFailure(error), previous: dictionary.value)
            }
        }
    }

    // MARK: Writes

    /// The `--expect` arguments of a write at `path`: the value this page read there. Another editor's change since then
    /// makes the CLI refuse the write (`config-stale`) instead of overwriting it.
    static func expectArgs(_ path: [String], in raw: JSONValue?) -> [String] {
        guard let raw else { return [] }
        return ["--expect", MeetingsCLI.jsonArgument(raw.at(path).foundation)]
    }

    /// One `config edit` change: the new value (nil unsets the key) and the value this page read there.
    static func editJSON(_ path: [String], _ value: Any?, in raw: JSONValue?) -> [String: Any] {
        var edit: [String: Any] = ["path": MeetingsCLI.jsonArgument(path)]
        if let value { edit["value"] = value } else { edit["unset"] = true }
        if let raw { edit["expect"] = raw.at(path).foundation }
        return edit
    }

    /// Writes one config value (`config set`) and reads the settings again. A refused value shows the schema's
    /// sentence; the control goes back to the saved value with the reload.
    func set(_ path: [String], _ value: Any, done: String? = nil) {
        run(key: path.joined(separator: "."),
            ["config", "set", MeetingsCLI.jsonArgument(path), MeetingsCLI.jsonArgument(value)] + Self.expectArgs(path, in: settingsRaw),
            done: done, saved: { $0.settingsRaw = $0.settingsRaw?.setting(path, to: JSONValue(foundation: value)) }) {
            $0.loadSettings()
            if path.first == "global", path.dropFirst().first == "capture" { $0.loadCost() }
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
        run(key: "project.add", ["projects", "add", trimmed], done: "Added the project \(trimmed)") { $0.loadSettings() }
    }

    func changeLabels(_ project: String, add: [String] = [], remove: [String] = []) {
        var args = ["projects", "labels", project]
        if !add.isEmpty { args += ["--add"] + add }
        if !remove.isEmpty { args += ["--remove"] + remove }
        run(key: "labels.\(project)", args, done: nil) { $0.loadSettings() }
    }

    func unpair(entry: String, title: String, count: Int) {
        run(key: "unpair.\(entry)", ["projects", "unpair", "--entry", entry],
            done: "Unpaired \(Plural.count(count, "person", "people")) that \(title) paired") { $0.loadSettings() }
    }

    func unpair(person: PairedPerson, from project: String) {
        run(key: "unpair.\(project).\(person.id)", ["projects", "unpair", project, "--person", person.email ?? person.name],
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
        run(key: "projects.\(project).export",
            ["config", "unset", MeetingsCLI.path("projects", project, "export")] + Self.expectArgs(["projects", project, "export"], in: settingsRaw),
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
                _ = try await MeetingsCLI.run(["config", "edit", MeetingsCLI.jsonArgument(edits)])
                notice = MeetingsNotice(text: "Saved the \(project) rules", tone: .success)
            } catch let failure as MeetingsCLI.Failure where failure.code == "config-stale" {
                // The draft stays: the reload brings the other editor's rules into the saved side to compare with.
                notice = Self.staleNotice(failure)
            } catch {
                notice = .failure(error) { [weak model = self] in model?.saveRules(project) }
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
        var out: [String: Any] = [:]
        for (name, draft) in drafts where draft != savedRules(name, in: settings) {
            out[name] = draft.json
        }
        return out
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
        run(key: "dictionary.\(replacing ?? value)", args, done: "Saved \(value)") {
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
        run(key: "dictionary.\(entry.value)", args, done: "Removed \(entry.value)", undo: { [weak model = self] in
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
            return
        }
        let scope = dictionaryScope
        phraseTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            do {
                let result = try await MeetingsCLI.json(PhraseTest.self, ["dictionary", "test", trimmed, "--json"] + (scope.map { ["--project", $0] } ?? []))
                guard !Task.isCancelled else { return }
                phraseResult = result
            } catch {
                guard !Task.isCancelled else { return }
                notice = .failure(error)
            }
        }
    }

    // MARK: Runner

    /// Another editor changed the setting after this page read it: nothing was written, and the page reads it again.
    static func staleNotice(_ failure: MeetingsCLI.Failure) -> MeetingsNotice {
        MeetingsNotice(text: "Not saved: this setting changed in another window or the terminal. The page shows its new value now.",
                       more: failure.detail, tone: .error)
    }

    func isWriting(_ key: String) -> Bool { writing.contains(key) }

    /// `saved` runs after a write succeeded, before the reload: this page's next write then names its own value, not
    /// the one before it.
    private func run(key: String, _ args: [String], done: String?, undo: (@MainActor () -> Void)? = nil,
                     saved: ((MeetingsSettingsModel) -> Void)? = nil, then: @escaping (MeetingsSettingsModel) -> Void) {
        guard writes else { return }
        guard !writing.contains(key) else { return }
        writing.insert(key)
        Task {
            defer { writing.remove(key) }
            do {
                _ = try await MeetingsCLI.run(args)
                saved?(self)
                if let done {
                    notice = MeetingsNotice(text: done, tone: .success, actionTitle: undo == nil ? nil : "Undo", actionSymbol: "arrow.uturn.backward", action: undo)
                }
            } catch let failure as MeetingsCLI.Failure where failure.code == "config-stale" {
                notice = Self.staleNotice(failure)
                loadSettings()
            } catch let failure as MeetingsCLI.Failure where failure.code == "dictionary-exists" {
                // An Undo found the entry made again: a retry would be refused the same way.
                notice = MeetingsNotice(text: failure.sentence, more: failure.detail, tone: .error)
            } catch {
                notice = .failure(error) { [weak model = self] in model?.run(key: key, args, done: done, undo: undo, saved: saved, then: then) }
            }
            then(self)
        }
    }
}
