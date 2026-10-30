import SwiftUI

public extension WidgetTasksStore {
    func taskModule() -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(
            id: "tasks", title: "Tasks", symbol: "checklist", tint: .mint,
            summary: { "\(self.activeCount) active tasks" }, visibilityChanged: { self.visibilityChanged($0) }
        ) { WidgetTasksModuleView(store: self, presentation: $0) }
    }
}

/// The Tasks module: tick a task done with one click, add one, edit or move it, all in place.
struct WidgetTasksModuleView: View {
    @ObservedObject var store: WidgetTasksStore
    let presentation: WidgetModulePresentation

    var body: some View {
        Group {
            if presentation == .compact {
                HStack(spacing: 7) {
                    Image(systemName: "checklist").foregroundStyle(.mint)
                    Text("\(store.activeCount) tasks").font(.system(size: 11, weight: .medium))
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    if presentation == .expanded {
                        WidgetTaskComposer(store: store)
                        filters
                        feedback
                        inventory
                    } else {
                        preview
                    }
                }
                // The host's own rows (Expand, the module switcher) sit 18 pt in; the module's edges line up with them.
                .padding(.horizontal, 18).padding(.vertical, 16)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks-widget")
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "checklist").foregroundStyle(.mint)
            Text("Tasks").font(.system(size: 15, weight: .semibold))
            Spacer()
            if store.isLoading { SpinningArc(color: .mint).frame(width: 13, height: 13) }
            Text("\(store.activeCount) active").font(.system(size: 10)).foregroundStyle(.secondary)
            IconButton(systemName: "arrow.clockwise", tooltip: "Refresh tasks") { store.refresh(force: true) }
                .accessibilityLabel("Refresh tasks")
        }
    }

    /// The hover preview: the first tasks, each with a working checkbox; the host's "Open Tasks" expands.
    @ViewBuilder private var preview: some View {
        if store.isLoading && store.tasks.isEmpty {
            Label("Loading your tasks…", systemImage: "ellipsis").font(.caption)
        } else if store.tasks.isEmpty {
            Text("Nothing waiting. Open Tasks to add one.").font(.caption).foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(store.tasks.prefix(4)) { task in
                HStack(spacing: 8) {
                    WidgetTaskCheckbox(task: task, state: store.shownState(task),
                                       busy: store.mutatingIDs.contains(task.id)) { store.toggle(task) }
                    Text(task.title).font(.system(size: 12)).lineLimit(1)
                        .strikethrough(store.shownState(task) == "implemented")
                        .foregroundStyle(store.shownState(task) == "implemented" ? .secondary : .primary)
                }
            }
        }
        if store.tasks.count > 4 {
            Text("\(store.tasks.count - 4) more in Tasks").font(.caption2).foregroundStyle(.secondary)
        }
        if let error = store.error {
            Text(error).font(.caption2).foregroundStyle(KitPalette.removed).lineLimit(3)
        }
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
        if let error = store.error {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(KitPalette.removed)
                Text(error).font(.system(size: 11)).foregroundStyle(KitPalette.removed).textSelection(.enabled)
                Spacer(minLength: 0)
                IconButton(systemName: "xmark", tooltip: "Dismiss this message", action: store.clearFeedback)
            }
        } else if let receipt = store.receipt {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.mint)
                Text(receipt).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                Spacer(minLength: 0)
                if let undo = store.undo {
                    Button("Undo") { store.perform(undo.action, on: undo.task, then: undo.then) }
                        .buttonStyle(.genHover()).font(.system(size: 11, weight: .medium))
                        .disabled(store.mutatingIDs.contains(undo.task.id))
                }
                IconButton(systemName: "xmark", tooltip: "Dismiss this message", action: store.clearFeedback)
            }
        }
        if store.isMutating {
            HStack(spacing: 7) {
                SpinningArc(color: .mint).frame(width: 12, height: 12)
                Text(store.mutatingIDs.count == 1 ? "Saving…" : "Saving \(store.mutatingIDs.count) tasks…")
                    .font(.caption)
                Spacer()
                Button("Stop", action: store.cancelUpdate).buttonStyle(.genHover()).font(.caption)
            }
        }
    }

    private var inventory: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if store.tasks.isEmpty && store.recent.isEmpty && !store.isLoading {
                    VStack(spacing: 10) {
                        Image(systemName: "checklist").font(.system(size: 30, weight: .light)).foregroundStyle(.mint.opacity(0.75))
                        Text(store.scope == "active" ? "Nothing waiting here" : "No tasks match this view")
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
                if store.snapshot?.truncated == true {
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
            task: task, state: store.shownState(task), busy: store.mutatingIDs.contains(task.id),
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
    @State private var showsDetails = false
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
                } else if !store.draft.title.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Add", action: store.create)
                        .buttonStyle(.genHover(accent: .mint)).font(.system(size: 11, weight: .semibold))
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("tasks.new.add")
                }
            }
            if showsDetails || !store.draft.details.isEmpty {
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
                    GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) { showsDetails = opening }
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
            store.draft.session = ""
            store.draft.sessionTitle = ""
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
    let toggle: () -> Void
    let perform: (WidgetTaskAction) -> Void
    /// The task's session is in the widget's list; asked when the menu or the details are built.
    let hasSource: () -> Bool
    let openSource: () -> Void
    let save: (WidgetTaskEditSession) -> Void
    @State private var expanded = false
    /// The open editor; nil while the row shows its title.
    @State private var edit: WidgetTaskEditSession?

    static func == (a: WidgetTaskRow, b: WidgetTaskRow) -> Bool {
        a.task == b.task && a.state == b.state && a.busy == b.busy
    }

    var body: some View {
        let _ = RenderProbe.hit("widget.tasks.row.body")
        HStack(alignment: .top, spacing: 8) {
            WidgetTaskCheckbox(task: task, state: state, busy: busy, toggle: toggle)
            VStack(alignment: .leading, spacing: 5) {
                if let edit {
                    WidgetTaskEditor(edit: edit, busy: busy, save: { save(edit) }, close: { self.edit = nil })
                } else {
                    Text(task.title).font(.system(size: 12, weight: .semibold)).lineLimit(3)
                        .strikethrough(state == "implemented" || state == "dismissed")
                        .foregroundStyle(state == "implemented" || state == "dismissed" ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 3)
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

    private func beginEdit() {
        let session = WidgetTaskEditSession()
        session.begin(task)
        edit = session
    }

    private func meta(_ state: String) -> String {
        var parts = [WidgetTask.label(for: state)]
        if task.blocking { parts.append("Blocking") }
        if let owner = task.owner, !owner.isEmpty { parts.append("For \(owner)") }
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
                    Text(cwd).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(1)
                        .truncationMode(.middle)
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
        if task.editable {
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
    let busy: Bool
    let save: () -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Title", text: $edit.title).textFieldStyle(.roundedBorder).font(.system(size: 12))
                .onSubmit(save)
            TextField("Details (optional)", text: $edit.details, axis: .vertical).textFieldStyle(.roundedBorder)
                .font(.system(size: 11.5)).lineLimit(2...6)
            HStack(spacing: 8) {
                Button("Save", action: save).buttonStyle(.genHover(accent: .mint)).font(.system(size: 11, weight: .semibold))
                    .disabled(edit.title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                Button("Cancel") { edit.cancel() }.buttonStyle(.genHoverPlain()).font(.system(size: 11))
                    .keyboardShortcut(.cancelAction)
            }
        }
        .onChange(of: edit.isOpen) { _, open in
            if !open { close() }
        }
    }
}
