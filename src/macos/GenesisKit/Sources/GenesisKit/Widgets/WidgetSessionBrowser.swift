import SwiftUI

public struct WidgetSessionBrowser: View {
    @ObservedObject private var model: WidgetModel
    private let onOpen: ((WidgetSession) -> Void)?
    @State private var query = ""
    @State private var onlyPinned = false
    @State private var grouped = true
    @State private var limit = 80

    public init(model: WidgetModel, onOpen: ((WidgetSession) -> Void)? = nil) {
        self.model = model
        self.onOpen = onOpen
    }

    private var matches: [WidgetSession] {
        (model.snapshot?.sessions ?? []).filter { session in
            (!onlyPinned || session.pinned)
                && (query.isEmpty
                    || (session.title + " " + session.project + " " + session.target.provider
                        + " " + session.target.cwd).localizedCaseInsensitiveContains(query))
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find a project, session or agent", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 12))
                    .accessibilityIdentifier("widget.sessions.search")
            }.padding(10).nativeGlassControl(radius: 10)
            HStack {
                Menu {
                    Button("Show every project") { setProjects([]) }
                    Divider()
                    ForEach(Array(Set((model.snapshot?.sessions ?? []).map { $0.target.cwd })).sorted(), id: \.self) {
                        cwd in
                        let selected = model.snapshot?.state.preferences.projects.contains(cwd) == true
                        Button {
                            var projects = model.snapshot?.state.preferences.projects ?? []
                            if selected { projects.removeAll { $0 == cwd } } else { projects.append(cwd) }
                            setProjects(projects)
                        } label: {
                            Label(
                                cwd.isEmpty ? "Unassigned" : URL(fileURLWithPath: cwd).lastPathComponent,
                                systemImage: selected ? "checkmark" : "folder")
                        }
                    }
                } label: {
                    Label("Projects", systemImage: "line.3.horizontal.decrease")
                }.menuStyle(.borderlessButton).fixedSize()
                Spacer()
                Toggle("Pinned", isOn: $onlyPinned).toggleStyle(.checkbox)
                Toggle("Group", isOn: $grouped).toggleStyle(.checkbox)
            }.font(.system(size: 11))
            Text("\(matches.count) sessions · \(model.snapshot?.state.preferences.projects.count ?? 0) project filters")
                .font(.caption2).foregroundStyle(.secondary)

            if matches.isEmpty {
                ContentUnavailableView.search(text: query).frame(maxWidth: .infinity)
            } else if grouped {
                let groups = Dictionary(grouping: Array(matches.prefix(limit)), by: \.project)
                ForEach(groups.keys.sorted(), id: \.self) { project in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Image(systemName: "folder")
                            Text(project.isEmpty ? "Unassigned" : project).lineLimit(1)
                            Spacer()
                            Text(String(groups[project]?.count ?? 0)).monospacedDigit()
                        }.font(.caption.weight(.medium)).foregroundStyle(.secondary).padding(.vertical, 5)
                        ForEach(groups[project] ?? []) { row($0) }
                    }
                }
            } else {
                ForEach(Array(matches.prefix(limit))) { row($0) }
            }
            if matches.count > limit {
                Button("Show \(min(80, matches.count - limit)) more sessions") { limit += 80 }
                    .buttonStyle(.genHover()).frame(maxWidth: .infinity)
            }
        }
        .onChange(of: query) { _, _ in limit = 80 }
        .onChange(of: onlyPinned) { _, _ in limit = 80 }
    }

    private func row(_ session: WidgetSession) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Button {
                if let onOpen {
                    onOpen(session)
                } else {
                    model.select(session.key)
                    model.section = "Inbox"
                }
            } label: {
                HStack(alignment: .top, spacing: 9) {
                    Circle().fill(session.visualStatus.color).frame(width: 7, height: 7).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(session.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                        HStack(spacing: 5) {
                            Text(session.target.provider.capitalized)
                            Text("·")
                            Text(session.visualStatus.label)
                            if session.agentId != nil { Text("· agent") }
                        }.font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                        if session.hiddenByFilter {
                            Text("Hidden by your widget filters").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                    Spacer(minLength: 0)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.genHoverRow())
            .accessibilityLabel("Open session " + session.title + ", " + session.visualStatus.label)
            Button {
                model.action(["action": "visibility", "key": .string(session.key), "pinned": .bool(!session.pinned)])
            } label: {
                Image(systemName: session.pinned ? "pin.fill" : "pin")
                    .font(.system(size: 11)).foregroundStyle(session.pinned ? Color.blue : .secondary)
                    .frame(width: 25, height: 25)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(session.pinned ? "Unpin from widget" : "Pin to widget")
            .accessibilityLabel((session.pinned ? "Unpin " : "Pin ") + session.title)
        }
        .padding(.vertical, 6).padding(.horizontal, 7)
        .background(
            session.key == model.selectedKey ? Color.blue.opacity(0.12) : .clear,
            in: RoundedRectangle(cornerRadius: 10))
    }

    private func setProjects(_ projects: [String]) {
        model.action(["action": "preferences", "patch": ["projects": .array(projects.map(WidgetJSON.string))]])
    }
}
