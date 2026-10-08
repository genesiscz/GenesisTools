import SwiftUI

/// Creates recipient rows only when opened; a native Picker eagerly builds every menu item.
public struct WidgetRecipientPicker: View {
    public let sessions: [WidgetSession]
    @Binding public var selection: String
    public var presentationChanged: (Bool) -> Void
    @State private var presented = false

    public init(sessions: [WidgetSession], selection: Binding<String>,
                presentationChanged: @escaping (Bool) -> Void = { _ in }) {
        self.sessions = sessions
        _selection = selection
        self.presentationChanged = presentationChanged
    }

    public var body: some View {
        Button { presented = true } label: {
            HStack(spacing: 8) {
                Text("Attach to").foregroundStyle(.secondary)
                Text(sessions.first(where: { $0.key == selection })?.title ?? "Choose a session")
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9))
            }.font(.system(size: 12)).padding(8).nativeGlassControl(radius: 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose voice note recipient")
        .accessibilityIdentifier("widget.recipient.choose")
        .popover(isPresented: $presented) {
            WidgetRecipientChoices(sessions: sessions, selectedKey: selection) { session in
                selection = session?.key ?? ""
                presented = false
            }
        }
        .onChange(of: presented) { _, value in presentationChanged(value) }
        .onDisappear { if presented { presentationChanged(false) } }
    }
}

struct WidgetRecipientChoices: View {
    let sessions: [WidgetSession]
    let selectedKey: String
    let choose: (WidgetSession?) -> Void
    @State private var query = ""
    @State private var limit = 40
    @State private var expanded = Set<String>()
    @FocusState private var searching: Bool

    var body: some View {
        let groups = WidgetAgentTree.groups(sessions, query: query)
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose a session or agent").font(.headline)
            Text("The transcript will be added to its draft. You send it separately.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Find a project, session, agent or model", text: $query)
                .textFieldStyle(.roundedBorder).focused($searching)
                .accessibilityIdentifier("widget.recipient.search")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    Button("No recipient selected") { choose(nil) }.buttonStyle(.borderless)
                    if groups.isEmpty { ContentUnavailableView.search(text: query) }
                    ForEach(Array(groups.prefix(limit))) { group in
                        if group.children.isEmpty {
                            row(group.parent, title: group.parent.title, depth: 0)
                        } else {
                            DisclosureGroup(isExpanded: Binding(get: {
                                !query.isEmpty || expanded.contains(group.id)
                            }, set: { value in
                                if value { expanded.insert(group.id) } else { expanded.remove(group.id) }
                            })) {
                                LazyVStack(alignment: .leading, spacing: 4) {
                                    row(group.parent, title: "Main", depth: 0)
                                    ForEach(group.children) { child in
                                        row(child.session, title: child.session.title, depth: child.depth)
                                    }
                                }
                            } label: {
                                AgentRosterGroupLabel(title: group.parent.title, provider: group.parent.target.provider,
                                    project: group.parent.project, account: group.parent.account,
                                    total: group.children.count, running: group.running,
                                    live: group.parent.status == "working" || group.running > 0,
                                    lastAt: Date(timeIntervalSince1970: group.parent.activityAt / 1000))
                            }
                        }
                    }
                    if groups.count > limit {
                        Button("Show \(min(40, groups.count - limit)) more conversations") { limit += 40 }
                            .buttonStyle(.genHover())
                    }
                }
            }.frame(height: 350)
        }.padding(16).frame(width: 480)
            .onChange(of: query) { _, _ in limit = 40 }
            .onAppear { searching = true }
    }

    private func row(_ session: WidgetSession, title: String, depth: Int) -> some View {
        Button { choose(session) } label: {
            AgentRosterRow(title: title, provider: session.target.provider, role: session.role ?? "lead",
                model: session.model, account: session.account,
                status: session.status == "waiting" ? "waiting" : session.agentStatus ?? session.status,
                startedAt: session.startedAt.map { Date(timeIntervalSince1970: $0 / 1000) },
                lastAt: Date(timeIntervalSince1970: session.activityAt / 1000), toolCalls: session.toolCalls ?? 0,
                unread: 0, selected: selectedKey == session.key, showsRunningLabel: session.agentId == nil)
                .frame(maxWidth: .infinity, alignment: .leading).padding(6)
        }.buttonStyle(.genHoverRow())
            .padding(.leading, CGFloat(min(depth, 4)) * 12)
            .accessibilityLabel("Choose " + session.title)
            .accessibilityIdentifier("widget.recipient." + session.key)
    }
}
