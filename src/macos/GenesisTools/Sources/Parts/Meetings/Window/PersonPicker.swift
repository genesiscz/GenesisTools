import GenesisKit
import SwiftUI

// MARK: - The person picker (F10; R23, R44, G-OWN-1, G-PPL-1, G-PPL-4)
//
// Amie's speaker picker (AnnotationSnapshot/uploads/2384-amie-speaker-picker.png, 2384-reply-add-new-speaker.png): a
// "Speaker" popover with a "Search contacts" field, one row per person (initials, name, address) in the order the
// directory ranked them, nothing preselected, and "Add 'X' as new speaker" for a typed name that matches no one.
// Presentational: the people, the warning and the source states come in; what the user does goes out through closures.

/// When the picker offers "Add 'X' as new speaker" for the typed text.
enum PersonPickerAddRule: String, CaseIterable {
    /// No person's name or alias is the typed text (case and accents folded): "Dana" still offers a new "Dana" beside
    /// "Dana Example". The plan's pick.
    case noExactMatch
    /// Only when the list is empty.
    case noResults
}

/// Text helpers the picker and the Contacts view share.
enum PeopleText {
    /// Case and accents folded, spaces trimmed: how the directory compares names (`nameKey`).
    static func fold(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// True when a person's name or one of their aliases is the typed text.
    static func isExactMatch(_ person: KnownPerson, _ text: String) -> Bool {
        let key = fold(text)
        guard !key.isEmpty else { return false }
        return fold(person.name) == key || person.aliases.contains { fold($0) == key } || person.email.map(fold) == key
    }

    /// The typed text offered as a new person, or nil.
    static func newName(_ query: String, people: [KnownPerson], rule: PersonPickerAddRule = .noExactMatch) -> String? {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return nil }
        switch rule {
        case .noExactMatch: return people.contains { isExactMatch($0, typed) } ? nil : typed
        case .noResults: return people.isEmpty ? typed : nil
        }
    }

    /// The second line of a person row: the address when there is one, else where the directory knows them from.
    static func address(_ person: KnownPerson) -> String {
        if let email = person.email { return email }
        if person.meetings > 0 { return person.meetings == 1 ? "1 meeting" : "\(person.meetings) meetings" }
        return person.sources.first?.title ?? person.rank.title
    }

    /// The sources that cannot answer (`refused`, `failed`, `off` with a reason): a picker names them, never an empty list.
    static func unavailable(_ sources: [PersonSourceState]) -> [PersonSourceState] {
        sources.filter { $0.state == .refused || $0.state == .failed }
    }
}

/// A round avatar with a person's initials, its color stable for the person.
struct PersonAvatarView: View {
    let person: KnownPerson
    var size: CGFloat = 22

    private static let colors: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo, .brown]

    static func color(for id: String) -> Color {
        let sum = id.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF }
        return colors[sum % colors.count]
    }

    var body: some View {
        Text(person.initials)
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Circle().fill(Self.color(for: person.id).gradient))
            .accessibilityHidden(true)
    }
}

/// The popover's content: the title, the search field, an optional warning, the ranked rows and the add row.
struct PersonPicker: View {
    /// The ranked people for the current query (`people.known`), shown in that order.
    let people: [KnownPerson]
    /// The text typed so far; the picker's field edits it.
    @Binding var query: String
    /// Each source's state; a refused or failed source shows its reason (G-PPL-8).
    var sources: [PersonSourceState] = []
    /// A warning for the typed or picked name, from the plan (G-PPL-4: "Speaker 2 is already Dana Example: both labels
    /// become one person.").
    var warning: String?
    var title: String = "Speaker"
    var prompt: String = "Search contacts"
    var addRule: PersonPickerAddRule = .noExactMatch
    /// The most rows drawn before the list scrolls.
    var visibleRows: Int = 6
    /// A person the user clicked or picked with Return.
    let pick: (KnownPerson) -> Void
    /// "Add 'X' as new speaker": omitted when this picker can only select existing people.
    var addNew: ((String) -> Void)?
    /// Esc.
    var cancel: () -> Void = {}
    /// The Contacts grant button when Contacts refused access; nil hides it.
    var grantContacts: (() -> Void)?

    @State private var highlighted: Int?
    @FocusState private var searchFocused: Bool

    static let rowHeight: CGFloat = 40

    var newName: String? {
        guard addNew != nil else { return nil }
        return PeopleText.newName(query, people: people, rule: addRule)
    }
    /// The rows Up and Down move through: the people, then the add row.
    private var rowCount: Int { people.count + (newName == nil ? 0 : 1) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 6)
                .accessibilityAddTraits(.isHeader)
            searchField
            if let warning {
                InfoStrip(warning, tone: .warning)
                    .padding(.horizontal, 8)
                    .padding(.top, 6)
                    .accessibilityIdentifier("meetings.personPicker.warning")
            }
            ForEach(PeopleText.unavailable(sources), id: \.kind) { source in
                InfoStrip(
                    "\(source.kind.title): \(source.reason ?? "not available")",
                    tone: .info,
                    action: source.kind == .contacts ? grantContacts : nil,
                    actionTooltip: source.kind == .contacts ? "Allow access to Contacts" : nil)
                    .padding(.horizontal, 8)
                    .padding(.top, 6)
            }
            Divider().padding(.top, 8)
            list
        }
        .frame(width: 300)
        .onChange(of: query) { _, _ in highlighted = nil }
        .onAppear { searchFocused = true }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            TextField(prompt, text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($searchFocused)
                .accessibilityIdentifier("meetings.personPicker.search")
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onSubmit(submit)
                .onExitCommand(perform: cancel)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var list: some View {
        if rowCount == 0 {
            Text(query.trimmingCharacters(in: .whitespaces).isEmpty ? "Nobody known yet. Type a name." : "Nobody matches.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                            PersonPickerRow(person: person, highlighted: highlighted == index) { pick(person) }
                                .id(index)
                        }
                        if let newName {
                            addRow(newName).id(people.count)
                        }
                    }
                    .padding(4)
                }
                .frame(height: min(CGFloat(rowCount), CGFloat(visibleRows)) * Self.rowHeight + 8)
                .onChange(of: highlighted) { _, row in if let row { proxy.scrollTo(row) } }
            }
        }
    }

    private func addRow(_ name: String) -> some View {
        Button { addNew?(name) } label: {
            HStack(spacing: 8) {
                Image(systemName: "person.badge.plus")
                    .font(.system(size: 13))
                    .foregroundStyle(KitTheme.accent)
                    .frame(width: 22)
                Text("Add ‘\(name)’ as new speaker")
                    .font(.system(size: 13))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 6).fill(highlighted == people.count ? KitTheme.accent.opacity(0.18) : .clear))
        }
        .buttonStyle(.genHoverRow())
        .accessibilityLabel("Add \(name) as new speaker")
        .accessibilityIdentifier("meetings.personPicker.add")
    }

    private func move(_ step: Int) {
        guard rowCount > 0 else { return }
        if let current = highlighted {
            highlighted = min(max(current + step, 0), rowCount - 1)
        } else {
            highlighted = step > 0 ? 0 : rowCount - 1
        }
    }

    /// Return picks the highlighted row. With nothing highlighted, it adds the typed name only when that is the one
    /// row offered; it never picks the first person by itself (nothing is preselected).
    private func submit() {
        if let row = highlighted {
            if row < people.count { pick(people[row]) } else if let newName { addNew?(newName) }
        } else if people.isEmpty, let newName {
            addNew?(newName)
        }
    }
}

/// One person in the picker: initials, the name (and "you" for the user of this Mac), the address.
struct PersonPickerRow: View {
    let person: KnownPerson
    var highlighted = false
    let action: () -> Void

    var body: some View {
        // lint-rules-ignore: short list (at most 20 people a search returns, in a lazy stack)
        Button(action: action) {
            HStack(spacing: 8) {
                PersonAvatarView(person: person)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(person.name)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        if person.isSelf {
                            Text("you").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                    }
                    Text(PeopleText.address(person))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(height: PersonPicker.rowHeight)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 6).fill(highlighted ? KitTheme.accent.opacity(0.18) : .clear))
        }
        .buttonStyle(.genHoverRow())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([person.name, person.isSelf ? "you" : nil, PeopleText.address(person), person.rank.title]
            .compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(highlighted ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("meetings.personPicker.row.\(person.id)")
    }
}

// MARK: - The rename field with the picker (G-PPL-1)

/// What a rename field does with a typed name when focus goes elsewhere.
enum PersonNameBlur: String, CaseIterable {
    /// The draft stays in the field with Save and Revert; nothing is written. The plan's pick (G-PPL-1).
    case keepDraft
    /// The draft is saved, as the field did before Wave B.
    case commit
}

/// A speaker's name for this meeting with the person picker under it. A click in the picker picks a person (or adds
/// the typed name) and never saves the half-typed text; focus lost elsewhere keeps the draft with Save
/// (`PersonNameBlur.keepDraft`). Esc puts the saved name back.
struct PersonNameField: View {
    /// The label as the transcript names it ("Speaker 2").
    let label: String
    /// The saved name; nil: the label's own name.
    let saved: String?
    /// The ranked people for the draft (`people.known` with the meeting and the label's time).
    let people: [KnownPerson]
    var sources: [PersonSourceState] = []
    /// The plan's warning for the draft (G-PPL-4), nil when the name joins no other label.
    var warning: String?
    var blur: PersonNameBlur = .keepDraft
    var addRule: PersonPickerAddRule = .noExactMatch
    /// The draft changed: ask `people.known` for it, and `decision.plan` for the warning.
    var draftChanged: (String) -> Void = { _ in }
    /// Save a typed name (Save, Return in the field, or a blur with `.commit`).
    let commitName: (String) -> Void
    /// A person picked in the picker.
    let pickPerson: (KnownPerson) -> Void
    /// "Add 'X' as new speaker".
    let addPerson: (String) -> Void
    var grantContacts: (() -> Void)?

    @State private var draft = ""
    @State private var pickerOpen = false
    @FocusState private var focused: Bool

    /// True when the field holds text that differs from the saved name.
    var isDirty: Bool { Self.isDirty(draft: draft, saved: saved) }

    static func isDirty(draft: String, saved: String?) -> Bool {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !typed.isEmpty && typed != (saved ?? "")
    }

    static func draftAfterSavedChange(draft: String, old: String?, new: String?) -> String {
        isDirty(draft: draft, saved: old) ? draft : (new ?? "")
    }

    var body: some View {
        HStack(spacing: 6) {
            TextField("Rename", text: $draft, prompt: Text(saved ?? "Rename for this meeting"))
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .accessibilityIdentifier("meetings.personName.\(label)")
                .onSubmit { save() }
                .onExitCommand { revert() }
                .onChange(of: draft) { _, now in draftChanged(now) }
                .onChange(of: focused) { _, now in
                    if now { pickerOpen = true } else if blur == .commit, !pickerOpen, isDirty { save() }
                }
                .popover(isPresented: $pickerOpen, arrowEdge: .bottom) {
                    PersonPicker(
                        people: people, query: $draft, sources: sources, warning: warning, addRule: addRule,
                        pick: { person in
                            pickerOpen = false
                            draft = person.name
                            pickPerson(person)
                        },
                        addNew: { name in
                            pickerOpen = false
                            draft = name
                            addPerson(name)
                        },
                        cancel: { revert() },
                        grantContacts: grantContacts)
                }
            if isDirty, !focused, !pickerOpen {
                Button("Save") { save() }
                    .controlSize(.small)
                    .accessibilityIdentifier("meetings.personName.save")
                IconButton(systemName: "arrow.uturn.backward", tooltip: "Put the saved name back", size: 11) { revert() }
            }
        }
        .onAppear { draft = saved ?? "" }
        // A new saved name replaces the field only when it holds no draft of its own.
        .onChange(of: saved) { old, now in
            draft = Self.draftAfterSavedChange(draft: draft, old: old, new: now)
        }
    }

    private func save() {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        pickerOpen = false
        guard !typed.isEmpty, typed != (saved ?? "") else { return }
        commitName(typed)
    }

    private func revert() {
        draft = saved ?? ""
        pickerOpen = false
        focused = false
    }
}

// MARK: - The reach of an assignment (R22, the speaker version)

/// "Assign this stretch" reaches more of the same label: the sheet gives this stretch alone ("Just this"), or with the
/// ones ticked, each playable first. Nothing is written until the button; Cancel and Esc write nothing.
struct AssignReachSheet: View {
    let pending: PendingAssign
    let window: MeetingsWindowModel
    @State private var chosen: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Give \(MeetingsFormat.clock(pending.stretch.fromSec)) to \(MeetingsFormat.clock(pending.stretch.toSec)) to \(pending.person)")
                    .font(.system(size: 13, weight: .semibold))
                Text(Self.subtitle(pending))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(pending.more) { stretch in
                        HStack(spacing: 8) {
                            Toggle(isOn: Binding(get: { chosen.contains(stretch.id) },
                                                 set: { on in if on { chosen.insert(stretch.id) } else { chosen.remove(stretch.id) } })) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: "\(MeetingsFormat.clock(stretch.fromSec)) to \(MeetingsFormat.clock(stretch.toSec))")
                                        .font(.system(size: 12).monospacedDigit())
                                    Text(Self.why(stretch)).font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                            }
                            .toggleStyle(.checkbox)
                            Spacer(minLength: 6)
                            IconButton(systemName: "play.fill", tooltip: "Play \(MeetingsFormat.clock(stretch.fromSec)) to \(MeetingsFormat.clock(stretch.toSec))") {
                                window.player.play(.range(from: stretch.fromSec, to: stretch.toSec), in: pending.meeting, from: .speakerChip)
                            }
                        }
                        .padding(.vertical, 5)
                        Divider()
                    }
                }
            }
            .frame(maxHeight: 260)
            HStack {
                Button("Cancel") { window.people.pendingAssign = nil }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(chosen.isEmpty ? "Just this" : "Give \(Plural.count(chosen.count + 1, "stretch", "stretches"))") { give() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("meetings.assignReach.give")
            }
        }
        .padding(18)
        .frame(width: 420)
    }

    static func subtitle(_ pending: PendingAssign) -> String {
        let label = pending.stretch.label ?? "This voice"
        return "\(label) also speaks in \(Plural.count(pending.more.count, "stretch", "stretches")) the engine links to this one. "
            + "Play one to check it, and tick the ones that are \(pending.person) too."
    }

    static func why(_ stretch: MeetingsAPI.AssignStretch) -> String {
        let lines = Plural.count(stretch.lines, "line")
        switch stretch.why {
        case .hintRange: return "\(lines), in the range the hint names"
        case .presentSet: return "\(lines), with the same people present"
        }
    }

    private func give() {
        let extra = pending.more.filter { chosen.contains($0.id) }
            .map { DecisionAction.Stretch(label: $0.label, fromSec: $0.fromSec, toSec: $0.toSec) }
        window.people.pendingAssign = nil
        guard let detail = window.detail, detail.id == pending.meeting else { return }
        detail.assign([pending.stretch] + extra, to: pending.person, email: pending.email)
    }
}
