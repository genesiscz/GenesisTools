import SwiftUI

/// The pane map: full-height sidebar (Needs you, All meetings, Projects) | the meetings of that place | one meeting.
struct MeetingsRootView: View {
    @Bindable var model: MeetingsWindowModel

    var body: some View {
        NavigationSplitView {
            MeetingsSidebar(model: model)
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 300)
        } content: {
            MeetingsListPane(model: model)
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 480)
        } detail: {
            if let detail = model.detail {
                MeetingDetailView(detail: detail, window: model)
                    .id(detail.id)
            } else {
                EmptyState(symbol: "person.2.wave.2", text: "Choose a meeting", detail: "Its transcript, screen and items show here.")
            }
        }
        .background(shortcuts)
    }

    /// ⌘1 Needs you, ⌘2 All meetings, ⌘R reload: hidden buttons, so the keys work wherever focus is.
    private var shortcuts: some View {
        ZStack {
            Button("Needs you") { model.go(.needs) }.keyboardShortcut("1", modifiers: .command)
            Button("All meetings") { model.go(.all) }.keyboardShortcut("2", modifiers: .command)
            Button("Reload") { model.load(); model.detail?.load() }.keyboardShortcut("r", modifiers: .command)
        }
        .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }
}

// MARK: - Sidebar

private struct MeetingsSidebar: View {
    @Bindable var model: MeetingsWindowModel

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
                Text(verbatim: "\(count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
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
                ProjectSummary(name: name, settings: model.settings.value?.projects[name], wispr: model.settings.value?.wispr)
                Divider()
            }
            if let failure = model.overview.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { model.loadOverview() }])
                    .padding(10)
            }
            content
        }
        .navigationTitle(title)
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

    private var title: String {
        switch model.place {
        case .needs: return "Needs you"
        case .all: return "All meetings"
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
                    }
                }
            }
        }
        .listStyle(.inset)
    }
}

/// One meeting in a list: a value row, so a publish elsewhere does not draw it again.
struct MeetingRow: View, Equatable {
    let meeting: OverviewMeeting

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: meeting.displayTitle).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    .foregroundStyle(meeting.title.isEmpty ? .secondary : .primary)
                Spacer(minLength: 4)
                Text(verbatim: [MeetingsFormat.time(meeting.start), MeetingsFormat.length(meeting.durationSec)]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            // Wraps to a second line in a narrow column instead of pushing the row taller with an empty band.
            ChipFlow(spacing: 5) {
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

    var body: some View {
        let badges = meeting.badges
        if meeting.live { Badge("Recording", color: KitPalette.removed, symbol: "record.circle") }
        if badges.noProject { Badge("No project", color: KitPalette.modified) }
        if badges.openQuestions > 0 { Badge(Plural.count(badges.openQuestions, "question"), color: KitPalette.renamed, symbol: "ear") }
        if badges.unclearSpeakers > 0 { Badge("Unclear speakers", color: KitPalette.modified, symbol: "person.fill.questionmark") }
        if badges.recordingOnly { Badge("Recording only", color: KitPalette.dim, symbol: "rectangle.on.rectangle") }
        if badges.transcriptOnly { Badge("Transcript only", color: KitPalette.dim, symbol: "text.alignleft") }
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
            List(selection: Binding(get: { model.needsSelection }, set: { tag in Task { @MainActor in model.select(needsTag: tag) } })) {
                if !needs.noProject.isEmpty {
                    Section("Without a project") {
                        ForEach(needs.noProject, id: \.self) { id in
                            if let meeting = model.meeting(id) {
                                NeedsRow(meeting: meeting, reason: "Choose its project").tag(id)
                            }
                        }
                    }
                }
                if !needs.questions.isEmpty {
                    Section("Questions to answer") {
                        ForEach(needs.questions, id: \.id) { entry in
                            if let meeting = model.meeting(entry.id) {
                                NeedsRow(meeting: meeting, reason: "\(Plural.count(entry.count, "question")) to answer by ear").tag("q:" + entry.id)
                            }
                        }
                    }
                }
                if !needs.suggestions.isEmpty {
                    Section("Ready to confirm") {
                        ForEach(needs.suggestions, id: \.id) { entry in
                            if let meeting = model.meeting(entry.id) {
                                NeedsRow(meeting: meeting, reason: "\(Plural.count(entry.count, "suggestion")) at \(Int(overview.applyAbove * 100)) % or more").tag("s:" + entry.id)
                            }
                        }
                    }
                }
            }
            .listStyle(.inset)
        }
    }
}

/// A Needs you row: the meeting and what to do about it. Its tag carries the group ("q:<id>"), so the window opens
/// the tab that answers it.
private struct NeedsRow: View {
    let meeting: OverviewMeeting
    let reason: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(verbatim: meeting.displayTitle).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Spacer(minLength: 4)
                Text(verbatim: "\(MeetingsFormat.dayTitle(meeting.day)) \(MeetingsFormat.time(meeting.start))")
                    .font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(verbatim: reason).font(.system(size: 11.5)).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - A project

/// The project's rules, labels and people above its meetings, each with a way to the Settings card that edits it.
private struct ProjectSummary: View {
    let name: String
    let settings: ProjectSettings?
    let wispr: MeetingsSettings.Source?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            line("Wispr folders", wispr?.match[name]?.folders ?? [])
            line("Calendars", settings?.match?.calendar?.calendars ?? [])
            line("Title words", settings?.match?.title?.words ?? [])
            line("Labels", settings?.labels ?? [])
            // The counts take their own line: beside the two buttons they wrapped in the list's width.
            Text(verbatim: "\(Plural.count(settings?.match?.people.count ?? 0, "paired person", "paired people")) · \(Plural.count(settings?.dictionary?.entries.count ?? 0, "dictionary entry", "dictionary entries"))")
                .font(.system(size: 11.5)).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button("Edit rules…") { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.projectsPage + "#project-\(name)") }
                    .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                    .instantTooltip("Open Settings → Meetings → Projects at this project")
                Button("Dictionary…") { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.dictionaryPage) }
                    .buttonStyle(.genHoverPlain()).font(.system(size: 12))
                    .instantTooltip("Open Settings → Meetings → Dictionary")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func line(_ title: String, _ values: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.system(size: 11.5)).foregroundStyle(.secondary).frame(width: 92, alignment: .leading)
            Text(verbatim: values.isEmpty ? "none" : values.joined(separator: ", "))
                .font(.system(size: 12)).foregroundStyle(values.isEmpty ? .tertiary : .primary).lineLimit(2)
        }
    }
}
