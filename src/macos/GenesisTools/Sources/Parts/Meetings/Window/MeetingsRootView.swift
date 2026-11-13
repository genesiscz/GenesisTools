import SwiftUI

/// The pane map: full-height sidebar (Needs you, All meetings, Projects, Contacts) | the meetings of that place | one
/// meeting. Contacts is sidebar | the people, since it lists people and needs the width of both meeting columns.
struct MeetingsRootView: View {
    @Bindable var model: MeetingsWindowModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The playback dock's height: the columns keep that much room at their bottom (`meetingsDockInset`), so their
    /// last rows scroll above the dock instead of under it.
    @State private var dockHeight: CGFloat = 0
    /// The window's width: below `panelHidesListBelow` the open settings panel hides the meetings list (G53).
    @State private var windowWidth: CGFloat = 0

    var body: some View {
        // The dock floats over the columns with a bottom inset (G-LAYOUT-1). As the second child of a VStack it took its
        // height from the columns, so starting a Moment shrank the list under the pointer.
        Group {
            if model.place == .contacts {
                contactsPanes
            } else if Self.panelHidesList(width: windowWidth, panelOpen: model.sidePanelOpen && model.detail != nil) {
                meetingWithPanel
            } else {
                panes
            }
        }
            .environment(\.meetingsDockInset, dockHeight)
            .sheet(item: Bindable(model.people).pendingAssign) { pending in
                AssignReachSheet(pending: pending, window: model)
            }
            .overlay(alignment: .bottom) {
                ZStack(alignment: .bottom) {
                    Color.clear.frame(height: 0)
                    MeetingsPlayerBar(player: model.player,
                                      title: model.player.meeting.flatMap { model.meeting($0)?.displayTitle },
                                      window: model)
                }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { dockHeight = $0 }
                .frameProbe("meetings.dock")
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.player.isActive)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { windowWidth = $0 }
            // Last, so the dock and the sheets above take the look too.
            .meetingsLook()
    }

    /// The settings panel takes 320 pt of the meeting's column (`MeetingDetailView.paneWidth`). Below this window width
    /// the three columns left the meeting about 120 pt at the 900 pt minimum, so the list steps aside while the panel is
    /// open: sidebar | meeting | panel, the meeting about 400 pt there. The sidebar's own button still hides it too.
    /// (A split view's column visibility did not hide a column in the snapshot window, so the layout is two columns.)
    static let panelHidesListBelow: CGFloat = 1320

    static func panelHidesList(width: CGFloat, panelOpen: Bool) -> Bool {
        panelOpen && width > 0 && width < panelHidesListBelow
    }

    /// Sidebar | the open meeting with the settings panel, for a window too narrow for the list beside them.
    private var meetingWithPanel: some View {
        NavigationSplitView {
            MeetingsSidebar(model: model)
                .safeAreaPadding(.bottom, dockHeight)
                .navigationSplitViewColumnWidth(min: 180, ideal: 190, max: 300)
        } detail: {
            Group {
                if let detail = model.detail {
                    MeetingDetailView(detail: detail, window: model)
                        .environment(\.meetingDetail, detail)
                        .id(detail.id)
                }
            }
            .heightFromWindow()
            // The list that takes the title out of the toolbar is not in this layout, so the meeting's header title
            // stood in the toolbar again, cut to "Backend DTO Desi…" over the sidebar.
            .modifier(NoToolbarTitle())
            .toolbar { SidePanelToolbar(model: model) }
        }
    }

    private var contactsPanes: some View {
        NavigationSplitView {
            MeetingsSidebar(model: model)
                .safeAreaPadding(.bottom, dockHeight)
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 300)
        } detail: {
            MeetingsContactsPane(people: model.people)
                .safeAreaPadding(.bottom, dockHeight)
                .heightFromWindow()
                .noticeStack(model.notices, alignment: model.noticePlace.alignment)
                .navigationTitle("People")
        }
    }

    private var panes: some View {
        NavigationSplitView {
            MeetingsSidebar(model: model)
                .safeAreaPadding(.bottom, dockHeight)
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 300)
        } content: {
            MeetingsListPane(model: model)
                .safeAreaPadding(.bottom, dockHeight)
                .heightFromWindow()
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 480)
        } detail: {
            Group {
                if let detail = model.detail {
                    MeetingDetailView(detail: detail, window: model)
                        .environment(\.meetingDetail, detail)
                        .id(detail.id)
                } else {
                    EmptyState(symbol: "person.2.wave.2", text: "Choose a meeting", detail: "Its transcript, screen and items show here.")
                }
            }
            .heightFromWindow()
            .toolbar {
                if model.detail != nil { SidePanelToolbar(model: model) }
            }
        }
        // ⌘1 Needs you, ⌘2 All meetings and ⌘R Reload are View menu items (MeetingsMenu), so they work wherever focus is.
    }
}

/// Takes the window's title out of the toolbar (macOS 15 and later); the window keeps it.
private struct NoToolbarTitle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.toolbar(removing: .title)
        } else {
            content
        }
    }
}

/// The settings panel's switch at the toolbar's trailing end, above the panel it opens. Without the flexible space
/// the toolbar put it at the leading edge of the detail column, between the list and the meeting.
private struct SidePanelToolbar: ToolbarContent {
    let model: MeetingsWindowModel

    var body: some ToolbarContent {
        if #available(macOS 26.0, *) {
            ToolbarSpacer(.flexible)
        }
        ToolbarItem(placement: .primaryAction) { SidePanelToggle(model: model) }
    }
}

/// The toolbar's switch for the settings side panel (R26): on, the panel replaces the transcript pane beside the open
/// meeting. ⌥⌘I, the key Mac apps give an inspector.
private struct SidePanelToggle: View {
    @Bindable var model: MeetingsWindowModel

    var body: some View {
        Toggle(isOn: $model.sidePanelOpen) {
            Label("Settings", systemImage: "gearshape")
        }
        .toggleStyle(.button)
        .keyboardShortcut("i", modifiers: [.command, .option])
        .instantTooltip(model.sidePanelOpen ? "Hide the settings panel (\(MeetingsSidePanel.shortcutText))"
                                            : "Show the settings panel: playback, rows, notices and panes (\(MeetingsSidePanel.shortcutText))")
        .accessibilityLabel("Settings panel")
        .accessibilityIdentifier("meetings.sidePanel.toggle")
    }
}

/// The Contacts view on the window's people model (R24): every person with where each was seen, search, add, hide,
/// merge after a confirmation that names the meetings, the source switches and the Contacts grant.
private struct MeetingsContactsPane: View {
    @Bindable var people: MeetingsPeopleModel

    var body: some View {
        let answer = people.known.value
        VStack(spacing: 0) {
            if let failure = people.known.failure {
                NoticePill(text: "The people did not load: \(failure.sentence)", more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { people.load() },
                                   failure.detailsFix { people.load() }])
                    .padding(10)
            }
            MeetingsContactsView(
                people: answer?.people ?? [], total: answer?.total, query: $people.query, showHidden: $people.showHidden,
                sources: answer?.sources ?? [], switches: people.switches, mergePlan: people.mergePlan, lastMerge: people.lastMerge,
                add: { people.add(name: $0, email: $1) },
                setHidden: { people.setHidden($0, hidden: $1) },
                requestMerge: { people.requestMerge($0, $1) },
                confirmMerge: { people.confirmMerge($0, name: $1) },
                cancelMerge: { people.mergePlan = nil },
                unmerge: { people.unmerge($0) },
                setSource: { people.setSource($0, on: $1) },
                grantContacts: { people.grantContacts() },
                showMeetings: { people.showMeetings($0) })
                .overlay {
                    if answer == nil, people.known.failure == nil {
                        VStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Reading the people…").font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.background)
                    }
                }
        }
        .onAppear { people.ensure() }
        .sheet(item: $people.history) { history in
            PersonMeetingsSheet(history: history, retry: { people.showMeetings(history.person) },
                                open: { people.openHistoryMeeting($0) }, close: { people.history = nil })
        }
    }
}

private struct MeetingsDockInsetKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    /// The playback dock's height over the window's bottom edge: a scrolling pane keeps that much room below its last
    /// row (`.safeAreaPadding(.bottom, inset)`), so nothing it lists hides under the dock.
    var meetingsDockInset: CGFloat {
        get { self[MeetingsDockInsetKey.self] }
        set { self[MeetingsDockInsetKey.self] = newValue }
    }
}

private extension View {
    /// The column is as tall as the window and never asks its content for a smallest height. The split view makes
    /// itself as tall as the tallest column's smallest height, and an error pill's wrapping sentence measures that
    /// at about one letter per line: a 222-character CLI error made the split view 3193 pt tall in an 848 pt window,
    /// centred in it, so the sidebar and the list drew only their empty middle.
    func heightFromWindow() -> some View {
        frame(minHeight: 0, maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - Sidebar

private struct MeetingsSidebar: View {
    @Bindable var model: MeetingsWindowModel
    @Environment(\.kitLook) private var look
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let overview = model.overview.value
        List(selection: Binding(get: { Optional(model.place) }, set: { place in
            // After the table view's own selection callback, so the list it reloads is not the one reporting.
            if let place { Task { @MainActor in model.go(place) } }
        })) {
            Section("Meetings") {
                row("Needs you", symbol: "exclamationmark.bubble", count: overview?.needsYou.total, place: .needs,
                    tooltip: "Meetings without a project, questions to answer and suggestions ready to confirm (⌘1)")
                row("All meetings", symbol: "calendar", count: overview?.meetings.count, place: .all,
                    tooltip: "Every meeting of the last \(Plural.count(model.days, "day")) (⌘2)")
            }
            Section("People") {
                row("All people", symbol: "person.crop.circle", count: nil, place: .contacts,
                    tooltip: "Everyone from your meetings, calendars, Contacts and the people you added: search, add, hide and merge")
            }
            Section("Projects") {
                if let overview, overview.projects.isEmpty {
                    Text("No project yet").foregroundStyle(.secondary).font(.system(size: 12))
                }
                ForEach(overview?.projects ?? [], id: \.name) { project in
                    row(project.name, symbol: "folder", count: project.meetings, place: .project(project.name),
                        tooltip: "The \(project.name) project: its rules, labels, people and meetings")
                }
            }
        }
        .listStyle(.sidebar)
    }

    private func row(_ title: String, symbol: String, count: Int?, place: MeetingsWindowModel.Place, tooltip: String) -> some View {
        HStack {
            Label(title, systemImage: symbol)
            Spacer(minLength: 4)
            if let count, count > 0 {
                Text(verbatim: "\(count)").font(.system(size: 11, weight: place == .needs ? .semibold : .regular).monospacedDigit())
                    .foregroundStyle(place == .needs && look != .classic
                                     ? (scheme == .dark ? KitHue.care.ink : KitHue.care.solid) : Color.secondary)
                    .accessibilityLabel(Plural.count(count, "meeting"))
            }
        }
        .tag(place)
        .help(tooltip)
    }
}

// MARK: - The middle column

private struct MeetingsListPane: View {
    @Bindable var model: MeetingsWindowModel

    var body: some View {
        VStack(spacing: 0) {
            if case .project(let name) = model.place {
                // A failed config read is not an empty project: the summary shows only data that was read.
                if let unread = MeetingsUnread.of([(.projectSettings, model.settings.failure)]).first {
                    NoticePill(text: unread.text, more: unread.failure.detail, tone: .error,
                               fixes: [.button("Retry", symbol: "arrow.clockwise") { model.loadSettings() },
                                       unread.failure.detailsFix { model.loadSettings() }])
                        .padding(10)
                }
                if let settings = model.settings.value {
                    ProjectSummary(name: name, settings: settings.projects[name], wispr: settings.wispr)
                }
                Divider()
            }
            if let failure = model.overview.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { model.loadOverview() },
                                   failure.detailsFix { model.loadOverview() }])
                    .padding(10)
            }
            content
        }
        // The window's title is the open meeting, so Mission Control and the Window menu name it. The toolbar does
        // not draw it: it stood over the sidebar, cut to about 20 characters, above a header that says it in full.
        .navigationTitle(openTitle ?? title)
        .modifier(NoToolbarTitle())
        .toolbar {
            ToolbarItem {
                MenuButton(items: {
                    MeetingsPreferences.dayChoices.map { days in
                        .action("Last \(days) days", checked: model.days == days) { model.show(days: days) }
                    }
                }) {
                    Label("Last \(model.days) days", systemImage: "calendar.badge.clock").labelStyle(.titleAndIcon)
                        .font(.system(size: 12))
                }
                .instantTooltip("How many days back the list reaches")
            }
        }
    }

    private var openTitle: String? {
        model.detail.map { model.meeting($0.id)?.displayTitle ?? "Meeting" }
    }

    private var title: String {
        switch model.place {
        case .needs: return "Needs you"
        case .all: return "All meetings"
        case .contacts: return "People"
        case .project(let name): return name
        }
    }

    @ViewBuilder
    private var content: some View {
        if let overview = model.overview.value {
            if model.place == .needs {
                NeedsYouList(model: model, overview: overview)
            } else if model.visibleMeetings.isEmpty {
                emptyList(overview)
            } else {
                MeetingsByDayList(model: model)
            }
        } else if model.overview.failure == nil {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reading the meetings…").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Spacer()
        }
    }

    @ViewBuilder
    private func emptyList(_ overview: MeetingsOverview) -> some View {
        let longer = MeetingsPreferences.dayChoices.first { $0 > model.days }
        if case .project(let name) = model.place {
            EmptyState(symbol: "folder", text: "No \(name) meeting in the last \(Plural.count(model.days, "day"))",
                       actionTitle: longer.map { "Show \($0) days" }) { if let longer { model.show(days: longer) } }
        } else if overview.olderMeetings == 0 {
            // A longer window cannot show a meeting when none exists, so the "Show N days" button would do nothing.
            EmptyState(symbol: "calendar", text: "No meetings yet",
                       detail: "A meeting appears here when Wispr Flow records one, or after tools meetings new.")
        } else {
            EmptyState(symbol: "calendar", text: "No meeting in the last \(Plural.count(model.days, "day"))",
                       detail: "A meeting appears here when Wispr Flow records one, or after tools meetings new.",
                       actionTitle: longer.map { "Show \($0) days" }) { if let longer { model.show(days: longer) } }
        }
    }
}

/// The meetings of the place, one section per day, newest first. Up and Down move the selection (the List's own keys).
private struct MeetingsByDayList: View {
    @Bindable var model: MeetingsWindowModel

    var body: some View {
        List(selection: Binding(get: { model.selectedMeetingID }, set: { id in Task { @MainActor in model.select(id) } })) {
            ForEach(model.meetingsByDay, id: \.day) { group in
                Section(MeetingsFormat.dayTitle(group.day)) {
                    ForEach(group.meetings) { meeting in
                        MeetingRow(meeting: meeting).equatable()
                            .tag(meeting.id)
                            .contextMenu { MeetingRowMenu(id: meeting.id, model: model) }
                    }
                }
            }
        }
        .listStyle(.inset)
    }
}

/// A meeting's own actions, in a list row's context menu and the header's "More" menu.
struct MeetingRowMenu: View {
    let id: String
    let model: MeetingsWindowModel

    var body: some View {
        Button("Open in New Window") { MeetingsWindow.openExtra(meeting: id) }
        Button("Duplicate") { model.duplicate(id) }.disabled(model.duplicating.contains(id))
        Button("Duplicate clean copy") { model.duplicate(id, withoutItems: true) }.disabled(model.duplicating.contains(id))
        Button("Rename…") {
            model.select(id)
            model.renamingMeetingID = id
        }
    }
}

/// A meeting's name in a list row. A meeting without a title reads "Untitled meeting" as a placeholder (secondary,
/// italic) in both lists: All meetings drew it grey and upright, which looked like a disabled row, and Needs you drew
/// it as a name.
struct MeetingTitleText: View {
    let meeting: OverviewMeeting

    var body: some View {
        let untitled = meeting.title.trimmingCharacters(in: .whitespaces).isEmpty
        Text(verbatim: meeting.displayTitle).font(.system(size: 13, weight: .medium)).italic(untitled).lineLimit(1)
            .foregroundStyle(untitled ? .secondary : .primary)
    }
}

/// One meeting in a list: a value row, so a publish elsewhere does not draw it again.
struct MeetingRow: View, Equatable {
    let meeting: OverviewMeeting

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                MeetingTitleText(meeting: meeting)
                Spacer(minLength: 4)
                Text(verbatim: [MeetingsFormat.time(meeting.start), MeetingsFormat.length(meeting.durationSec)]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            // Wraps to a second line in a narrow column instead of pushing the row taller with an empty band.
            WrapLayout(spacing: 5, lineSpacing: 5) {
                if let project = meeting.project {
                    Text(verbatim: project).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                ForEach(meeting.labels, id: \.self) { label in
                    Badge(label, color: KitPalette.renamed)
                }
                MeetingBadgesView(meeting: meeting)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}

/// The badges of a meeting, each a word and a colour, so the state never rests on colour alone.
struct MeetingBadgesView: View {
    let meeting: OverviewMeeting
    /// Opens the tab a badge counts (the detail's header); nil in a list row, where the row opens the meeting.
    var open: ((MeetingDetailModel.Tab) -> Void)? = nil

    var body: some View {
        let badges = meeting.badges
        if let audio = meeting.sourceAudio {
            Badge("Audio preserved", color: KitPalette.added, symbol: "waveform")
                .instantTooltip("Permanent source audio: \(audio.bytes) bytes")
                .accessibilityIdentifier("meetings.sourceAudio.preserved")
        }
        if meeting.live { Badge("Recording", color: KitPalette.removed, symbol: "record.circle") }
        // A list row only: under the header's badges the project picker says "No project" itself.
        if badges.noProject, open == nil { Badge("No project", color: KitPalette.modified) }
        if badges.openQuestions > 0 {
            badge(Badge(Plural.count(badges.openQuestions, "question"), color: KitHue.ask.ink, symbol: "ear"),
                  opens: .items, tooltip: "Answer them in Items")
        }
        if badges.unclearSpeakers > 0 {
            badge(Badge("Unclear speakers", color: KitPalette.modified, symbol: "person.fill.questionmark"),
                  opens: .speakers, tooltip: "Name them in Speakers")
        }
        if badges.recordingOnly {
            badge(Badge("Recording only", color: KitPalette.dim, symbol: "rectangle.on.rectangle"),
                  opens: .screen, tooltip: "Show the screen recording")
        }
        if badges.transcriptOnly { Badge("Transcript only", color: KitPalette.dim, symbol: "text.alignleft") }
    }

    @ViewBuilder
    private func badge(_ badge: Badge, opens tab: MeetingDetailModel.Tab, tooltip: String) -> some View {
        if let open {
            Button { open(tab) } label: { badge }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(tooltip)
        } else {
            badge
        }
    }
}

// MARK: - Needs you

private struct NeedsYouList: View {
    @Bindable var model: MeetingsWindowModel
    let overview: MeetingsOverview

    var body: some View {
        let needs = overview.needsYou
        if needs.total == 0 {
            EmptyState(symbol: "checkmark.circle", text: "Nothing needs you", detail: "Every meeting of the last \(Plural.count(model.days, "day")) has a project, and no question waits.")
        } else {
            List(selection: Binding(get: { needs.row(for: model.needsSelection) },
                                    set: { tag in Task { @MainActor in model.select(needsTag: tag) } })) {
                ForEach(needs.groups, id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.rows, id: \.id) { row in
                            if let meeting = model.meeting(row.id) {
                                NeedsRow(meeting: meeting, reason: row.reason(applyAbove: overview.applyAbove)).tag(row.tag)
                            }
                        }
                    }
                }
            }
            .listStyle(.inset)
            .safeAreaInset(edge: .top, spacing: 0) {
                if let id = model.selectedMeetingID, needs.row(for: id) == nil, let meeting = model.meeting(id) {
                    NotInPlaceNote(title: meeting.displayTitle, place: "Needs you") { model.go(.all) }
                }
            }
        }
    }
}

extension MeetingsOverview.NeedsYou {
    /// A meeting in the list, once, with everything it waits for. Listed under each need, a meeting with questions and
    /// suggestions stood twice, both rows opened the same tab, and the list had more rows than the sidebar counts.
    struct Row: Equatable {
        let id: String
        let noProject: Bool
        let questions: Int
        let suggestions: Int

        /// The selection tag: "q:<id>" and "s:<id>" open Items, a bare id opens the meeting's first tab.
        var tag: String { questions > 0 ? "q:" + id : suggestions > 0 ? "s:" + id : id }

        /// The row's second line. One need reads in full; several read short, so the line fits the column.
        func reason(applyAbove: Double) -> String {
            let above = "at \(Int(applyAbove * 100)) % or more"
            let needs = [noProject, questions > 0, suggestions > 0].filter { $0 }.count
            var parts: [String] = []
            if noProject { parts.append("Choose its project") }
            if questions > 0 { parts.append(Plural.count(questions, "question") + (needs == 1 ? " to answer by ear" : "")) }
            if suggestions > 0 { parts.append(Plural.count(suggestions, "suggestion") + (needs == 3 ? "" : " " + above)) }
            return parts.joined(separator: " · ")
        }
    }

    struct Group: Equatable {
        let title: String
        let rows: [Row]
    }

    /// The list's groups in its order. A meeting stands in the first group it belongs to.
    var groups: [Group] {
        let questionCount = Dictionary(questions.map { ($0.id, $0.count) }, uniquingKeysWith: { first, _ in first })
        let suggestionCount = Dictionary(suggestions.map { ($0.id, $0.count) }, uniquingKeysWith: { first, _ in first })
        let withoutProject = Set(noProject)
        var seen = Set<String>()
        func rows(_ ids: [String]) -> [Row] {
            ids.filter { seen.insert($0).inserted }.map {
                Row(id: $0, noProject: withoutProject.contains($0), questions: questionCount[$0] ?? 0, suggestions: suggestionCount[$0] ?? 0)
            }
        }
        return [Group(title: "Without a project", rows: rows(noProject)),
                Group(title: "Questions to answer", rows: rows(questions.map(\.id))),
                Group(title: "Ready to confirm", rows: rows(suggestions.map(\.id)))].filter { !$0.rows.isEmpty }
    }

    /// The row of the open meeting. A row is tagged "q:<id>", "s:<id>" or the bare id, and a meeting opened by its id
    /// (a link, a launch from a terminal) named none of them, so no row was selected.
    func row(for selection: String?) -> String? {
        guard let selection else { return nil }
        let tags = groups.flatMap(\.rows).map(\.tag)
        if tags.contains(selection) { return selection }
        let id = selection.hasPrefix("q:") || selection.hasPrefix("s:") ? String(selection.dropFirst(2)) : selection
        return tags.first { $0 == id || $0 == "q:" + id || $0 == "s:" + id }
    }
}

/// Above a list that does not hold the open meeting: which meeting is open, and the way to the list that has it.
private struct NotInPlaceNote: View {
    let title: String
    let place: String
    let showAll: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle").foregroundStyle(.secondary).accessibilityHidden(true)
                Text("\(title) is open; it is not in \(place).").font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 6)
                Button("Show in All meetings", action: showAll).buttonStyle(.genHoverPlain()).font(.system(size: 12))
                    .instantTooltip("Every meeting of the chosen days, with this one selected")
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            Divider()
        }
        .background(.background)
    }
}

/// A Needs you row: the meeting and what to do about it. Its tag carries the group ("q:<id>"), so the window opens
/// the tab that answers it.
private struct NeedsRow: View {
    let meeting: OverviewMeeting
    let reason: String
    @Environment(\.kitLook) private var look
    @Environment(\.colorScheme) private var scheme

    private var hue: KitHue { meeting.badges.openQuestions > 0 ? .ask : .care }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                MeetingTitleText(meeting: meeting)
                Spacer(minLength: 4)
                Text(verbatim: "\(MeetingsFormat.dayTitle(meeting.day)) \(MeetingsFormat.time(meeting.start))")
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(verbatim: reason).font(.system(size: 11.5))
                .foregroundStyle(look == .classic ? Color.secondary : (scheme == .dark ? hue.ink : hue.solid))
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - A project

/// The project's rules, labels and people above its meetings, each with a way to the Settings card that edits it.
struct ProjectSummary: View {
    let name: String
    let settings: ProjectSettings?
    let wispr: MeetingsSettings.Source?

    var body: some View {
        let rules = Self.rules(folders: wispr?.match[name]?.folders ?? [], calendars: settings?.match?.calendar?.calendars ?? [],
                               words: settings?.match?.title?.words ?? [], labels: settings?.labels ?? [])
        return VStack(alignment: .leading, spacing: 6) {
            if rules.isEmpty {
                // One sentence for a project without a rule: four lines that each said "none" pushed its meetings
                // 80 pt down and told the reader nothing.
                Text("No rule finds this project's meetings yet. A meeting joins it when you choose the project.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(rules, id: \.title) { rule in line(rule.title, rule.values) }
            // The counts take their own line: beside the two buttons they wrapped in the list's width.
            Text(verbatim: "\(Plural.count(settings?.match?.people.count ?? 0, "paired person", "paired people")) · \(Plural.count(settings?.dictionary?.entries.count ?? 0, "dictionary entry", "dictionary entries"))")
                .font(.system(size: 11.5)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                GhostButton("Edit rules…", symbol: "slider.horizontal.3", tooltip: "Open Settings → Meetings → Projects at this project",
                            identifier: "meetings.project.rules") {
                    FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.projectsPage + "#project-\(name)")
                }
                GhostButton("Dictionary…", symbol: "character.book.closed", tooltip: "Open Settings → Meetings → Dictionary",
                            identifier: "meetings.project.dictionary") {
                    FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.dictionaryPage)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    /// The rules that hold a value, in the order Settings lists them. A rule without one is left out.
    static func rules(folders: [String], calendars: [String], words: [String], labels: [String]) -> [(title: String, values: [String])] {
        [("Wispr folders", folders), ("Calendars", calendars), ("Title words", words), ("Labels", labels)]
            .filter { !$0.1.isEmpty }
            .map { (title: $0.0, values: $0.1) }
    }

    private func line(_ title: String, _ values: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.system(size: 11.5)).foregroundStyle(.secondary).frame(width: 92, alignment: .leading)
            Text(verbatim: values.joined(separator: ", ")).font(.system(size: 12)).lineLimit(2)
        }
    }
}
