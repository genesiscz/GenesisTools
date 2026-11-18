import SwiftUI

/// How an item state looks: each state has its own glyph and hue, never only a shade (ux genesiscz 12a).
public enum WorkStateLook {
    public static func symbol(_ state: String) -> String {
        switch state {
        case "spotted": return "eye.circle"
        case "open": return "circle"
        case "active": return "circle.lefthalf.filled"
        case "done": return "checkmark.circle.fill"
        case "dropped": return "xmark.circle"
        case "reopened": return "arrow.uturn.backward.circle"
        default: return "questionmark.circle"
        }
    }

    public static func color(_ state: String) -> Color {
        switch state {
        case "spotted": return KitPalette.modified
        case "open": return KitPalette.text
        case "active": return KitPalette.renamed
        case "done": return KitPalette.added
        case "dropped": return KitPalette.faint
        case "reopened": return KitPalette.removed
        default: return KitPalette.dim
        }
    }
}

/// The Items pane: the open handoffs with their tasks, the spotted items by type, the reopened items nobody works on.
/// It is the content of a scroll view; a test renders it as is.
public struct WorkItemsView: View {
    let snapshot: WorkSnapshotValue
    let pending: Set<String>
    let perform: (WorkScreenAction) -> Void
    @State private var expanded: Set<String> = []

    public init(snapshot: WorkSnapshotValue, pending: Set<String>, expandAll: Bool = false,
                perform: @escaping (WorkScreenAction) -> Void) {
        self.snapshot = snapshot
        self.pending = pending
        self.perform = perform
        _expanded = State(initialValue: expandAll ? Set(snapshot.containers.map(\.ref)) : [])
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            section("Handoffs and epics", count: snapshot.containers.count,
                    empty: "No open handoff or epic in \(snapshot.project)") {
                ForEach(snapshot.containers) { container in
                    containerRow(container)
                }
            }
            section("Spotted", count: snapshot.spotted.count, empty: "Nothing spotted waits for a look") {
                ForEach(spottedByType, id: \.type) { group in
                    Text(Plural.count(group.rows.count, group.type))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(KitPalette.dim)
                        .padding(.top, 4)
                    ForEach(group.rows) { row in triageRow(row, accept: true) }
                }
            }
            section("Reopened, nobody working", count: snapshot.reopened.count,
                    empty: "No reopened item waits for a worker") {
                ForEach(snapshot.reopened) { row in triageRow(row, accept: false) }
            }
        }
        .accessibilityIdentifier("work-items")
    }

    private var spottedByType: [(type: String, rows: [WorkTriageValue])] {
        Dictionary(grouping: snapshot.spotted, by: \.type)
            .map { (type: $0.key, rows: $0.value) }
            .sorted { $0.type < $1.type }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, count: Int, empty: String,
                                         @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Text(title).font(.system(size: 13, weight: .semibold))
                CountBadge(count, tooltip: Plural.count(count, "item"))
                Spacer()
            }
            .padding(.bottom, 4)
            if count == 0 {
                Text(empty).font(.system(size: 12)).foregroundStyle(KitPalette.faint)
            } else {
                content()
            }
        }
    }

    private func containerRow(_ container: WorkContainerValue) -> some View {
        let open = Binding(get: { expanded.contains(container.ref) },
                           set: { if $0 { expanded.insert(container.ref) } else { expanded.remove(container.ref) } })
        return GenDisclosure(isExpanded: open, identifier: "work-container-\(container.ref)",
                             accessibilityTitle: container.title) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(container.members) { member in
                    memberRow(member)
                }
            }
            .padding(.leading, 18)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: container.type == "epic" ? "square.stack.3d.up" : "tray.full")
                    .foregroundStyle(KitPalette.dim)
                Text(container.title).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
                Text(verbatim: container.ref).font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(KitPalette.faint)
                Spacer()
                Text(verbatim: "\(container.open) of \(container.total) open")
                    .font(.system(size: 11)).foregroundStyle(KitPalette.dim)
            }
        }
    }

    private func memberRow(_ row: WorkRowValue) -> some View {
        HStack(spacing: 8) {
            stateGlyph(row.state)
            Text(row.title).font(.system(size: 12)).lineLimit(1)
                .foregroundStyle(row.isOpen ? KitPalette.text : KitPalette.dim)
            Text(verbatim: row.slot ?? row.ref).font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(KitPalette.faint)
            Spacer()
            if let worker = row.worker {
                Text(worker).font(.system(size: 10.5)).foregroundStyle(KitPalette.faint).lineLimit(1)
            }
            actions(ref: row.ref, state: row.state, accept: false)
        }
        .frame(minHeight: 26)
        .accessibilityElement(children: .contain)
    }

    private func triageRow(_ row: WorkTriageValue, accept: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                stateGlyph(row.state)
                Text(row.title).font(.system(size: 12)).lineLimit(1)
                if let severity = row.severity {
                    Badge(severity, color: severity == "critical" || severity == "high" ? KitPalette.removed : KitPalette.dim,
                          look: .tone)
                }
                Text(verbatim: row.ref).font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(KitPalette.faint)
                Spacer()
                actions(ref: row.ref, state: row.state, accept: accept)
            }
            let detail = [row.where, row.why].compactMap { $0 }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).font(.system(size: 11)).foregroundStyle(KitPalette.dim).lineLimit(2)
                    .padding(.leading, 24)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
    }

    private func stateGlyph(_ state: String) -> some View {
        Image(systemName: WorkStateLook.symbol(state))
            .foregroundStyle(WorkStateLook.color(state))
            .frame(width: 16)
            .instantTooltip(state)
            .accessibilityLabel(state)
    }

    @ViewBuilder
    private func actions(ref: String, state: String, accept: Bool) -> some View {
        if pending.contains(ref) {
            ProgressView().controlSize(.small).accessibilityLabel("Saving")
        } else {
            HStack(spacing: 4) {
                if accept && state == "spotted" {
                    IconButton(systemName: "checkmark.circle", tooltip: "Accept: it becomes open work") {
                        perform(.accept(ref: ref))
                    }
                }
                if ["open", "active", "reopened"].contains(state) {
                    WorkReasonButton(symbol: "checkmark.seal", tooltip: "Finish, with the proof",
                                     prompt: "The proof: the command, where it ran, the commit") {
                        perform(.finish(ref: ref, proof: $0))
                    }
                }
                if ["done", "dropped"].contains(state) {
                    WorkReasonButton(symbol: "arrow.uturn.backward.circle", tooltip: "Reopen, with what is still wrong",
                                     prompt: "What is still wrong, with the evidence") {
                        perform(.reopen(ref: ref, why: $0))
                    }
                }
                if state != "dropped" && state != "done" {
                    if !handoffs(excluding: ref).isEmpty {
                        MenuButton(items: {
                            handoffs(excluding: ref).map { handoff in
                                .action("\(handoff.title) (\(handoff.ref))") { perform(.addMember(ref: ref, handoff: handoff.ref)) }
                            }
                        }) {
                            Image(systemName: "tray.and.arrow.down").frame(width: 20, height: 20)
                        }
                        .instantTooltip("Add to a handoff as one of its tasks")
                        .accessibilityLabel("Add to a handoff")
                    }
                    WorkReasonButton(symbol: "xmark.circle", tooltip: "Drop, with the reason",
                                     prompt: "Why nobody will do it") {
                        perform(.drop(ref: ref, why: $0))
                    }
                }
            }
        }
    }

    private func handoffs(excluding ref: String) -> [WorkContainerValue] {
        snapshot.openHandoffs.filter { handoff in !handoff.members.contains { $0.ref == ref } }
    }
}

/// An icon button that asks for one line of text (a reason, a proof) in a popover before it acts.
struct WorkReasonButton: View {
    let symbol: String
    let tooltip: String
    let prompt: String
    let action: (String) -> Void
    @State private var asking = false
    @State private var text = ""

    var body: some View {
        IconButton(systemName: symbol, tooltip: tooltip) { asking = true }
            .popover(isPresented: $asking, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(prompt).font(.system(size: 12, weight: .medium))
                    TextField("", text: $text, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(2...5)
                        .frame(width: 320)
                        .onSubmit(confirm)
                    HStack {
                        Spacer()
                        Button("Cancel") { asking = false }.keyboardShortcut(.cancelAction)
                        Button(tooltip.components(separatedBy: ",").first ?? "Save", action: confirm)
                            .keyboardShortcut(.defaultAction)
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .padding(14)
            }
    }

    private func confirm() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        asking = false
        text = ""
        action(value)
    }
}

/// The Notifications pane (P8 decision 4): per type, who hears about each action, with the layer that decides. A cell's
/// tooltip lists every layer; a change goes through `tools work config set`, shown under the grid.
public struct WorkNotifyGridView: View {
    let project: String
    let rows: [WorkNotifyRow]

    public init(project: String, rows: [WorkNotifyRow]) {
        self.project = project
        self.rows = rows
    }

    private var actions: [String] { rows.first?.cells.map(\.action) ?? [] }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
                GridRow {
                    Text("Type").font(.system(size: 11, weight: .semibold)).foregroundStyle(KitPalette.dim)
                    ForEach(actions, id: \.self) { action in
                        Text(action).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(KitPalette.dim)
                            .lineLimit(2).frame(width: 74, alignment: .leading)
                    }
                }
                Divider().gridCellColumns(actions.count + 1)
                ForEach(rows) { row in
                    GridRow {
                        Text(row.type).font(.system(size: 12, weight: .medium))
                        ForEach(row.cells) { cell in
                            WorkNotifyCellView(cell: cell)
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "terminal").foregroundStyle(KitPalette.faint)
                Text(verbatim: "tools work config set projects.\(project).rules.notify.<type>.<action> '\"inbox\"'")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(KitPalette.dim)
                    .textSelection(.enabled)
            }
            Text("off: nobody · list: the tree only · inbox: one quiet inbox line · banner: the line with a notification")
                .font(.system(size: 11)).foregroundStyle(KitPalette.faint)
        }
        .accessibilityIdentifier("work-notify-grid")
    }
}

struct WorkNotifyCellView: View {
    let cell: WorkNotifyCell

    static func color(_ level: String) -> Color {
        switch level {
        case "off": return KitPalette.faint
        case "inbox": return KitPalette.renamed
        case "banner": return KitPalette.modified
        default: return KitPalette.dim
        }
    }

    static func symbol(_ level: String) -> String {
        switch level {
        case "off": return "bell.slash"
        case "inbox": return "tray"
        case "banner": return "bell.badge"
        default: return "list.bullet"
        }
    }

    var body: some View {
        let decided = cell.from != "default"
        HStack(spacing: 4) {
            Image(systemName: Self.symbol(cell.level)).imageScale(.small)
            Text(cell.level).font(.system(size: 11, weight: decided ? .semibold : .regular))
        }
        .foregroundStyle(Self.color(cell.level))
        .frame(width: 74, alignment: .leading)
        .instantTooltip(title: "\(cell.action): \(cell.level), decided by \(cell.from)",
                        bullets: cell.layers.map { "\($0.layer): \($0.level ?? "not set")" })
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(cell.action) \(cell.level), decided by \(cell.from)")
    }
}
