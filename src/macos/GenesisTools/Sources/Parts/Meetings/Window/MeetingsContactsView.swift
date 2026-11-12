import GenesisKit
import SwiftUI

// MARK: - The Contacts view (F10; R24, G-PPL-5, G-PPL-8)
//
// A sidebar view of the Meetings window, not a meeting tab: every person the directory knows (meetings, calendars,
// Contacts, the people book), where each was seen, search, add, hide, and merge two into one after a confirmation
// that names the meetings, with Undo. Presentational: the people and the states come in, every action goes out
// through a closure (`people.known`, `people.add`, `people.hide`, `people.planMerge`, `people.merge`,
// `people.unmerge`, `config.set global.people.sources.*`, the Contacts grant).

/// The directory's source switches (`global.people.sources`, both on by default).
struct PeopleSourceSwitches: Equatable {
    /// One switch, and the meetings config path `config.set` writes for it.
    enum Switch: String, CaseIterable {
        case contacts, calendar
        var configPath: String { "global.people.sources.\(rawValue)" }
    }

    var contacts = true
    var calendar = true
}

/// Whether the directory may read Contacts.
enum ContactsAccessState: Equatable {
    case allowed
    /// macOS refused access: the reason the service gave, and a grant button.
    case refused(String)
    /// The Contacts switch is off: no grant is needed.
    case off

    /// From a `people.known` answer's source states.
    static func from(_ sources: [PersonSourceState]) -> ContactsAccessState {
        guard let contacts = sources.first(where: { $0.kind == .contacts }) else { return .allowed }
        switch contacts.state {
        case .ok: return .allowed
        case .off: return .off
        case .refused, .failed: return .refused(contacts.reason ?? "Contacts did not answer.")
        }
    }
}

/// Dates and counts in the Contacts words.
enum PeopleDates {
    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain = ISO8601DateFormatter()

    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        return iso.date(from: text) ?? isoPlain.date(from: text)
    }

    /// "3 Nov 2026".
    static func day(_ text: String?) -> String? {
        // The window's own date words ("9 Nov 2026"), as its lists write them: the Mac's region wrote "9. 11. 2026"
        // here and "Thu 5 Nov" one pane to the left.
        date(text).map { $0.formatted(.dateTime.day().month(.abbreviated).year().locale(Locale(identifier: "en_GB"))) }
    }

    /// The sources a row names as chips. "Meetings" is left out for a person the row counts meetings for: the chip
    /// stood on every row and said what the line under the name already says.
    static func sourceChips(_ person: KnownPerson) -> [PersonSourceKind] {
        person.sources.filter { $0 != .meetings || person.meetings == 0 }
    }

    /// Where a person was seen, one line: "4 meetings · last 3 Nov 2026 · Design, Ops".
    static func seen(_ person: KnownPerson) -> String {
        var parts: [String] = []
        switch person.meetings {
        case 0: parts.append(person.sources.contains(.contacts) ? "In Contacts, no meeting yet" : "No meeting yet")
        case 1: parts.append("1 meeting")
        default: parts.append("\(person.meetings) meetings")
        }
        if let day = day(person.lastSeen) { parts.append("last \(day)") }
        if !person.projects.isEmpty { parts.append(person.projects.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

struct MeetingsContactsView: View {
    /// Every person for the query (`people.known` with `includeHidden` when hidden people are shown), in its order.
    let people: [KnownPerson]
    /// How many matched before the limit (`total`).
    var total: Int?
    @Binding var query: String
    @Binding var showHidden: Bool
    var sources: [PersonSourceState] = []
    var switches = PeopleSourceSwitches()
    /// The merge plan to confirm (`people.planMerge`), nil when no merge is asked.
    var mergePlan: PeopleMergePlan?
    /// The merge just made, for its Undo line; nil hides the line.
    var lastMerge: PeopleMergeRecord?
    /// "Add person": a name and an optional address.
    let add: (String, String?) -> Void
    /// Hide (true) or show again (false).
    let setHidden: (KnownPerson, Bool) -> Void
    /// "Merge with…" picked a second person: ask `people.planMerge(a, b)`.
    let requestMerge: (KnownPerson, KnownPerson) -> Void
    /// The confirmation's Merge: `people.merge` with the plan's two people and the chosen name.
    let confirmMerge: (PeopleMergePlan, String) -> Void
    /// The confirmation's Cancel.
    let cancelMerge: () -> Void
    /// Undo of a merge, and Split of a merged person: `people.unmerge(token)`.
    let unmerge: (String) -> Void
    /// A source switch changed: `config.set` at the switch's `configPath`.
    let setSource: (PeopleSourceSwitches.Switch, Bool) -> Void
    /// The Contacts grant (PermissionCenter) when access is refused.
    var grantContacts: () -> Void = {}
    /// Optional: show a person's meetings (the meetings list filtered to them).
    var showMeetings: ((KnownPerson) -> Void)?

    @State private var adding = false
    @State private var newName = ""
    @State private var newEmail = ""
    @State private var mergeFrom: KnownPerson?
    @State private var mergeQuery = ""

    private var access: ContactsAccessState { switches.contacts ? ContactsAccessState.from(sources) : .off }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            strips
            if adding { addForm; Divider() }
            list
            Divider()
            sourcesBar
        }
        .sheet(isPresented: Binding(get: { mergePlan != nil }, set: { if !$0 { cancelMerge() } })) {
            if let mergePlan {
                ContactsMergeSheet(plan: mergePlan, confirm: { confirmMerge(mergePlan, $0) }, cancel: cancelMerge)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("People")
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("People").font(.system(size: 15, weight: .semibold))
                Text(countText).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            HStack(spacing: 5) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(.secondary)
                TextField("Search people", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .accessibilityIdentifier("meetings.contacts.search")
                if !query.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search", size: 10) { query = "" }
                }
            }
            .padding(.horizontal, 8)
            .frame(width: 220, height: 26)
            .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.6)))
            Toggle("Hidden", isOn: $showHidden)
                .toggleStyle(.checkbox)
                .font(.system(size: 12))
                .instantTooltip("Also list the people you hid")
                .accessibilityIdentifier("meetings.contacts.showHidden")
            GhostButton("Add person", symbol: "person.badge.plus", tooltip: "Add a person by hand",
                        identifier: "meetings.contacts.add") { adding = true }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var countText: String {
        let shown = people.count
        let all = total ?? shown
        let noun = all == 1 ? "person" : "people"
        return all > shown ? "\(shown) of \(all) \(noun)" : "\(all) \(noun)"
    }

    // MARK: Strips

    @ViewBuilder
    private var strips: some View {
        let undo = lastMerge
        let refused: String? = { if case .refused(let reason) = access { return reason } else { return nil } }()
        if undo != nil || refused != nil {
            VStack(spacing: 6) {
                if let undo {
                    HStack(spacing: 8) {
                        InfoStrip(Self.mergedText(undo), tone: .success)
                        Button("Undo") { unmerge(undo.token) }
                            .controlSize(.small)
                            .accessibilityIdentifier("meetings.contacts.undoMerge")
                    }
                }
                if let refused {
                    InfoStrip("Contacts: \(refused) Allow access to list your contacts too.", tone: .warning,
                              action: grantContacts, actionTooltip: "Open the Contacts permission")
                        .accessibilityIdentifier("meetings.contacts.grant")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            Divider()
        }
    }

    static func mergedText(_ merge: PeopleMergeRecord) -> String {
        let names = merge.people.map(\.name)
        return "Merged \(names.joined(separator: " and ")) into \(merge.name)."
    }

    // MARK: Add

    private var addForm: some View {
        HStack(spacing: 8) {
            TextField("Name", text: $newName)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 160)
                .accessibilityIdentifier("meetings.contacts.add.name")
                .onSubmit(submitAdd)
            TextField("Email (optional)", text: $newEmail)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 160)
                .accessibilityIdentifier("meetings.contacts.add.email")
                .onSubmit(submitAdd)
            Button("Add", action: submitAdd)
                .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Cancel") { closeAdd() }
                .keyboardShortcut(.cancelAction)
        }
        .controlSize(.small)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func submitAdd() {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        let email = newEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        add(name, email.isEmpty ? nil : email)
        closeAdd()
    }

    private func closeAdd() {
        adding = false
        newName = ""
        newEmail = ""
    }

    // MARK: List

    @ViewBuilder
    private var list: some View {
        if people.isEmpty {
            EmptyState(symbol: "person.2", text: query.isEmpty ? "Nobody known yet" : "Nobody matches “\(query)”",
                       detail: query.isEmpty ? "People appear here from your meetings, calendars and Contacts." : nil,
                       actionTitle: query.isEmpty ? nil : "Add “\(query)”",
                       action: query.isEmpty ? nil : { add(query.trimmingCharacters(in: .whitespaces), nil) })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(people) { person in
                        ContactsPersonRow(
                            person: person,
                            mergeWith: { mergeFrom = person; mergeQuery = "" },
                            setHidden: { setHidden(person, $0) },
                            unmerge: person.merge.map { token in { unmerge(token) } },
                            showMeetings: showMeetings.map { show in { show(person) } })
                        .popover(isPresented: Binding(get: { mergeFrom?.id == person.id },
                                                      set: { if !$0 { mergeFrom = nil } }), arrowEdge: .trailing) {
                            PersonPicker(
                                people: Self.mergeCandidates(people, except: person, query: mergeQuery),
                                query: $mergeQuery, title: "Merge \(person.name) with", prompt: "Search people",
                                addRule: .noResults,
                                pick: { other in mergeFrom = nil; requestMerge(person, other) },
                                cancel: { mergeFrom = nil })
                        }
                        Divider().padding(.leading, 52)
                    }
                }
            }
        }
    }

    /// The people "Merge with…" offers: everyone else in the list whose name, alias or address holds the text.
    static func mergeCandidates(_ people: [KnownPerson], except person: KnownPerson, query: String) -> [KnownPerson] {
        let key = PeopleText.fold(query)
        return people.filter { other in
            other.id != person.id && (key.isEmpty
                || PeopleText.fold(other.name).contains(key)
                || other.aliases.contains { PeopleText.fold($0).contains(key) }
                || other.email.map { PeopleText.fold($0).contains(key) } == true)
        }
    }

    // MARK: Sources

    private var sourcesBar: some View {
        HStack(spacing: 16) {
            Text("Sources").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            Toggle("Contacts", isOn: Binding(get: { switches.contacts }, set: { setSource(.contacts, $0) }))
                .instantTooltip("List the people of the Contacts app")
                .accessibilityIdentifier("meetings.contacts.source.contacts")
            Toggle("Calendar", isOn: Binding(get: { switches.calendar }, set: { setSource(.calendar, $0) }))
                .instantTooltip("List the attendees of the meetings' calendar events")
                .accessibilityIdentifier("meetings.contacts.source.calendar")
            Spacer(minLength: 0)
            Text("Meetings, projects and the people you add are always listed.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .font(.system(size: 12))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }
}

/// One person in the Contacts list: initials, the name with its badges, where they were seen, their sources, and the
/// actions (Merge with…, Hide or Show, Split, Meetings) on hover, in the row's menu and its context menu.
struct ContactsPersonRow: View {
    let person: KnownPerson
    let mergeWith: () -> Void
    let setHidden: (Bool) -> Void
    /// Split a merged person again; nil when they are not a merge.
    var unmerge: (() -> Void)?
    var showMeetings: (() -> Void)?

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 10) {
            PersonAvatarView(person: person, size: 28)
                .opacity(person.hidden ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(person.name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(person.hidden ? .secondary : .primary)
                        .lineLimit(1)
                    if person.isSelf { Badge("You", color: KitTheme.accent) }
                    if person.hidden { Badge("Hidden", symbol: "eye.slash") }
                    if person.merge != nil {
                        Badge("Merged", symbol: "arrow.triangle.merge",
                              tooltip: person.aliases.isEmpty ? nil : "Also known as \(person.aliases.joined(separator: ", "))")
                    }
                }
                Text([person.email, PeopleDates.seen(person)].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            HStack(spacing: 4) {
                ForEach(PeopleDates.sourceChips(person), id: \.self) { source in
                    Badge(source.title, look: .tag)
                }
            }
            actionsMenu
                .opacity(hovering ? 1 : 0.35)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        // Up to 500 people: the actions menu and its tooltip exist only on the row under the pointer.
        .liveRow()
        .background(hovering ? Color.primary.opacity(0.04) : .clear)
        .onHover { hovering = $0 }
        .contextMenu { actions }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([person.name, person.isSelf ? "you" : nil, person.hidden ? "hidden" : nil, person.email,
                             PeopleDates.seen(person)].compactMap { $0 }.joined(separator: ", "))
        .accessibilityActions { actions }
        .accessibilityIdentifier("meetings.contacts.row.\(person.id)")
    }

    /// A drawn menu button: the list can hold 500 people, and a SwiftUI `Menu` is an NSPopUpButton per row.
    private var actionsMenu: some View {
        MenuButton(items: { menuItems }) {
            Image(systemName: "ellipsis.circle").font(.system(size: 14))
        }
        .fixedSize()
        .instantTooltip("Actions for \(person.name)")
        .accessibilityLabel("Actions for \(person.name)")
    }

    /// The same actions as `actions` (the context menu and VoiceOver), for the drawn menu.
    private var menuItems: [MenuButtonItem] {
        var items: [MenuButtonItem] = [.action("Merge with…", run: mergeWith)]
        if let unmerge { items.append(.action("Split Merge", run: unmerge)) }
        if let showMeetings { items.append(.action("Show Meetings", run: showMeetings)) }
        items.append(.divider)
        items.append(person.hidden ? .action("Show Again") { setHidden(false) } : .action("Hide") { setHidden(true) })
        return items
    }

    @ViewBuilder
    private var actions: some View {
        Button("Merge with…", systemImage: "arrow.triangle.merge", action: mergeWith)
        if let unmerge { Button("Split Merge", systemImage: "arrow.triangle.branch", action: unmerge) }
        if let showMeetings { Button("Show Meetings", systemImage: "calendar", action: showMeetings) }
        Divider()
        if person.hidden {
            Button("Show Again", systemImage: "eye") { setHidden(false) }
        } else {
            Button("Hide", systemImage: "eye.slash") { setHidden(true) }
        }
    }
}

/// The merge confirmation (R24: "a merge first asks, naming the meetings it changes"): the two people, the name the
/// merged person shows, the meetings that name either, and the labels that will show the merged name.
struct ContactsMergeSheet: View {
    let plan: PeopleMergePlan
    let confirm: (String) -> Void
    let cancel: () -> Void
    /// The most meetings listed before "and N more".
    var visibleMeetings: Int = 8

    @State private var name: String?

    private var chosen: String { name ?? plan.name }
    private var names: [String] {
        var seen: [String] = []
        for candidate in [plan.name] + plan.people.map(\.name) where !seen.contains(candidate) { seen.append(candidate) }
        return seen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(Self.title(plan)).font(.system(size: 14, weight: .semibold))
            Text("They show as one person in every list. No meeting record changes, and Undo splits them again.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if names.count > 1 {
                Picker("Show as", selection: Binding(get: { chosen }, set: { name = $0 })) {
                    ForEach(names, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("meetings.contacts.merge.name")
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.meetingsHeading(plan)).font(.system(size: 12, weight: .semibold))
                ForEach(plan.meetings.prefix(visibleMeetings)) { meeting in
                    HStack(spacing: 6) {
                        Text(meeting.title).font(.system(size: 12)).lineLimit(1)
                        Text(PeopleDates.day(meeting.start) ?? "").font(.system(size: 11)).foregroundStyle(.secondary)
                        Spacer(minLength: 4)
                        Text(meeting.people.compactMap { plan.people.indices.contains($0) ? plan.people[$0].name : nil }
                            .joined(separator: ", "))
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                if plan.meetings.count > visibleMeetings {
                    Text("and \(plan.meetings.count - visibleMeetings) more").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            if !plan.labels.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Speaker labels that will show \(chosen)").font(.system(size: 12, weight: .semibold))
                    ForEach(plan.labels, id: \.self) { label in
                        Text("\(label.label) in \(Self.meetingTitle(label.meeting, plan))")
                            .font(.system(size: 12))
                            .lineLimit(1)
                    }
                }
            }
            HStack {
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button("Merge") { confirm(chosen) }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("meetings.contacts.merge.confirm")
            }
        }
        .padding(20)
        .frame(width: 440)
    }

    static func title(_ plan: PeopleMergePlan) -> String {
        "Merge \(plan.people.map(\.name).joined(separator: " and "))?"
    }

    static func meetingsHeading(_ plan: PeopleMergePlan) -> String {
        switch plan.meetings.count {
        case 0: return "No meeting names either of them."
        case 1: return "1 meeting names them"
        default: return "\(plan.meetings.count) meetings name them"
        }
    }

    static func meetingTitle(_ id: String, _ plan: PeopleMergePlan) -> String {
        plan.meetings.first { $0.id == id }?.title ?? id
    }
}

/// All known appearances, including meetings outside the window's current date filter.
struct PersonMeetingsSheet: View {
    let history: MeetingsPeopleModel.History
    let retry: () -> Void
    let open: (String) -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Meetings with \(history.person.name)").font(.headline)
                Spacer()
                Button("Close", action: close).keyboardShortcut(.cancelAction)
            }
            LoadablePane(state: history.meetings, reading: "Reading meeting history…", retry: retry) { result in
                if result.meetings.isEmpty {
                    Text("No meeting names this person yet.").foregroundStyle(.secondary)
                } else {
                    List(result.meetings) { meeting in
                        Button { open(meeting.meeting) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(meeting.title.isEmpty ? "Untitled meeting" : meeting.title)
                                Text([PeopleDates.day(meeting.start) ?? meeting.start,
                                      meeting.roles.map(\.rawValue).joined(separator: ", ")].joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.genHoverPlain())
                        .accessibilityHint("Open this meeting")
                    }
                }
            }
        }
        .padding(16)
        .frame(minWidth: 520, minHeight: 360)
    }
}
