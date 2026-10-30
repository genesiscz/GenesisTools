import SwiftUI

public struct WidgetSessionBrowser: View {
    @ObservedObject private var model: WidgetModel
    private let onOpen: ((WidgetSession) -> Void)?
    /// True only for the panel's Sessions tab: the session chooser popover and the settings page share the model's
    /// `sessionListOrder` and must not overwrite or clear the order of the list still on screen.
    private let reportsOrder: Bool
    @State private var query = ""
    @State private var onlyPinned = false
    @State private var limit = 40
    @State private var expanded = Set<String>()
    @State private var collapsed = Set<String>()
    @GenReduceMotion private var reduceMotion

    public init(model: WidgetModel, reportsOrder: Bool = false, onOpen: ((WidgetSession) -> Void)? = nil) {
        self.model = model
        self.reportsOrder = reportsOrder
        self.onOpen = onOpen
    }

    public var body: some View {
        let _ = RenderProbe.hit("widget.sessions")
        let groups = WidgetAgentTree.groups(model.snapshot?.sessions ?? [], query: query, onlyPinned: onlyPinned)
        // The rows in the order drawn, for the arrow keys.
        let order = groups.prefix(limit).flatMap { group in
            [group.parent.key] + (isOpen(group) ? group.children.map(\.session.key) : [])
        }
        LazyVStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find a project, session, agent or model", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 12))
                    .accessibilityIdentifier("widget.sessions.search")
                if !query.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search") { query = "" }
                        .accessibilityLabel("Clear session search")
                }
            }.padding(10).nativeGlassControl(radius: 10)
            HStack {
                projectFilter
                Spacer()
                Toggle("Pinned only", isOn: $onlyPinned).toggleStyle(.checkbox).pointerCursor()
            }.font(.system(size: 11))
            if !groups.isEmpty && model.snapshot?.rosterLoading == true {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading more agents…").font(.caption).foregroundStyle(.secondary)
                }
            }
            if groups.isEmpty && (model.snapshot == nil || model.snapshot?.rosterLoading == true) && model.error == nil {
                // No snapshot yet is a load in progress, not an empty search result.
                ProgressView("Loading your agents…").frame(maxWidth: .infinity).padding(20)
            } else if groups.isEmpty && !query.isEmpty {
                ContentUnavailableView.search(text: query).frame(maxWidth: .infinity)
            } else if groups.isEmpty {
                ContentUnavailableView(
                    onlyPinned ? "No pinned sessions" : "No sessions yet", systemImage: "rectangle.stack",
                    description: Text(onlyPinned
                        ? "Pin a session to keep it in the widget, or turn off Pinned only."
                        : "Claude, Codex and Grok sessions on this Mac appear here once an agent runs."))
                    .frame(maxWidth: .infinity)
            } else {
                ForEach(Array(groups.prefix(limit))) { group in
                    let opened = isOpen(group)
                    // Every top-level session is the same row, with or without sub-agents; a chevron folds them.
                    VStack(alignment: .leading, spacing: 2) {
                        WidgetSessionGroupRow(
                            session: group.parent, subAgents: group.children.count, running: group.running,
                            open: opened, selected: group.parent.key == model.selectedKey, unread: unread(group.parent),
                            model: model,
                            toggle: { toggle(group) }, select: { open(group.parent) }, pin: { pin(group.parent) })
                            .equatable()
                        if !group.children.isEmpty && opened {
                            LazyVStack(spacing: 2) {
                                ForEach(group.children) { child in
                                    WidgetSessionChildRow(
                                        session: child.session, depth: child.depth + 1,
                                        selected: child.session.key == model.selectedKey, unread: unread(child.session),
                                        model: model, select: { open(child.session) }, pin: { pin(child.session) })
                                        .equatable()
                                }
                            }.transition(.genReveal)
                        }
                    }
                }
                if groups.count > limit {
                    Button("Show \(min(40, groups.count - limit)) more conversations") { limit += 40 }
                        .buttonStyle(.genHover()).frame(maxWidth: .infinity)
                }
            }
        }
        .onChange(of: query) { _, _ in limit = 40 }
        .onChange(of: onlyPinned) { _, _ in limit = 40 }
        .onChange(of: order, initial: true) { _, keys in if reportsOrder { model.sessionListOrder = keys } }
        .onDisappear { if reportsOrder { model.sessionListOrder = [] } }
    }

    private var projectFilter: some View {
        // Built at the click: a SwiftUI Menu builds every project's item with each body pass.
        MenuButton(items: {
            let chosen = model.snapshot?.state.preferences.projects ?? []
            let folders = Array(Set((model.snapshot?.sessions ?? []).map { $0.target.cwd })).sorted()
            return [.action("Show every project", checked: chosen.isEmpty) { setProjects([]) }, .divider]
                + folders.map { cwd in
                    let selected = chosen.contains(cwd)
                    return .action(cwd.isEmpty ? "Unassigned" : URL(fileURLWithPath: cwd).lastPathComponent,
                                   checked: selected) {
                        var projects = model.snapshot?.state.preferences.projects ?? []
                        if selected { projects.removeAll { $0 == cwd } } else { projects.append(cwd) }
                        setProjects(projects)
                    }
                }
        }) {
            Label("Project filters", systemImage: "line.3.horizontal.decrease")
                .padding(.horizontal, 6).padding(.vertical, 3)
        }
        .instantTooltip("Show only some projects in the widget")
        .fixedSize()
    }

    private func isOpen(_ group: WidgetAgentTree.Group) -> Bool {
        if !query.isEmpty { return true }
        if collapsed.contains(group.id) { return false }
        return expanded.contains(group.id) || group.children.contains { $0.id == model.selectedKey }
    }

    private func toggle(_ group: WidgetAgentTree.Group) {
        let opening = !isOpen(group)
        GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) {
            if opening { expanded.insert(group.id); collapsed.remove(group.id) }
            else { expanded.remove(group.id); collapsed.insert(group.id) }
        }
    }

    private func open(_ session: WidgetSession) {
        if let onOpen { onOpen(session) }
        else {
            model.select(session.key)
            model.section = "Inbox"
            model.listOrigin = .sessions
        }
    }

    /// The inbox items waiting in a session, read here once: the rows observe no model.
    private func unread(_ session: WidgetSession) -> Int {
        model.inboxFor(session.key).map { $0.unread + $0.needsAnswer } ?? 0
    }

    private func pin(_ session: WidgetSession) {
        model.action(["action": "visibility", "key": .string(session.key), "pinned": .bool(!session.pinned)])
    }

    private func setProjects(_ projects: [String]) {
        model.updatePreferences(["projects": .array(projects.map(WidgetJSON.string))])
    }
}

/// A top-level session of the Sessions list, from values: its name, project, account and sub-agent count, the same for
/// every session. Its controls (the row button, the chevron and pin, the badges' tooltips) exist only while the row is
/// live (`liveRow`: hovered or selected); at rest it draws the same labels with no control, so a model publish
/// re-renders only the rows whose values changed and an accessibility client walks no buttons of the 40+ rows at rest
/// (swift skill, "Dense lists and accessibility clients"; the hub's PRs list measured step p95 540 → 54 ms,
/// 2026-10-29). VoiceOver still presses every control (`restingButton`).
struct WidgetSessionGroupRow: View, Equatable {
    let session: WidgetSession
    let subAgents: Int
    let running: Int
    /// Its sub-agents are shown.
    let open: Bool
    let selected: Bool
    let unread: Int
    /// Not observed by the row: the cmux button and the row's cmux accessibility action use it.
    let model: WidgetModel
    let toggle: () -> Void
    let select: () -> Void
    let pin: () -> Void

    static func == (a: WidgetSessionGroupRow, b: WidgetSessionGroupRow) -> Bool {
        a.session == b.session && a.subAgents == b.subAgents && a.running == b.running && a.open == b.open
            && a.selected == b.selected && a.unread == b.unread
    }

    var body: some View {
        let _ = RenderProbe.hit("widget.sessions.row.body")
        HStack(alignment: .center, spacing: 2) {
            if subAgents == 0 {
                Color.clear.frame(width: 22, height: 22)
            } else {
                WidgetSessionChevron(open: open, subAgents: subAgents, title: session.title, key: session.key,
                                     toggle: toggle)
            }
            VStack(alignment: .leading, spacing: 3) {
                AgentRosterGroupLabel(title: session.title, provider: session.target.provider,
                    project: session.project, account: session.account,
                    total: subAgents, running: running,
                    live: session.status == "working" || running > 0,
                    lastAt: Date(timeIntervalSince1970: session.activityAt / 1000),
                    unread: unread)
            }
            .modifier(WidgetHiddenByFilterMark(hidden: session.hiddenByFilter))
            .padding(.vertical, 7).padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            .rowButton(cornerRadius: 8) { select() }
            .accessibilityLabel("Open session " + session.title + ", " + session.visualStatus.label)
            WidgetSessionTrailing(model: model, session: session, pin: pin)
        }
        .padding(.horizontal, 4)
        .accessibilityAction(named: "Open cmux for " + session.title) { model.requestCmux(session.key, scope: "sessions") }
        .id(session.key)
        .background(selected ? Color.blue.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Color.blue.opacity(0.35) : .clear))
        .liveRow(selected: selected)
    }
}

/// A sub-agent (or a session shown under its parent) of the Sessions list, from values; live as
/// `WidgetSessionGroupRow` is.
struct WidgetSessionChildRow: View, Equatable {
    let session: WidgetSession
    let depth: Int
    let selected: Bool
    let unread: Int
    /// Not observed by the row: the cmux button and the row's cmux accessibility action use it.
    let model: WidgetModel
    let select: () -> Void
    let pin: () -> Void

    static func == (a: WidgetSessionChildRow, b: WidgetSessionChildRow) -> Bool {
        a.session == b.session && a.depth == b.depth && a.selected == b.selected && a.unread == b.unread
    }

    var body: some View {
        let _ = RenderProbe.hit("widget.sessions.row.body")
        HStack(alignment: .center, spacing: 2) {
            VStack(alignment: .leading, spacing: 3) {
                AgentRosterRow(title: session.title, provider: session.target.provider, role: session.role ?? "lead",
                    model: session.model, account: session.account,
                    status: session.status == "waiting" ? "waiting" : session.agentStatus ?? session.status,
                    startedAt: session.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                    lastAt: Date(timeIntervalSince1970: session.activityAt / 1000),
                    toolCalls: session.toolCalls ?? 0,
                    unread: unread,
                    selected: selected, showsRunningLabel: session.agentId == nil)
            }
            .modifier(WidgetHiddenByFilterMark(hidden: session.hiddenByFilter))
            .padding(.vertical, 6).padding(.horizontal, 6)
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            .rowButton(cornerRadius: 8) { select() }
            .accessibilityLabel("Open session " + session.title + ", " + session.visualStatus.label)
            WidgetSessionTrailing(model: model, session: session, pin: pin)
        }
        .padding(.leading, CGFloat(min(depth, 4)) * 14).padding(.trailing, 4)
        .accessibilityAction(named: "Open cmux for " + session.title) { model.requestCmux(session.key, scope: "sessions") }
        .id(session.key)
        .background(selected ? Color.blue.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Color.blue.opacity(0.35) : .clear))
        .liveRow(selected: selected)
    }
}

/// The fold chevron of a session with sub-agents: a `genHoverIcon` button with its tooltip while the row is live; at
/// rest the same glyph in the style's 3 pt padding, which VoiceOver still presses. A view of its own because the row's
/// body cannot read `rowLive`, and `LiveButton`'s plain style would drop the hover disc and the padding.
private struct WidgetSessionChevron: View {
    let open: Bool
    let subAgents: Int
    let title: String
    let key: String
    let toggle: () -> Void
    @Environment(\.rowLive) private var live

    var body: some View {
        let glyph = Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.secondary).rotationEffect(.degrees(open ? 90 : 0))
            .frame(width: 16, height: 16).contentShape(Rectangle())
        Group {
            if live {
                Button(action: toggle) { glyph }
                    .buttonStyle(.genHoverIcon(diameter: 22))
                    .instantTooltip(open ? "Hide its sub-agents" : "Show its \(Plural.count(subAgents, "sub-agent"))")
            } else {
                glyph.padding(3)
                    .restingButton(action: toggle)
            }
        }
        .accessibilityLabel((open ? "Hide sub-agents of " : "Show sub-agents of ") + title)
        .accessibilityIdentifier("widget.sessions.group." + key)
    }
}

/// cmux and pin, inside the row's own box so its selection and hover cover them. Both are buttons only on the live
/// (hovered or selected) row; at rest the pin glyph is drawn the same and VoiceOver still presses it.
private struct WidgetSessionTrailing: View {
    let model: WidgetModel
    let session: WidgetSession
    let pin: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            WidgetCmuxButton(model: model, session: session, size: 10.5, requestScope: "sessions")
            LiveButton(tooltip: session.pinned ? "Unpin from widget" : "Pin to widget", pressable: true, action: pin) {
                Image(systemName: session.pinned ? "pin.fill" : "pin")
                    .font(.system(size: 10)).foregroundStyle(session.pinned ? Color.blue : .secondary)
                    .frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .accessibilityLabel((session.pinned ? "Unpin " : "Pin ") + session.title)
        }
    }
}

/// A session the widget filters hide: dimmed, with an orange eye-slash, in the row's own height. A caption line under
/// each hidden row grew the list by a line per row the moment the first session filter was added, and the settings page
/// jumped by hundreds of points under the pointer (Martin, 2026-10-28).
struct WidgetHiddenByFilterMark: ViewModifier {
    let hidden: Bool

    func body(content: Content) -> some View {
        content
            .opacity(hidden ? 0.5 : 1)
            .overlay(alignment: .topTrailing) {
                if hidden {
                    Image(systemName: "eye.slash").font(.system(size: 10, weight: .semibold)).foregroundStyle(.orange)
                        .padding(.top, 2)
                        .instantTooltip("Hidden by widget filters")
                        .accessibilityLabel("Hidden by widget filters")
                }
            }
    }
}

