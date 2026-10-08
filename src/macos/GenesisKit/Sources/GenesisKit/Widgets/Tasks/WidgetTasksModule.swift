import SwiftUI

public extension WidgetTasksStore {
    func taskModule() -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(
            id: "tasks", title: "Tasks", symbol: "checklist", tint: .mint,
            summary: { "\(self.activeCount) active tasks" }, visibilityChanged: { self.visibilityChanged($0) }
        ) { WidgetTasksModuleView(store: self, presentation: $0) }
    }
}

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
                        filters
                        feedback
                        inventory
                    } else {
                        if store.isLoading && store.tasks.isEmpty {
                            Label("Loading your tasks…", systemImage: "ellipsis").font(.caption)
                        } else if store.tasks.isEmpty {
                            Text("No tasks in this view.").font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(store.tasks.prefix(3)) { task in
                            HStack(spacing: 8) {
                                Image(systemName: task.blocking ? "exclamationmark.circle" : "circle")
                                    .foregroundStyle(task.blocking ? Color.orange : Color.secondary)
                                Text(task.title).font(.system(size: 12)).lineLimit(1)
                            }
                        }
                        Text("Click to manage your local tasks.").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .padding(16)
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
            Button { store.refresh(force: true) } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).help("Refresh tasks").accessibilityLabel("Refresh tasks")
        }
    }

    private var filters: some View {
        VStack(spacing: 8) {
            Picker("Status", selection: $store.scope) {
                Text("Active").tag("active")
                Text("Completed").tag("completed")
                Text("Dismissed").tag("dismissed")
                Text("All").tag("all")
            }.pickerStyle(.segmented)
            HStack(spacing: 8) {
                Menu {
                    Button("All projects") { store.project = "" }
                    Divider()
                    ForEach(store.snapshot?.projects ?? [], id: \.self) { project in
                        Button(project) { store.project = project }
                    }
                } label: {
                    Label(store.project.isEmpty ? "All projects" : store.project, systemImage: "folder")
                        .lineLimit(1)
                }
                Menu {
                    Button("All sessions") { store.session = "" }
                    Divider()
                    ForEach(store.snapshot?.sessions ?? []) { session in
                        Button(session.title) { store.session = session.id }
                    }
                } label: {
                    Label(store.session.isEmpty ? "All sessions" : "Selected session", systemImage: "bubble.left.and.bubble.right")
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .menuStyle(.borderlessButton).font(.system(size: 11))
        }
    }

    @ViewBuilder private var feedback: some View {
        if let error = store.error {
            HStack(alignment: .top, spacing: 8) {
                Text(error).font(.system(size: 11)).foregroundStyle(KitPalette.removed).textSelection(.enabled)
                Spacer(minLength: 0)
                Button(action: store.clearFeedback) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).accessibilityLabel("Dismiss task message")
            }
        } else if let receipt = store.receipt {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.mint)
                Text(receipt).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(3)
                Spacer(minLength: 0)
                Button(action: store.clearFeedback) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).accessibilityLabel("Dismiss saved receipt")
            }
        }
        if store.isMutating {
            HStack(spacing: 7) {
                SpinningArc(color: .mint).frame(width: 12, height: 12)
                Text("Saving task status…").font(.caption)
                Spacer()
                Button("Stop", action: store.cancelUpdate).buttonStyle(.borderless)
            }
        }
    }

    private var inventory: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 9) {
                if store.tasks.isEmpty && !store.isLoading {
                    VStack(spacing: 10) {
                        Image(systemName: "checklist").font(.system(size: 30, weight: .light)).foregroundStyle(.mint.opacity(0.75))
                        Text(store.scope == "active" ? "Nothing waiting here" : "No tasks match this view")
                            .font(.system(size: 13, weight: .medium))
                        Text("Tasks come from the existing Decisions TODO ledger. Try another project, session or status.")
                            .font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.frame(maxWidth: .infinity).padding(.vertical, 34)
                }
                ForEach(store.tasks) { task in WidgetTaskRow(task: task, store: store) }
                if store.snapshot?.truncated == true {
                    Text("Showing \(store.tasks.count) of \(store.snapshot?.total ?? 0) matching tasks. Narrow the filters to see more.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct WidgetTaskRow: View {
    let task: WidgetTask
    @ObservedObject var store: WidgetTasksStore
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: task.state == "implemented" ? "checkmark.circle.fill" : task.blocking ? "exclamationmark.circle" : "circle")
                    .foregroundStyle(task.blocking && task.state != "implemented" ? Color.orange : Color.mint)
                    .padding(.top, 2)
                Text(task.title).font(.system(size: 12, weight: .semibold)).lineLimit(3).textSelection(.enabled)
                Spacer(minLength: 0)
                Menu {
                    ForEach(task.actions, id: \.rawValue) { action in
                        Button(action.title) { store.perform(action, on: task) }
                    }
                } label: { Image(systemName: "ellipsis") }
                .menuStyle(.borderlessButton).fixedSize().disabled(store.isMutating || task.actions.isEmpty)
                .accessibilityLabel("Actions for \(task.title)")
            }
            HStack(spacing: 6) {
                Text(task.statusLabel)
                if task.blocking { Text("· Blocking") }
                if let owner = task.owner, !owner.isEmpty { Text("· For \(owner)").lineLimit(1) }
            }.font(.system(size: 10)).foregroundStyle(.secondary)
            let project = task.sourceContext.project ?? task.sourceContext.cwd ?? "Local task"
            Text([project, task.sourceContext.branch].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            DisclosureGroup("Details", isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(task.summary).font(.system(size: 11)).textSelection(.enabled)
                    if task.truncated { Text("Excerpt shown. Open the source session for the full task.").font(.caption2).foregroundStyle(.secondary) }
                    Text([task.provider, task.sessionTitle ?? task.sessionId, task.sourceContext.aiAgent].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    if let cwd = task.sourceContext.cwd { Text(cwd).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled) }
                    if store.sourceSession(for: task) != nil {
                        Button("Open source session") { store.openSource(task) }.buttonStyle(.genHoverPlain())
                    } else {
                        Text("The source session is not available in this Widget.").font(.caption2).foregroundStyle(.secondary)
                    }
                }.padding(.top, 6)
            }.font(.system(size: 10))
            if task.actions.contains(.complete) {
                HStack {
                    if task.state == "open" {
                        Button("Acknowledge") { store.perform(.acknowledge, on: task) }
                    }
                    Button("Complete") { store.perform(.complete, on: task) }
                    Spacer()
                }.buttonStyle(.bordered).controlSize(.small).disabled(store.isMutating)
            } else if task.actions.contains(.reopen) {
                Button("Reopen") { store.perform(.reopen, on: task) }
                    .buttonStyle(.bordered).controlSize(.small).disabled(store.isMutating)
            }
        }
        .padding(11).background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
        .accessibilityElement(children: .contain)
    }
}
