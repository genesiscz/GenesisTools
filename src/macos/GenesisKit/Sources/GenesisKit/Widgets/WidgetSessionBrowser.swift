import SwiftUI

public struct WidgetSessionBrowser: View {
    @ObservedObject private var model: WidgetModel
    private let onOpen: ((WidgetSession) -> Void)?
    @State private var query = ""
    @State private var onlyPinned = false
    @State private var limit = 40
    @State private var expanded = Set<String>()
    @State private var collapsed = Set<String>()
    @GenReduceMotion private var reduceMotion

    public init(model: WidgetModel, onOpen: ((WidgetSession) -> Void)? = nil) {
        self.model = model
        self.onOpen = onOpen
    }

    public var body: some View {
        let groups = WidgetAgentTree.groups(model.snapshot?.sessions ?? [], query: query, onlyPinned: onlyPinned)
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
                    // Every top-level session is the same row, with or without sub-agents; a chevron folds them.
                    VStack(alignment: .leading, spacing: 2) {
                        topRow(group)
                        if !group.children.isEmpty && isOpen(group) {
                            LazyVStack(spacing: 2) {
                                ForEach(group.children) { child in
                                    row(child.session, title: child.session.title, depth: child.depth + 1)
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
        else { model.select(session.key); model.section = "Inbox" }
    }

    /// A top-level session: its name, project, account and sub-agent count, the same for every session.
    private func topRow(_ group: WidgetAgentTree.Group) -> some View {
        let session = group.parent
        let selected = session.key == model.selectedKey
        return WidgetHoverRow { hovering in HStack(alignment: .center, spacing: 2) {
            if group.children.isEmpty {
                Color.clear.frame(width: 18, height: 18)
            } else {
                Button { toggle(group) } label: {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary).rotationEffect(.degrees(isOpen(group) ? 90 : 0))
                        .frame(width: 18, height: 26).contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(isOpen(group) ? "Hide its sub-agents" : "Show its \(Plural.count(group.children.count, "sub-agent"))")
                .accessibilityLabel((isOpen(group) ? "Hide sub-agents of " : "Show sub-agents of ") + session.title)
                .accessibilityIdentifier("widget.sessions.group." + group.id)
            }
            Button { open(session) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    AgentRosterGroupLabel(title: session.title, provider: session.target.provider,
                        project: session.project, account: session.account,
                        total: group.children.count, running: group.running,
                        live: session.status == "working" || group.running > 0,
                        lastAt: Date(timeIntervalSince1970: session.activityAt / 1000),
                        unread: model.inboxFor(session.key).map { $0.unread + $0.needsAnswer } ?? 0)
                    if session.hiddenByFilter {
                        Text("Hidden by widget filters").font(.caption2).foregroundStyle(.orange).padding(.leading, 31)
                    }
                }
                .padding(.vertical, 7).padding(.horizontal, 4)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 8))
            .accessibilityLabel("Open session " + session.title + ", " + session.visualStatus.label)
            trailing(session, hovering: hovering)
        } }
        .padding(.horizontal, 4)
        .background(selected ? Color.blue.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Color.blue.opacity(0.35) : .clear))
    }

    private func row(_ session: WidgetSession, title: String, depth: Int) -> some View {
        let selected = session.key == model.selectedKey
        return WidgetHoverRow { hovering in HStack(alignment: .center, spacing: 2) {
            Button { open(session) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    AgentRosterRow(title: title, provider: session.target.provider, role: session.role ?? "lead",
                        model: session.model, account: session.account,
                        status: session.status == "waiting" ? "waiting" : session.agentStatus ?? session.status,
                        startedAt: session.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                        lastAt: Date(timeIntervalSince1970: session.activityAt / 1000),
                        toolCalls: session.toolCalls ?? 0,
                        unread: model.inboxFor(session.key).map { $0.unread + $0.needsAnswer } ?? 0,
                        selected: selected, showsRunningLabel: session.agentId == nil)
                    if session.hiddenByFilter {
                        Text("Hidden by widget filters").font(.caption2).foregroundStyle(.orange).padding(.leading, 15)
                    }
                }
                .padding(.vertical, 6).padding(.horizontal, 6)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 8))
            .accessibilityLabel("Open session " + session.title + ", " + session.visualStatus.label)
            trailing(session, hovering: hovering)
        } }
        .padding(.leading, CGFloat(min(depth, 4)) * 14).padding(.trailing, 4)
        .background(selected ? Color.blue.opacity(0.13) : .clear, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Color.blue.opacity(0.35) : .clear))
    }

    /// cmux and pin, inside the row's own box so its selection and hover cover them. cmux is live only on the
    /// hovered or selected row.
    private func trailing(_ session: WidgetSession, hovering: Bool) -> some View {
        HStack(spacing: 0) {
            WidgetCmuxButton(model: model, session: session, size: 10.5,
                             live: hovering || session.key == model.selectedKey)
            Button {
                model.action(["action": "visibility", "key": .string(session.key), "pinned": .bool(!session.pinned)])
            } label: {
                Image(systemName: session.pinned ? "pin.fill" : "pin")
                    .font(.system(size: 10)).foregroundStyle(session.pinned ? Color.blue : .secondary)
                    .frame(width: 24, height: 24).contentShape(Rectangle())
            }.buttonStyle(.genHoverPlain()).instantTooltip(session.pinned ? "Unpin from widget" : "Pin to widget")
                .accessibilityLabel((session.pinned ? "Unpin " : "Pin ") + session.title)
        }
    }

    private func setProjects(_ projects: [String]) {
        model.action(["action": "preferences", "patch": ["projects": .array(projects.map(WidgetJSON.string))]])
    }
}

