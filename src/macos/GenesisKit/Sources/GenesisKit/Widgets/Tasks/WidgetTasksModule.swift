import SwiftUI

public extension WidgetTasksStore {
    func taskModule(handoffs: @escaping () -> WidgetHandoffDisplay = { .folded },
                    showTaskTooltips: @escaping () -> Bool = { true },
                    openHandoffSettings: (() -> Void)? = nil) -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(
            id: "tasks", title: "Tasks", symbol: "checklist", tint: .mint,
            summary: { self.snapshot == nil ? "Tasks" : Plural.count(self.activeCount, "active task") },
            visibilityChanged: { self.visibilityChanged($0) }
        ) { WidgetTasksModuleView(store: self, presentation: $0, handoffDisplay: handoffs(),
                                  showTaskTooltips: showTaskTooltips(), openHandoffSettings: openHandoffSettings) }
    }
}

/// The Tasks module: tick a task done with one click, add one, edit or move it, all in place.
struct WidgetTasksModuleView: View {
    @ObservedObject var store: WidgetTasksStore
    let presentation: WidgetModulePresentation
    var handoffDisplay: WidgetHandoffDisplay = .folded
    var showTaskTooltips = true
    var openHandoffSettings: (() -> Void)?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            if presentation == .compact {
                HStack(spacing: 7) {
                    Image(systemName: "checklist").foregroundStyle(.mint)
                    Text(store.snapshot == nil ? "Tasks" : Plural.count(store.activeCount, "active task")).font(.system(size: 11, weight: .medium))
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    if presentation == .expanded {
                        WidgetTaskComposer(store: store)
                        filters
                        inventory
                    } else {
                        workLine
                        handoffSection
                        preview
                    }
                    Button {
                        let destination = store.project.isEmpty ? WidgetWorkLink.destination(nil) : WidgetWorkLink.project(store.project)
                        openURL(destination) { opened in
                            if !opened { CopyToast.post(title: "Could not open Work", detail: "GenesisTools hub", style: .problem) }
                        }
                    } label: {
                        Label("Open Work", systemImage: "arrow.up.forward.square")
                            .font(.caption.weight(.medium)).frame(minHeight: 26)
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(store.project.isEmpty ? "Open the Work screen" : "Open \(store.project) in Work")
                    .accessibilityIdentifier("tasks.open-work")
                }
                // The host's own rows (Expand, the module switcher) sit 18 pt in; the module's edges line up with them.
                .padding(.horizontal, 18).padding(.vertical, 16)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks-widget")
        .taskResumePrompt(store, active: presentation == .expanded)
    }

    @ViewBuilder private var handoffSection: some View {
        if handoffDisplay != .hidden, let handoffs = store.claimedHandoffs,
           presentation == .expanded || !handoffs.isEmpty {
            WidgetClaimedHandoffSection(handoffs: handoffs, initiallyExpanded: handoffDisplay == .expanded,
                                        showTooltip: showTaskTooltips)
                .id(handoffDisplay)
        }
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "checklist").foregroundStyle(.mint)
            Text("Tasks").font(.system(size: 15, weight: .semibold))
            Spacer()
            if store.snapshot != nil {
                Text(Plural.count(store.activeCount, "active to-do") + (store.project.isEmpty && store.session.isEmpty ? "" : " overall"))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .instantTooltip("Open and in-progress to-dos across projects and sessions. Handoff tasks are counted in their handoff.")
            }
            if let openHandoffSettings {
                IconButton(systemName: "gearshape", tooltip: "Tasks settings", action: openHandoffSettings)
                    .accessibilityLabel("Claimed handoff settings")
                    .accessibilityHint("Opens Tasks settings, including tooltips")
            }
            IconButton(systemName: "arrow.clockwise", tooltip: "Refresh tasks") { store.refresh(force: true) }
                .opacity(store.isLoading ? 0 : 1)
                .disabled(store.isLoading)
                .overlay {
                    if store.isLoading { SpinningArc(color: .mint).frame(width: 13, height: 13).allowsHitTesting(false) }
                }
                .accessibilityLabel("Refresh tasks")
        }
    }

    /// The work store's counts (P8): one quiet line per project with items spotted, reopened or held.
    @ViewBuilder private var workLine: some View {
        let counts = store.workCounts
        if !counts.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(counts) { count in
                    Button {
                        openURL(WidgetWorkLink.project(count.project)) { opened in
                            if !opened { CopyToast.post(title: "Could not open Work", detail: count.project, style: .problem) }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "tray.full").foregroundStyle(.secondary).imageScale(.small)
                            Text(count.project).font(.system(size: 11, weight: .medium)).lineLimit(2)
                            Text(count.summary).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.forward").imageScale(.small).foregroundStyle(.secondary)
                        }
                        .frame(minHeight: 24).contentShape(Rectangle())
                    }
                    .buttonStyle(RowButtonStyle())
                    .instantTooltip("Open \(count.project) in Work\n\(count.summary)")
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(count.project): \(count.summary)")
                    .accessibilityHint("Opens this project in Work")
                }
            }
            .accessibilityIdentifier("tasks-work-counts")
        }
    }

    /// The hover preview: the first tasks, each with a working checkbox; the host's "Open Tasks" expands.
    @ViewBuilder private var preview: some View {
        if store.isLoading && store.tasks.isEmpty {
            Label("Loading your tasks…", systemImage: "ellipsis").font(.caption)
        } else if store.hasCurrentList && store.tasks.isEmpty && !hasShownHandoffs && store.error == nil {
            Text(store.scope == "active" ? "No active to-dos in this view." : "No to-dos match this view.").font(.caption).foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(store.tasks.prefix(4)) { task in
                HStack(spacing: 8) {
                    WidgetTaskCheckbox(task: task, state: store.shownState(task),
                                       busy: store.mutatingIDs.contains(task.id)) { store.toggle(task) }
                    WidgetWorkButton(item: WidgetWorkLink(task), showTooltip: showTaskTooltips) {
                        Text(task.title).font(.system(size: 12)).lineLimit(1)
                            .strikethrough(store.shownState(task) == "implemented")
                            .foregroundStyle(store.shownState(task) == "implemented" ? .secondary : .primary)
                    }
                }
            }
        }
        if store.remainingPreviewCount > 0 {
            Text("\(store.remainingPreviewCount) more in Tasks").font(.caption2).foregroundStyle(.secondary)
        }
        feedback
    }

    private var hasShownHandoffs: Bool {
        handoffDisplay != .hidden && store.claimedHandoffs?.isEmpty == false
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 8) {
            GenSegmentedTabs("Task status", items: [
                .init("active", "Active"), .init("completed", "Completed"),
                .init("dismissed", "Dismissed"), .init("all", "All"),
            ], selection: $store.scope, minSegmentWidth: 64)
            HStack(spacing: 10) {
                MenuButton(items: {
                    [.action("All projects", checked: store.project.isEmpty) { store.project = "" }, .divider]
                        + store.projects.map { name in
                            .action(name, checked: store.project == name) { store.project = name }
                        }
                }) {
                    Label(store.project.isEmpty ? "All projects" : store.project, systemImage: "folder")
                        .lineLimit(1).padding(.horizontal, 6).padding(.vertical, 3)
                }
                .instantTooltip("Show the tasks of one project")
                MenuButton(items: {
                    [.action("All sessions", checked: store.session.isEmpty) { store.session = "" }, .divider]
                        + store.sessionFilters.map { entry in
                            .action(entry.title, checked: store.session == entry.id) { store.session = entry.id }
                        }
                }) {
                    Label(store.sessionFilters.first(where: { $0.id == store.session })?.title ?? "All sessions",
                          systemImage: "bubble.left.and.bubble.right")
                        .lineLimit(1).padding(.horizontal, 6).padding(.vertical, 3)
                }
                .instantTooltip("Show the tasks of one session")
                Spacer(minLength: 0)
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var feedback: some View {
        ForEach(store.failures) { failure in failureRow(failure) }
        if let receipt = store.receipt {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.mint)
                Text(receipt).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
                if let undo = store.undo {
                    Button("Undo") { store.perform(undo.action, on: undo.task, then: undo.then) }
                        .buttonStyle(.genHover()).font(.system(size: 11, weight: .medium))
                        .disabled(store.mutatingIDs.contains(undo.task.id))
                }
                IconButton(systemName: "xmark", tooltip: "Dismiss this message", action: store.dismissReceipt)
            }
        }
        if store.isMutating {
            HStack(spacing: 7) {
                SpinningArc(color: .mint).frame(width: 12, height: 12)
                Text(store.mutationProgress)
                    .font(.caption)
                Spacer()
                Button(store.mutatingIDs.count > 1 ? "Stop all" : "Stop", action: store.cancelUpdate).buttonStyle(.genHover()).font(.caption)
            }
        }
    }

    private func failureRow(_ failure: WidgetTaskFailure) -> some View {
        let retry: (@MainActor () -> Void)?
        if failure.id == .list { retry = { store.refresh(force: true) } } else { retry = nil }
        return HStack(alignment: .top, spacing: 6) {
            FailureInline(failure.report, form: .compact, identifier: "widget.tasks.failure", retry: retry)
            IconButton(systemName: "xmark", tooltip: "Dismiss this message") { store.clearFailure(failure.id) }
        }
    }

    private var inventory: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                feedback
                workLine
                handoffSection
                if store.hasCurrentList && store.tasks.isEmpty && store.recent.isEmpty && !store.isLoading && !hasShownHandoffs && store.error == nil {
                    VStack(spacing: 10) {
                        Image(systemName: "checklist").font(.system(size: 30, weight: .light)).foregroundStyle(.mint.opacity(0.75))
                        Text(store.scope == "active" ? "No active to-dos in this view" : "No to-dos match this view")
                            .font(.system(size: 13, weight: .medium))
                        Text(store.scope == "active"
                             ? "Add one above, or ask an agent to post a TODO. Both land here."
                             : "Try another project, session or status.")
                            .font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.frame(maxWidth: .infinity).padding(.vertical, 30)
                }
                ForEach(store.tasks) { task in row(task).equatable() }
                if !store.recent.isEmpty {
                    Text("Just changed · click the box to undo").font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary).padding(.top, 4)
                    ForEach(store.recent) { task in row(task).equatable() }
                }
                if store.hasCurrentList && store.snapshot?.truncated == true {
                    Text("Showing \(store.tasks.count) of \(store.snapshot?.total ?? 0) matching tasks. Narrow the filters to see more.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .scrollOverflowContent()
        }
        .scrollOverflowHints()
    }

    /// One task as values: the row observes no store, so a publish re-renders only the rows whose task, shown state
    /// or busy flag changed.
    private func row(_ task: WidgetTask) -> WidgetTaskRow {
        WidgetTaskRow(
            task: task, state: store.shownState(task), busy: store.mutatingIDs.contains(task.id), showTooltip: showTaskTooltips,
            edit: store.editSessions[task.id], beginEdit: { store.beginEditing(task) },
            toggle: { store.toggle(task) }, perform: { store.perform($0, on: task) },
            hasSource: { store.sourceSession(for: task) != nil }, openSource: { store.openSource(task) },
            save: { session in session.save(in: store) })
    }
}

/// The one-click tick: an unfinished task becomes done, a finished one opens again. The new state shows at once. A
/// `genHoverIcon` button with its tooltip only while its row is live (`rowLive`); at rest the same glyph in the style's
/// padding, which VoiceOver still presses. Not a `LiveButton`: its plain style would drop the mint hover disc and the
/// 3 pt padding, and the glyph would move when the row turns live.
struct WidgetTaskCheckbox: View {
    let task: WidgetTask
    /// `WidgetTasksStore.shownState(task)`.
    let state: String
    /// A change of this task is in flight.
    let busy: Bool
    let toggle: () -> Void
    @Environment(\.rowLive) private var live

    var body: some View {
        let enabled = !busy && task.toggleAction != nil
        let glyph = Image(systemName: symbol(state))
            .font(.system(size: 15, weight: .regular))
            .foregroundStyle(color(state))
            .opacity(busy ? 0.55 : 1)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        Group {
            if live {
                Button(action: toggle) { glyph }
                    .buttonStyle(.genHoverIcon(accent: .mint, diameter: 24))
                    .disabled(!enabled)
                    .instantTooltip(task.toggleAction == .reopen ? "Open this task again" : "Mark this task done")
            } else {
                // `genHoverIcon`'s 3 pt padding and its disabled dimming, without the button.
                glyph.padding(3).opacity(enabled ? 1 : 0.4)
                    .restingButton(enabled: enabled, action: toggle)
            }
        }
        .accessibilityLabel((task.toggleAction == .reopen ? "Reopen " : "Mark done: ") + task.title)
        .accessibilityValue(task.statusLabel)
        .accessibilityIdentifier("tasks.toggle." + task.id)
    }

    private func symbol(_ state: String) -> String {
        switch state {
        case "implemented": return "checkmark.circle.fill"
        case "dismissed": return "minus.circle"
        case "acknowledged": return "circle.lefthalf.filled"
        default: return task.blocking ? "exclamationmark.circle" : "circle"
        }
    }

    private func color(_ state: String) -> Color {
        switch state {
        case "implemented": return .mint
        case "dismissed": return .secondary
        default: return task.blocking ? .orange : .white.opacity(0.7)
        }
    }
}

/// The add field: a title and Return is enough; details, session and project are optional.
private struct WidgetTaskComposer: View {
    @ObservedObject var store: WidgetTasksStore
    @FocusState private var focused: Bool
    @State private var detailsChoice: Bool?
    private var showsDetails: Bool { detailsChoice ?? !store.draft.details.isEmpty }
    @GenReduceMotion private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle").foregroundStyle(.mint).font(.system(size: 14))
                TextField("Add a task…", text: $store.draft.title)
                    .textFieldStyle(.plain).font(.system(size: 12.5)).focused($focused)
                    .onSubmit(store.create)
                    .accessibilityIdentifier("tasks.new.title")
                if store.isCreating {
                    SpinningArc(color: .mint).frame(width: 12, height: 12)
                    Text("Adding…").font(.caption)
                    Button("Stop waiting", action: store.stopWaitingForCreate)
                        .buttonStyle(.genHoverPlain()).font(.caption).frame(minHeight: 22)
                } else if !store.draft.title.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Add", action: store.create)
                        .buttonStyle(.genHover(accent: .mint)).font(.system(size: 11, weight: .semibold))
                        .accessibilityIdentifier("tasks.new.add")
                }
            }
            if showsDetails {
                TextField("Details (optional)", text: $store.draft.details, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 11.5)).lineLimit(1...5)
                    .padding(.leading, 22)
                    .transition(.genReveal)
            }
            HStack(spacing: 10) {
                MenuButton(items: sessionItems) {
                    Label(store.draft.session.isEmpty ? "Local task" : store.draft.sessionTitle,
                          systemImage: store.draft.session.isEmpty ? "tray" : "bubble.left.and.bubble.right")
                        .lineLimit(1).padding(.horizontal, 6).padding(.vertical, 3)
                }
                .instantTooltip("The session this task belongs to")
                MenuButton(items: projectItems) {
                    Label(store.draft.project.isEmpty ? "No project" : store.draft.project, systemImage: "folder")
                        .lineLimit(1).padding(.horizontal, 6).padding(.vertical, 3)
                }
                .instantTooltip("The project this task files under")
                Button(showsDetails ? "Hide details" : "Details…") {
                    let opening = !showsDetails
                    GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) { detailsChoice = opening }
                }
                    .buttonStyle(.genHoverPlain()).padding(.horizontal, 6).padding(.vertical, 3)
                Spacer(minLength: 0)
            }
            .font(.system(size: 11)).foregroundStyle(.secondary).padding(.leading, 16)
        }
        .padding(10)
        .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(.mint.opacity(focused ? 0.45 : 0), lineWidth: 1))
    }

    private func sessionItems() -> [MenuButtonItem] {
        let choices = store.sessionChoices()
        return [.action("Local task (no session)", checked: store.draft.session.isEmpty) {
            store.chooseLocalTask()
        }, .divider] + (choices.isEmpty ? [.note("No recent sessions")] : choices.map { choice in
            .action(choice.title, checked: store.draft.session == choice.id) { store.chooseSession(choice) }
        })
    }

    private func projectItems() -> [MenuButtonItem] {
        [.action("No project", checked: store.draft.project.isEmpty) {
            store.draft.project = ""
            store.draft.cwd = ""
        }, .divider] + store.projects.map { name in
            .action(name, checked: store.draft.project == name) {
                store.draft.project = name
                store.draft.cwd = ""
            }
        }
    }
}

/// One task of the list, from values. Its controls (the checkbox, the Details disclosure, the actions menu and their
/// tooltips) exist only while it is live (`liveRow`: hovered, its details open, or its editor open). At rest it draws
/// the same glyphs and text with no control, so a store publish re-renders only the rows whose values changed and an
/// accessibility client walks no buttons of up to 200 rows at rest (swift skill, "Dense lists and accessibility
/// clients"). VoiceOver still presses each of them (`restingButton`). The editor's session is made when Edit… is
/// picked: a `@StateObject` per row made one observable object per task for editors that were almost never opened.
private struct WidgetTaskRow: View, Equatable {
    let task: WidgetTask
    /// `WidgetTasksStore.shownState(task)`: a tick shows before the ledger confirms it.
    let state: String
    /// A change of this task is in flight.
    let busy: Bool
    let showTooltip: Bool
    let edit: WidgetTaskEditSession?
    let beginEdit: () -> Void
    let toggle: () -> Void
    let perform: (WidgetTaskAction) -> Void
    /// The task's session is in the widget's list; asked when the menu or the details are built.
    let hasSource: () -> Bool
    let openSource: () -> Void
    let save: (WidgetTaskEditSession) -> Void
    @State private var expanded = false

    static func == (a: WidgetTaskRow, b: WidgetTaskRow) -> Bool {
        a.task == b.task && a.state == b.state && a.busy == b.busy && a.showTooltip == b.showTooltip && a.edit === b.edit
    }

    var body: some View {
        let _ = RenderProbe.hit("widget.tasks.row.body")
        HStack(alignment: .top, spacing: 8) {
            WidgetTaskCheckbox(task: task, state: state, busy: busy, toggle: toggle)
            VStack(alignment: .leading, spacing: 5) {
                if let edit {
                    WidgetTaskEditor(edit: edit, current: task, busy: busy, save: { save(edit) })
                } else {
                    WidgetWorkButton(item: WidgetWorkLink(task), showTooltip: showTooltip) {
                        Text(task.title).font(.system(size: 12, weight: .semibold)).lineLimit(3)
                            .strikethrough(state == "implemented" || state == "dismissed")
                            .foregroundStyle(state == "implemented" || state == "dismissed" ? .secondary : .primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Text(meta(state)).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                WidgetTaskDetailsDisclosure(expanded: $expanded, identifier: "tasks.details." + task.id) { details }
                    .font(.system(size: 10.5))
            }
            Spacer(minLength: 0)
            MenuButton(style: .genHoverIcon(), items: menuItems) {
                Image(systemName: "ellipsis").font(.system(size: 12, weight: .medium)).frame(width: 18, height: 18)
                    .modifier(WidgetRestingIconPadding())
            }
            .instantTooltip("More actions")
            .disabled(busy)
            .accessibilityLabel("Actions for \(task.title)")
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
        .accessibilityElement(children: .contain)
        .liveRow(selected: expanded || edit != nil)
    }

    private func meta(_ state: String) -> String {
        var parts = [WidgetTask.label(for: state)]
        if task.blocking { parts.append("Blocking") }
        parts.append(task.addressee)
        if let project = task.sourceContext.project ?? task.sourceContext.cwd.map({ ($0 as NSString).lastPathComponent }) {
            parts.append(project)
        } else if task.isLocal {
            parts.append("Local")
        }
        if let branch = task.sourceContext.branch { parts.append(branch) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            if task.summary != task.title {
                WidgetMarkdown(text: task.summary)
            }
            if task.truncated {
                Text("Excerpt shown. Open the source session for the full task.").font(.caption2).foregroundStyle(.secondary)
            }
            if task.isLocal {
                Text("Written in the widget").font(.caption2).foregroundStyle(.secondary)
            } else {
                Text([task.provider.capitalized, task.sessionTitle ?? "Untitled session", task.sourceContext.aiAgent]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                if let cwd = task.sourceContext.cwd {
                    PathLabel(path: cwd, font: .caption2, showIcons: false)
                }
                if hasSource() {
                    Button("Open source session", action: openSource).buttonStyle(.genHoverPlain())
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(SessionPalette.blue)
                } else {
                    Text("The source session is not in the widget's list.").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func menuItems() -> [MenuButtonItem] {
        var items: [MenuButtonItem] = task.actions.map { action in
            .action(action == .acknowledge ? "Start" : action.title) { perform(action) }
        }
        if task.editable && edit == nil {
            items += [.divider, .action("Edit…") { beginEdit() }]
        }
        if hasSource() {
            items += [.divider, .action("Open source session") { openSource() }]
        }
        return items.isEmpty ? [.note("No actions for this task")] : items
    }
}

/// The task's Details: `GenDisclosure` while the row is live (`rowLive`); at rest (always closed, since an open one
/// keeps the row live) its closed header drawn the same (chevron, title, the full-width row), which VoiceOver still
/// opens. A view of its own because the row's body cannot read `rowLive` and `GenDisclosure` does not read it.
private struct WidgetTaskDetailsDisclosure<Content: View>: View {
    @Binding var expanded: Bool
    let identifier: String
    @ViewBuilder let content: () -> Content
    @Environment(\.rowLive) private var live
    @GenReduceMotion private var reduceMotion
    @Environment(\.genExpansionHost) private var host

    var body: some View {
        if live {
            GenDisclosure("Details", isExpanded: $expanded, minHeight: 22, identifier: identifier) { content() }
        } else {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary).frame(width: 10)
                Text("Details")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, minHeight: 22, alignment: .leading)
            .contentShape(Rectangle())
            .restingButton {
                host?.willChange(true)
                GenMotion.perform(expanding: true, reduceMotion: reduceMotion) { expanded = true }
            }
            .accessibilityLabel("Details")
            .accessibilityValue("Collapsed")
            .accessibilityIdentifier(identifier)
        }
    }
}

/// `genHoverIcon`'s 3 pt padding and disabled dimming for a label that `MenuButton` draws bare in a resting row, so the
/// glyph does not move by 3 pt when its row turns live.
private struct WidgetRestingIconPadding: ViewModifier {
    @Environment(\.rowLive) private var live
    @Environment(\.isEnabled) private var enabled

    func body(content: Content) -> some View {
        if live {
            content
        } else {
            content.padding(3).opacity(enabled ? 1 : 0.4)
        }
    }
}

/// A task row's open editor. Save sends through the row's store; the session closes itself on the ledger's
/// confirmation or Cancel, and the row then drops it. It observes the session, so only an open editor does.
private struct WidgetTaskEditor: View {
    @ObservedObject var edit: WidgetTaskEditSession
    let current: WidgetTask
    let busy: Bool
    let save: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Title", text: $edit.title).textFieldStyle(.roundedBorder).font(.system(size: 12))
                .focused($focused)
                .onSubmit { if canSave { save() } }
            TextField("Details (optional)", text: $edit.details, axis: .vertical).textFieldStyle(.roundedBorder)
                .font(.system(size: 11.5)).lineLimit(2...6)
            if edit.needsReview(current) {
                Text("This task changed while you were editing.").font(.caption.weight(.medium))
                Text(verbatim: current.fullTitle ?? current.title).font(.caption).textSelection(.enabled)
                if current.summary != current.title {
                    Text(verbatim: current.fullText ?? current.summary).font(.caption).textSelection(.enabled)
                }
                if current.editable {
                    Button("Keep my draft against this version") { edit.useReviewedVersion(current) }
                        .buttonStyle(.genHoverPlain()).disabled(busy)
                } else {
                    Text("Its \(current.statusLabel.lowercased()) state prevents editing. You can still copy your draft.").font(.caption)
                }
            }
            HStack(spacing: 8) {
                Button("Save", action: save).buttonStyle(.genHover(accent: .mint)).font(.system(size: 11, weight: .semibold))
                    .disabled(!canSave)
                Button("Cancel") { edit.cancel() }.buttonStyle(.genHoverPlain()).font(.system(size: 11))
                    .disabled(busy)
                    .instantTooltip(busy ? "Wait for this save or stop it above." : "Discard the unsaved draft")
            }
        }
        .onAppear { focused = true }
        .onExitCommand { if !busy { edit.cancel() } }
    }

    private var canSave: Bool {
        !busy && current.editable && !edit.needsReview(current) && !edit.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public extension View {
    /// A user chooses whether to reopen the session before the task goes to its receiver.
    func taskResumePrompt(_ store: WidgetTasksStore, active: Bool = true, taskID: String? = nil) -> some View {
        modifier(WidgetTaskResumePrompt(store: store, active: active, taskID: taskID))
    }
}

private struct WidgetTaskResumePrompt: ViewModifier {
    @ObservedObject var store: WidgetTasksStore
    let active: Bool
    let taskID: String?
    @State private var failure: String?

    func body(content: Content) -> some View {
        content.confirmationDialog("Resume the session to send this task?", isPresented: Binding(
            get: { active && store.resumeRequest != nil && (taskID == nil || store.resumeRequest?.id == taskID) },
            set: { if !$0 { store.resumeRequest = nil } }
        ), presenting: store.resumeRequest) { task in
            Button("Resume in a new cmux workspace and send") {
                guard let command = CmuxCommandRunner.resumeCommand(provider: task.provider, sessionId: task.sessionId) else {
                    failure = "Cannot resume this session's provider."
                    return
                }
                Task {
                    let reason = await Task.detached(priority: .userInitiated) {
                        CmuxCommandRunner.run(command, cwd: task.sourceContext.cwd ?? "",
                                              name: task.sessionTitle ?? task.sessionId, at: .newWorkspace(window: nil))
                    }.value
                    if let reason { failure = reason }
                    else { store.perform(.send, on: task, afterResume: true) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { task in Text(task.title) }
        .alert("Could not resume the session", isPresented: Binding(
            get: { failure != nil }, set: { if !$0 { failure = nil } }
        )) { Button("OK") { failure = nil } } message: { Text(failure ?? "") }
    }
}
