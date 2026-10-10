import SwiftUI

public struct WidgetSessionBrowser: View {
    @ObservedObject private var model: WidgetModel
    private let onOpen: ((WidgetSession) -> Void)?
    @State private var query = ""
    @State private var onlyPinned = false
    @State private var limit = 40
    @State private var expanded = Set<String>()
    @State private var collapsed = Set<String>()

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
            if groups.isEmpty && model.snapshot?.rosterLoading == true {
                ProgressView("Loading your agents…").frame(maxWidth: .infinity).padding(20)
            } else if groups.isEmpty {
                ContentUnavailableView.search(text: query).frame(maxWidth: .infinity)
            } else {
                ForEach(Array(groups.prefix(limit))) { group in
                    if group.children.isEmpty {
                        row(group.parent, title: group.parent.title, depth: 0)
                    } else {
                        GenDisclosure(isExpanded: Binding(get: {
                            if !query.isEmpty { return true }
                            if collapsed.contains(group.id) { return false }
                            return expanded.contains(group.id) || group.id == model.selectedKey
                                || group.children.contains { $0.id == model.selectedKey }
                        }, set: { value in
                            if value { expanded.insert(group.id); collapsed.remove(group.id) }
                            else { expanded.remove(group.id); collapsed.insert(group.id) }
                        }), minHeight: 34, identifier: "widget.sessions.group." + group.id) {
                            LazyVStack(spacing: 2) {
                                row(group.parent, title: "Main", depth: 0)
                                ForEach(group.children) { child in row(child.session, title: child.session.title, depth: child.depth) }
                            }.padding(.top, 6)
                        } label: {
                            AgentRosterGroupLabel(title: group.parent.title, provider: group.parent.target.provider,
                                project: group.parent.project, account: group.parent.account,
                                total: group.children.count, running: group.running,
                                live: group.parent.status == "working" || group.running > 0,
                                lastAt: Date(timeIntervalSince1970: group.parent.activityAt / 1000))
                                .padding(.vertical, 4)
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

    private func row(_ session: WidgetSession, title: String, depth: Int) -> some View {
        HStack(alignment: .top, spacing: 5) {
            Button {
                if let onOpen { onOpen(session) }
                else { model.select(session.key); model.section = "Inbox" }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    AgentRosterRow(title: title, provider: session.target.provider, role: session.role ?? "lead",
                        model: session.model, account: session.account,
                        status: session.status == "waiting" ? "waiting" : session.agentStatus ?? session.status,
                        startedAt: session.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                        lastAt: Date(timeIntervalSince1970: session.activityAt / 1000),
                        toolCalls: session.toolCalls ?? 0,
                        unread: model.inboxFor(session.key).map { $0.unread + $0.needsAnswer } ?? 0,
                        selected: session.key == model.selectedKey, showsRunningLabel: session.agentId == nil)
                    if session.hiddenByFilter {
                        Text("Hidden by widget filters").font(.caption2).foregroundStyle(.orange).padding(.leading, 15)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.buttonStyle(.genHoverRow())
                .accessibilityLabel("Open session " + session.title + ", " + session.visualStatus.label)
            Button {
                model.action(["action": "visibility", "key": .string(session.key), "pinned": .bool(!session.pinned)])
            } label: {
                Image(systemName: session.pinned ? "pin.fill" : "pin")
                    .font(.system(size: 10)).foregroundStyle(session.pinned ? Color.blue : .secondary)
                    .frame(width: 22, height: 25)
            }.buttonStyle(.genHoverPlain()).instantTooltip(session.pinned ? "Unpin from widget" : "Pin to widget")
                .accessibilityLabel((session.pinned ? "Unpin " : "Pin ") + session.title)
        }
        .padding(.leading, CGFloat(min(depth, 4)) * 12).padding(.vertical, 5).padding(.horizontal, 6)
        .background(session.key == model.selectedKey ? Color.blue.opacity(0.12) : .clear,
                    in: RoundedRectangle(cornerRadius: 9))
    }

    private func setProjects(_ projects: [String]) {
        model.action(["action": "preferences", "patch": ["projects": .array(projects.map(WidgetJSON.string))]])
    }
}
