import SwiftUI

// MARK: - Projects

struct MeetingsProjectsPage: View {
    @Bindable var model: MeetingsSettingsModel
    @State private var newProject = ""

    var body: some View {
        MeetingsSettingsFrame(model: model, reads: .preview) { settings in
            let assign = settings.global.assign
            NativeSettingsCard("Ask each time", subtitle: "A meeting with no project after its sources link gets one question in the decision inbox, with ranked proposals.") {
                NativeSettingsToggle("Ask about each meeting without a project", identifier: "meetings.assign.ask",
                                     isOn: Binding(get: { assign.ask }, set: { model.set(["global", "assign", "ask"], $0) }))
                Divider()
                Group {
                    NativeSettingsRow("Look back", detail: "The watcher asks about meetings that started this many hours ago or later.") {
                        NativeSettingsNumberPicker("Look back (hours)", range: 1..<337, identifier: "meetings.assign.lookback",
                                                   value: Binding(get: { assign.lookbackHours }, set: { model.set(["global", "assign", "lookbackHours"], $0) }))
                    }
                    NativeSettingsPicker("Most proposals", detail: "How many ranked projects one question lists.",
                                         identifier: "meetings.assign.maxProposals",
                                         options: Array(Set([3, 5, 8, 10, assign.maxProposals])).sorted().map { NativeSettingsOption($0, "\($0)") },
                                         selection: Binding(get: { assign.maxProposals }, set: { model.set(["global", "assign", "maxProposals"], $0) }))
                    NativeSettingsRow("Calendar slack", detail: "Minutes before or after the meeting a calendar entry may start and still count as its entry.") {
                        NativeSettingsNumberPicker("Calendar slack (minutes)", range: 0..<121, identifier: "meetings.assign.slack",
                                                   value: Binding(get: { assign.calendarSlackMin }, set: { model.set(["global", "assign", "calendarSlackMin"], $0) }))
                    }
                    NativeSettingsRow("Calendar look-behind", detail: "Hours before the meeting a calendar entry may start and still be looked up; never less than the slack.") {
                        NativeSettingsNumberPicker("Calendar look-behind (hours)", range: 0..<49, identifier: "meetings.assign.calendarLookbehind",
                                                   value: Binding(get: { assign.calendarLookbehindHours ?? MeetingsSettings.Global.Assign.defaultCalendarLookbehindHours },
                                                                  set: { model.set(["global", "assign", "calendarLookbehindHours"], $0) }))
                    }
                    NativeSettingsRow("Wait for a folder", detail: "Days a meeting waits for you to move it into a Wispr folder; then the folder question ends.") {
                        NativeSettingsNumberPicker("Wait for a folder (days)", range: 1..<366, identifier: "meetings.assign.folderWait",
                                                   value: Binding(get: { assign.folderWaitDays ?? MeetingsSettings.Global.Assign.defaultFolderWaitDays },
                                                                  set: { model.set(["global", "assign", "folderWaitDays"], $0) }))
                    }
                    NativeSettingsRow("Retry a failed question", detail: "Minutes before a question whose post failed is posted again, so a broken inbox is not hit on every look.") {
                        NativeSettingsNumberPicker("Retry a failed question (minutes)", range: 1..<1441, identifier: "meetings.assign.retryFailed",
                                                   value: Binding(get: { assign.retryFailedMin ?? MeetingsSettings.Global.Assign.defaultRetryFailedMin },
                                                                  set: { model.set(["global", "assign", "retryFailedMin"], $0) }))
                    }
                }
                .disabled(!assign.ask)
                if !assign.ask {
                    Text("Turn on asking to change these.").font(.system(size: 11.5)).foregroundStyle(.secondary)
                }
            }

            WouldMatchCard(model: model)

            if settings.projectNames.isEmpty {
                NativeSettingsCard {
                    EmptyState(symbol: "folder.badge.plus", text: "No project yet", detail: "A project brings its dictionary, labels and match rules to its meetings.")
                }
            }
            ForEach(settings.projectNames, id: \.self) { name in
                ProjectCard(model: model, name: name, settings: settings)
                    .nativeSettingsAnchor("project-\(name)")
            }

            NativeSettingsCard("Exports", subtitle: "Export writes a meeting's note into its project's folder; Export again writes it anew.") {
                NativeSettingsPicker("When the note was edited",
                                     detail: "What Export does when the note holds changes the last export did not write.",
                                     identifier: "meetings.export.ifEdited",
                                     options: [
                                         NativeSettingsOption("beside", "Write the new note beside it", detail: "Your edits stay; the new note gets the date in its name."),
                                         NativeSettingsOption("refuse", "Write nothing and ask", detail: "The window offers Replace."),
                                         NativeSettingsOption("replace", "Replace it", detail: "Your edits in the note are lost."),
                                     ],
                                     selection: Binding(get: { settings.global.export?.ifEdited ?? MeetingsSettings.Global.Export.defaultIfEdited },
                                                        set: { model.set(["global", "export", "ifEdited"], $0) }))
            }
            .nativeSettingsAnchor("exports")

            NativeSettingsCard("Add a project") {
                HStack {
                    TextField("Project name (letters, digits, . _ -)", text: $newProject)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(add)
                        // Clears once the project is saved; a refused name stays to be corrected.
                        .onChange(of: settings.projectNames) { _, names in
                            if names.contains(newProject.trimmingCharacters(in: .whitespaces)) { newProject = "" }
                        }
                    Button("Add a project", action: add)
                        .buttonStyle(.bordered).nativeSettingsPointer()
                        .disabled(newProject.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func add() {
        model.addProject(newProject)
    }
}

private struct ProjectCard: View {
    @Bindable var model: MeetingsSettingsModel
    let name: String
    let settings: MeetingsSettings

    var body: some View {
        let project = settings.projects[name]
        let draft = model.drafts[name] ?? model.savedRules(name, in: settings)
        NativeSettingsCard(name, subtitle: "Its meetings get its dictionary and labels; a rule below puts a meeting in it.") {
            TokenList(title: "Wispr folders", detail: "A Wispr Flow note in one of these folders is this project's.",
                      values: draft.folders, placeholder: "Add a folder") { values in model.editDraft(name) { $0.folders = values } }
            Divider()
            TokenList(title: "Calendar names", detail: "An overlapping entry in one of these calendars is this project's.",
                      values: draft.calendars, placeholder: "Add a calendar") { values in model.editDraft(name) { $0.calendars = values } }
            Divider()
            TokenList(title: "Title words", detail: "A meeting whose title holds one of these words is this project's.",
                      values: draft.titleWords, placeholder: "Add a word") { values in model.editDraft(name) { $0.titleWords = values } }
            if model.hasUnsavedRules(name) {
                HStack {
                    Text("The preview above uses these rules; they are not saved yet.").font(.system(size: 11.5)).foregroundStyle(KitPalette.modified)
                    Spacer()
                    // lint-rules-ignore: short list (one settings card per project, its buttons show only with unsaved rules)
                    Button("Discard") { model.discardRules(name) }.buttonStyle(.genHoverPlain())
                    Button("Save rules") { model.saveRules(name) }
                        .buttonStyle(.borderedProminent).nativeSettingsPointer()
                        .disabled(model.isWriting("rules.\(name)"))
                        .keyboardShortcut(.defaultAction)
                }
            }
            Divider()
            TokenList(title: "Labels", detail: "Labels a meeting of this project can carry, to group meetings finer.",
                      values: project?.labels ?? [], placeholder: "Add a label") { values in
                let old = project?.labels ?? []
                model.changeLabels(name, add: values.filter { !old.contains($0) }, remove: old.filter { !values.contains($0) })
            }
            Divider()
            PeopleList(model: model, project: name, people: project?.match?.people ?? [], projects: settings.projects)
            Divider()
            NativeSettingsRow("Export folder", detail: "Where Export writes this project's meeting notes.") {
                HStack(spacing: 8) {
                    if let folder = project?.export?.folder {
                        PathLabel(path: folder, font: .system(size: 11, design: .monospaced), showIcons: false)
                        Button("Clear") { model.clearExportFolder(name) }.buttonStyle(.genHoverPlain())
                    } else {
                        Text("Asks on the first export").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    Button("Choose…") { model.chooseExportFolder(name) }.buttonStyle(.bordered).nativeSettingsPointer()
                }
            }
            Divider()
            NativeSettingsRow("The project", detail: "Rename it everywhere it is named, or remove it; its settings go into a backup first.") {
                HStack(spacing: 8) {
                    RenameProjectButton(model: model, name: name)
                    RemoveProjectButton(model: model, name: name)
                }
            }
        }
    }
}

/// "Rename…": a popover with the new name. The field keeps what was typed until the CLI saved the rename.
private struct RenameProjectButton: View {
    @Bindable var model: MeetingsSettingsModel
    let name: String
    @State private var open = false
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        Button("Rename…") { text = name; open = true }
            .buttonStyle(.bordered).nativeSettingsPointer()
            .disabled(model.isWriting("project.rename.\(name)"))
            .instantTooltip("Rename \(name) in its settings, its pairings and its meetings")
            .popover(isPresented: $open, arrowEdge: .bottom) {
                HStack {
                    TextField("New name (letters, digits, . _ -)", text: $text)
                        .textFieldStyle(.roundedBorder).frame(width: 220)
                        .focused($focused)
                        .onSubmit(rename)
                    Button("Rename", action: rename).keyboardShortcut(.defaultAction).disabled(!changed)
                }
                .padding(12)
                .onAppear { focused = true }
            }
    }

    private var changed: Bool {
        let typed = text.trimmingCharacters(in: .whitespaces)
        return !typed.isEmpty && typed != name
    }

    private func rename() {
        guard changed else { return }
        model.renameProject(name, to: text) { open = false }
    }
}

/// "Remove…" with a confirmation that says where the settings go and what happens to the project's meetings.
private struct RemoveProjectButton: View {
    @Bindable var model: MeetingsSettingsModel
    let name: String
    @State private var asking = false

    var body: some View {
        Button("Remove…", role: .destructive) { asking = true }
            .buttonStyle(.bordered).nativeSettingsPointer()
            .disabled(model.isWriting("project.remove.\(name)"))
            .instantTooltip("Remove \(name); its settings go into a backup first")
            .confirmationDialog("Remove the project \(name)?", isPresented: $asking) {
                Button("Remove", role: .destructive) { model.removeProject(name) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Its rules, labels, dictionary and pairings go into a backup first. While meetings have it, it stays, and you can then leave them without a project.")
            }
    }
}

/// The people paired with a project, each with where the pairing came from. Unpairing a calendar entry removes its
/// pairings in every project, so its button says how many pairings that is, in how many projects, and how many people
/// leave a project because no other source pairs them.
private struct PeopleList: View {
    @Bindable var model: MeetingsSettingsModel
    let project: String
    let people: [PairedPerson]
    let projects: [String: ProjectSettings]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Paired people").font(.system(size: 13))
            Text("A later meeting with these people proposes this project.").font(.system(size: 11.5)).foregroundStyle(.secondary)
            if people.isEmpty {
                Text("Nobody yet: an answered project question pairs the calendar entry's attendees.").font(.system(size: 12)).foregroundStyle(.tertiary)
            }
            ForEach(people) { person in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: person.label).font(.system(size: 12.5))
                        Text(verbatim: person.pairedBy.map(MeetingsWords.pairedBy).joined(separator: "; "))
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    MenuButton(items: { unpairItems(person) }) {
                        Text("Unpair…").font(.system(size: 12))
                    }
                    .instantTooltip("Remove this person, or every pairing one calendar entry made")
                }
            }
        }
    }

    private func unpairItems(_ person: PairedPerson) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = [.action("Unpair \(person.name) from \(project)") { model.unpair(person: person, from: project) }]
        for source in person.pairedBy where source.kind == "calendar" {
            guard let entry = source.entryId else { continue }
            let preview = UnpairPreview.of(entry: entry, in: projects)
            let title = source.title.map { "“\($0)”" } ?? "the calendar entry"
            items.append(.action("Unpair every person \(title) paired (\(preview.words))") {
                model.unpair(entry: entry, title: title, preview: preview)
            })
        }
        return items
    }
}

/// The last 20 meetings: the projects the saved rules match, and the drafts' when they differ.
private struct WouldMatchCard: View {
    @Bindable var model: MeetingsSettingsModel

    var body: some View {
        NativeSettingsCard("Would match", subtitle: "The last 20 meetings against the rules below, while you edit them.") {
            if let failure = model.preview.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { model.loadPreview() }])
            }
            if let rows = model.preview.value {
                if rows.isEmpty {
                    Text("No meeting yet.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                ForEach(rows) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: row.title.isEmpty ? "Untitled meeting" : row.title).font(.system(size: 12)).lineLimit(1)
                        Spacer(minLength: 6)
                        Text(verbatim: "has \(row.project ?? "none")").font(.system(size: 11)).foregroundStyle(.tertiary)
                        Text(verbatim: row.now.isEmpty ? "matches none" : "matches \(row.now.joined(separator: ", "))")
                            .font(.system(size: 11.5)).foregroundStyle(.secondary)
                        if row.changed {
                            Image(systemName: "arrow.right").font(.system(size: 9)).foregroundStyle(KitPalette.modified).accessibilityHidden(true)
                            Text(verbatim: row.draft.isEmpty ? "none" : row.draft.joined(separator: ", "))
                                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(KitPalette.modified)
                                .accessibilityLabel("with your edit: \(row.draft.isEmpty ? "none" : row.draft.joined(separator: ", "))")
                        }
                    }
                }
            } else if model.preview.failure == nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Matching the recent meetings…").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// A list of short values: each a chip with a remove button, and a field that adds on Return.
struct TokenList: View {
    let title: String
    let detail: String?
    let values: [String]
    let placeholder: String
    let commit: ([String]) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 13))
            if let detail { Text(detail).font(.system(size: 11.5)).foregroundStyle(.secondary) }
            FlowChips(values: values) { value in commit(values.filter { $0 != value }) }
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                .onSubmit(add)
                .onExitCommand { text = "" }
                // Clears once the saved list holds the value; a refused write keeps it in the field.
                .onChange(of: values) { _, now in
                    if now.contains(text.trimmingCharacters(in: .whitespaces)) { text = "" }
                }
        }
    }

    private func add() {
        let value = text.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, !values.contains(value) else {
            text = ""
            return
        }
        commit(values + [value])
    }
}

private struct FlowChips: View {
    let values: [String]
    let remove: (String) -> Void

    var body: some View {
        if values.isEmpty {
            Text("None").font(.system(size: 12)).foregroundStyle(.tertiary)
        } else {
            WrapLayout(spacing: 6, lineSpacing: 6) {
                ForEach(values, id: \.self) { value in
                    HStack(spacing: 4) {
                        Text(verbatim: value).font(.system(size: 12))
                        IconButton(systemName: "xmark", tooltip: "Remove \(value)", size: 8) { remove(value) }
                    }
                    .padding(.leading, 8).padding(.trailing, 2).padding(.vertical, 1)
                    .background(.white.opacity(0.07), in: Capsule())
                }
            }
        }
    }
}

// MARK: - Dictionary

/// The words `recorder cut-fillers` cuts out of a transcript in the meeting language, in its two levels.
private struct FillersCard: View {
    @Bindable var model: MeetingsSettingsModel
    let language: String
    let fillers: MeetingsSettings.Language.Fillers?

    var body: some View {
        NativeSettingsCard("Filler words", subtitle: "What cutting the fillers of a recording removes, for a meeting held in \(MeetingsLanguage.name(language)).") {
            TokenList(title: "Sounds", detail: "Never real words (ehm, um): cut by default.",
                      values: fillers?.sounds ?? [], placeholder: "Add a sound") { values in write("sounds", values) }
            Divider()
            TokenList(title: "Words", detail: "Fillers that are also real words (jako, like): cut only with the option for all fillers.",
                      values: fillers?.words ?? [], placeholder: "Add a word") { values in write("words", values) }
        }
    }

    private func write(_ level: String, _ values: [String]) {
        model.set(["languages", language, "fillers", level], values, done: "Filler \(level) for \(language): \(values.joined(separator: ", "))")
    }
}

struct MeetingsDictionaryPage: View {
    @Bindable var model: MeetingsSettingsModel
    @State private var type = "fix"
    @State private var value = ""
    @State private var substitution = ""
    @State private var meaning = ""
    @State private var spoken = ""
    @State private var caseSensitive = false
    @State private var editing: DictionaryEntry?
    /// The value of an Add or Save in flight: the form clears once the dictionary holds it, so a refusal keeps it.
    @State private var pendingValue: String?

    var body: some View {
        MeetingsSettingsFrame(model: model, reads: .dictionary) { settings in
            NativeSettingsCard("Scope", subtitle: "A project's dictionary applies over the global one in its meetings.") {
                NativeSettingsPicker("Dictionary", identifier: "meetings.dictionary.scope",
                                     options: [NativeSettingsOption("", "Global")] + settings.projectNames.map { NativeSettingsOption($0, $0) },
                                     selection: Binding(get: { model.dictionaryScope ?? "" }, set: { clear(); model.dictionaryScope = $0.isEmpty ? nil : $0 }))
            }

            NativeSettingsCard("Test a phrase", subtitle: "Type a sentence as a transcript would have it; the result is what this dictionary makes of it.") {
                TextField("A sentence with a word it gets wrong", text: Binding(get: { model.phrase }, set: { model.testPhrase($0) }))
                    .textFieldStyle(.roundedBorder)
                if let result = model.phraseResult, !model.phrase.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text(verbatim: result.text).font(.system(size: 13, weight: .medium)).textSelection(.enabled)
                    if result.fired.isEmpty, result.suggestions.isEmpty {
                        Text("No entry changes this phrase.").font(.system(size: 11.5)).foregroundStyle(.secondary)
                    }
                    ForEach(result.fired) { entry in
                        Text(verbatim: "\(entry.type) · \(entry.value)\(entry.substitution.map { " → \($0)" } ?? "")")
                            .font(.system(size: 11.5)).foregroundStyle(.secondary)
                    }
                    ForEach(result.suggestions, id: \.self) { suggestion in
                        Text(verbatim: "“\(suggestion.heard)” is close to \(suggestion.value) (\(Int(suggestion.score * 100)) %): a transcript asks about it")
                            .font(.system(size: 11.5)).foregroundStyle(KitPalette.modified)
                    }
                }
            }

            FillersCard(model: model, language: settings.global.language, fillers: settings.meetingLanguage?.fillers)
                .nativeSettingsAnchor("fillers")

            NativeSettingsCard(editing == nil ? "Add an entry" : "Edit \(editing?.value ?? "")") {
                NativeSettingsSegmented("Type", identifier: "meetings.dictionary.type", options: [
                    NativeSettingsOption("fix", "Fix", detail: "A word the transcript gets wrong, and its right spelling."),
                    NativeSettingsOption("abbr", "Abbreviation", detail: "Expanded where it is said; the expansion holds the abbreviation (MOP (…))."),
                    NativeSettingsOption("term", "Term", detail: "A word to know: the rules match it, and its meaning can follow its first mention."),
                    NativeSettingsOption("keep", "Keep", detail: "A word that is right as heard and is never asked about."),
                ], selection: $type)
                HStack {
                    TextField(type == "abbr" ? "Abbreviation" : type == "fix" ? "As heard" : "Word", text: $value)
                        .textFieldStyle(.roundedBorder)
                    if type == "fix" || type == "abbr" {
                        TextField(type == "fix" ? "Right spelling" : "Expansion", text: $substitution).textFieldStyle(.roundedBorder)
                    }
                    if type == "term" {
                        TextField("Meaning (optional)", text: $meaning).textFieldStyle(.roundedBorder)
                    }
                }
                if type == "term" {
                    TextField("Spoken forms, comma separated (optional): how people say it", text: $spoken)
                        .textFieldStyle(.roundedBorder)
                }
                if type == "fix" {
                    Toggle("Match only this letter case", isOn: $caseSensitive)
                        .toggleStyle(.checkbox).nativeSettingsPointer()
                        .instantTooltip("Off: the fix matches the word in any letter case")
                }
                HStack {
                    if editing != nil {
                        Button("Cancel") { clear() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                    }
                    Spacer()
                    Button(editing == nil ? "Add" : "Save") {
                        let trimmed = value.trimmingCharacters(in: .whitespaces)
                        // An entry is keyed by its value: a renamed one replaces the old one in the same write.
                        model.addEntry(type: type, value: trimmed,
                                       substitution: substitution.trimmingCharacters(in: .whitespaces),
                                       spoken: MeetingsDictionaryRules.spokenForms(spoken), meaning: meaning,
                                       caseSensitive: caseSensitive, replacing: editing?.value)
                        pendingValue = trimmed
                    }
                    .buttonStyle(.borderedProminent).nativeSettingsPointer()
                    .disabled(!canSave)
                }
            }

            NativeSettingsCard("Entries", subtitle: entriesSubtitle) {
                if let failure = model.dictionary.failure {
                    NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                               fixes: [.button("Retry", symbol: "arrow.clockwise") { model.loadDictionary() }])
                }
                let entries = model.dictionary.value?.entries ?? []
                if entries.isEmpty, model.dictionary.value != nil {
                    Text("No entry yet.").font(.system(size: 12)).foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    HStack(spacing: 8) {
                        Text(verbatim: entry.type).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).frame(width: 36, alignment: .leading)
                        Text(verbatim: entry.value).font(.system(size: 12.5))
                        if let substitution = entry.substitution {
                            Text(verbatim: "→ \(substitution)").font(.system(size: 12.5)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if let level = entry.level, model.dictionaryScope != nil, !level.hasPrefix("project") {
                            Text("global").font(.system(size: 11)).foregroundStyle(.tertiary)
                        } else {
                            IconButton(systemName: "pencil", tooltip: "Edit \(entry.value)") { edit(entry) }
                            IconButton(systemName: "trash", tooltip: "Remove \(entry.value) (Undo follows)") { model.removeEntry(entry) }
                        }
                    }
                    .liveRow()
                }
            }
        }
        .onChange(of: model.dictionary.value?.entries ?? []) { _, entries in
            guard let pendingValue, entries.contains(where: { $0.value == pendingValue }) else { return }
            self.pendingValue = nil
            clear()
        }
    }

    private var entriesSubtitle: String {
        let count = model.dictionary.value?.entries.count ?? 0
        return model.dictionaryScope.map { "\(Plural.count(count, "entry", "entries")): the global ones, then \($0)'s." }
            ?? "\(Plural.count(count, "entry", "entries")) in the global dictionary."
    }

    private var canSave: Bool {
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        if type == "fix" { return !substitution.trimmingCharacters(in: .whitespaces).isEmpty }
        if type == "abbr" { return MeetingsDictionaryRules.expansionHolds(trimmed, substitution) }
        return true
    }

    private func edit(_ entry: DictionaryEntry) {
        editing = entry
        type = entry.type
        value = entry.value
        substitution = entry.substitution ?? ""
        meaning = entry.meaning ?? ""
        spoken = (entry.spoken ?? []).joined(separator: ", ")
        caseSensitive = entry.caseSensitive == true
    }

    private func clear() {
        editing = nil
        value = ""
        substitution = ""
        meaning = ""
        spoken = ""
        caseSensitive = false
    }
}

/// The dictionary's own checks the page makes before a save, the same as the schema's
/// (src/utils/transcribe/dictionary.ts `wholeWord`), so Save is never enabled for an entry the CLI refuses.
enum MeetingsDictionaryRules {
    /// An abbreviation's expansion holds the abbreviation as a whole word: "MOP (…)" holds MOP, "MOPsuffix" does not.
    static func expansionHolds(_ abbreviation: String, _ expansion: String) -> Bool {
        guard !abbreviation.isEmpty else { return false }
        let pattern = "(?<![\\p{L}\\p{N}])\(NSRegularExpression.escapedPattern(for: abbreviation))(?![\\p{L}\\p{N}])"
        return expansion.range(of: pattern, options: .regularExpression) != nil
    }

    /// The spoken forms typed as one line: "zus tent, zu stand" is two forms.
    static func spokenForms(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// What `projects unpair --entry` changes, in every project (the CLI's `removeEntryPairings`): each pairing the entry
/// made goes, and a person no other source pairs leaves that project.
struct UnpairPreview: Equatable {
    let pairings: Int
    let projects: Int
    let leaving: Int

    static func of(entry: String, in projects: [String: ProjectSettings]) -> UnpairPreview {
        var pairings = 0, touched = 0, leaving = 0
        for settings in projects.values {
            let paired = (settings.match?.people ?? []).filter { person in
                person.pairedBy.contains { $0.kind == "calendar" && $0.entryId == entry }
            }
            guard !paired.isEmpty else { continue }
            touched += 1
            pairings += paired.count
            leaving += paired.filter { person in
                person.pairedBy.allSatisfy { $0.kind == "calendar" && $0.entryId == entry }
            }.count
        }
        return UnpairPreview(pairings: pairings, projects: touched, leaving: leaving)
    }

    /// "3 pairings in 2 projects; 2 people leave their project".
    var words: String {
        let left = leaving == 0 ? "nobody leaves a project" : "\(Plural.count(leaving, "person", "people")) \(leaving == 1 ? "leaves" : "leave") a project"
        return "\(Plural.count(pairings, "pairing")) in \(Plural.count(projects, "project")); \(left)"
    }
}
