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
                let value = try await MeetingsCLI.json(ConfigShow.self, ["config", "show", "--json"]).value
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

    /// Writes one config value (`config set`) and reads the settings again. A refused value shows the schema's
    /// sentence; the control goes back to the saved value with the reload.
    func set(_ path: [String], _ value: Any, done: String? = nil) {
        run(key: path.joined(separator: "."), ["config", "set", MeetingsCLI.jsonArgument(path), MeetingsCLI.jsonArgument(value)], done: done) {
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
        run(key: "projects.\(project).export", ["config", "unset", MeetingsCLI.path("projects", project, "export")],
            done: "\(project) exports ask for a folder again") { $0.loadSettings() }
    }

    /// Writes the draft rules of one project (only the lists that changed), then previews against the saved rules.
    func saveRules(_ project: String) {
        guard let draft = drafts[project], let settings = settings.value else { return }
        let saved = savedRules(project, in: settings)
        var writes: [[String]] = []
        if draft.folders != saved.folders {
            writes.append(["config", "set", MeetingsCLI.path("sources", "wisprflow", "match", project, "folders"), MeetingsCLI.jsonArgument(draft.folders)])
        }
        if draft.calendars != saved.calendars {
            writes.append(["config", "set", MeetingsCLI.path("projects", project, "match", "calendar", "calendars"), MeetingsCLI.jsonArgument(draft.calendars)])
        }
        if draft.titleWords != saved.titleWords {
            writes.append(["config", "set", MeetingsCLI.path("projects", project, "match", "title", "words"), MeetingsCLI.jsonArgument(draft.titleWords)])
        }
        guard writes.isEmpty == false, self.writes else { return }
        writing.insert("rules.\(project)")
        Task {
            defer { writing.remove("rules.\(project)") }
            do {
                for args in writes { _ = try await MeetingsCLI.run(args) }
                notice = MeetingsNotice(text: "Saved the \(project) rules", tone: .success)
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

    func addEntry(type: String, value: String, substitution: String?, spoken: [String] = [], meaning: String? = nil) {
        var args = ["dictionary", "add", value]
        if let substitution, !substitution.isEmpty { args.append(substitution) }
        args += ["--type", type]
        if let scope = dictionaryScope { args += ["--project", scope] }
        for form in spoken { args += ["--spoken", form] }
        if let meaning, !meaning.isEmpty { args += ["--meaning", meaning] }
        run(key: "dictionary.\(value)", args, done: "Saved \(value)") {
            $0.loadDictionary()
            $0.testPhrase($0.phrase)
        }
    }

    func removeEntry(_ entry: DictionaryEntry) {
        var args = ["dictionary", "remove", entry.value]
        let scope = entry.level?.hasPrefix("project ") == true ? dictionaryScope : nil
        if let scope { args += ["--project", scope] }
        let restore = entry
        run(key: "dictionary.\(entry.value)", args, done: "Removed \(entry.value)", undo: { [weak model = self] in
            model?.addEntry(type: restore.type, value: restore.value, substitution: restore.substitution,
                           spoken: restore.spoken ?? [], meaning: restore.meaning)
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

    func isWriting(_ key: String) -> Bool { writing.contains(key) }

    private func run(key: String, _ args: [String], done: String?, undo: (@MainActor () -> Void)? = nil,
                     then: @escaping (MeetingsSettingsModel) -> Void) {
        guard writes else { return }
        guard !writing.contains(key) else { return }
        writing.insert(key)
        Task {
            defer { writing.remove(key) }
            do {
                _ = try await MeetingsCLI.run(args)
                if let done {
                    notice = MeetingsNotice(text: done, tone: .success, actionTitle: undo == nil ? nil : "Undo", actionSymbol: "arrow.uturn.backward", action: undo)
                }
            } catch {
                notice = .failure(error) { [weak model = self] in model?.run(key: key, args, done: done, undo: undo, then: then) }
            }
            then(self)
        }
    }
}
