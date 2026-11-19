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
    private let openHandoffs: [WorkContainerValue]
    private let handoffsByMember: [String: Set<String>]
    @State private var expanded: Set<String> = []
    @State private var localFolded: Set<String> = []
    private var foldedSections: Binding<Set<String>>?
    @State private var localDrafts: [String: String] = [:]
    private let reasonDrafts: Binding<[String: String]>?
    private let submitReason: ((WorkScreenAction) async -> Bool)?

    public init(snapshot: WorkSnapshotValue, pending: Set<String>, expandAll: Bool = false,
                foldedSections: Binding<Set<String>>? = nil,
                reasonDrafts: Binding<[String: String]>? = nil, submitReason: ((WorkScreenAction) async -> Bool)? = nil,
                perform: @escaping (WorkScreenAction) -> Void) {
        self.snapshot = snapshot
        self.pending = pending
        self.perform = perform
        self.foldedSections = foldedSections
        self.reasonDrafts = reasonDrafts
        self.submitReason = submitReason
        openHandoffs = snapshot.openHandoffs
        var index: [String: Set<String>] = [:]
        for handoff in openHandoffs {
            index[handoff.ref, default: []].insert(handoff.ref)
            for member in handoff.members {
                index[member.ref, default: []].insert(handoff.ref)
            }
        }
        handoffsByMember = index
        _expanded = State(initialValue: expandAll ? Set(snapshot.containers.map(\.ref)) : [])
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            section(Self.containersTitle, count: snapshot.containers.count,
                    empty: "No open handoff or epic in \(snapshot.project)") {
                ForEach(snapshot.containers) { container in
                    containerRow(container)
                }
            }
            section(Self.spottedTitle, count: snapshot.spotted.count, empty: "Nothing spotted waits for a look") {
                ForEach(spottedByType, id: \.type) { group in
                    Text(Plural.count(group.rows.count, group.type))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(KitPalette.dim)
                        .padding(.top, 4)
                    ForEach(group.rows) { row in triageRow(row, accept: true) }
                }
            }
            section(Self.reopenedTitle, count: snapshot.reopened.count,
                    empty: "No reopened item waits for a worker") {
                ForEach(snapshot.reopened) { row in triageRow(row, accept: false) }
            }
        }
        .accessibilityIdentifier("work-items")
    }

    /// The scroll ID of a section's header, so a count elsewhere (the hub's title bar) can bring that section into view.
    public static func sectionID(_ title: String) -> String { "work.section." + title }
    public static let containersTitle = "Handoffs and epics"
    public static let spottedTitle = "Spotted"
    public static let reopenedTitle = "Reopened, nobody working"

    private var spottedByType: [(type: String, rows: [WorkTriageValue])] {
        Dictionary(grouping: snapshot.spotted, by: \.type)
            .map { (type: $0.key, rows: $0.value) }
            .sorted { $0.type < $1.type }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, count: Int, empty: String,
                                         @ViewBuilder content: () -> Content) -> some View {
        let folded = foldedSections ?? $localFolded
        let isExpanded = Binding(get: { !folded.wrappedValue.contains(title) }, set: { show in
            if show { folded.wrappedValue.remove(title) } else { folded.wrappedValue.insert(title) }
        })
        GenDisclosure(isExpanded: isExpanded, identifier: Self.sectionID(title), accessibilityTitle: title) {
            if count == 0 {
                Text(empty).font(.system(size: 12)).foregroundStyle(KitPalette.faint)
            } else {
                LazyVStack(alignment: .leading, spacing: 4) { content() }
            }
        } label: {
            Text(title).font(.system(size: 13, weight: .semibold))
            CountBadge(count, tooltip: Plural.count(count, "item"))
        }
        .id(Self.sectionID(title))
    }

    private func containerRow(_ container: WorkContainerValue) -> some View {
        let open = Binding(get: { expanded.contains(container.ref) },
                           set: { if $0 { expanded.insert(container.ref) } else { expanded.remove(container.ref) } })
        let links = pairingRows(ref: container.ref, pairings: container.pairings)
        return VStack(alignment: .leading, spacing: 0) {
            GenDisclosure(isExpanded: open, identifier: "work-container-\(container.ref)",
                          accessibilityTitle: container.title) {
                VStack(alignment: .leading, spacing: 2) {
                    links
                    if container.members.isEmpty {
                        Text("No tasks in this \(container.type == "epic" ? "epic" : "handoff")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(container.members) { member in
                        memberRow(member)
                    }
                }
                .padding(.leading, 18)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: container.type == "epic" ? "square.stack.3d.up" : "tray.full")
                        .foregroundStyle(KitPalette.dim)
                    Text(container.title).font(.system(size: 12.5, weight: .medium)).lineLimit(2)
                    Spacer(minLength: 4)
                    Text(verbatim: container.progressLabel)
                        .font(.system(size: 11)).foregroundStyle(KitPalette.dim)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .contextMenu { copyReference(container.ref) }
            // Pairing buttons stay outside the disclosure button and are usable even when the members are folded.
            if !open.wrappedValue {
                links.padding(.leading, 24)
            }
        }
    }

    private func memberRow(_ row: WorkRowValue) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                stateGlyph(row.state)
                Text(row.title).font(.system(size: 12)).lineLimit(3)
                    .foregroundStyle(row.isOpen ? KitPalette.text : KitPalette.dim)
                Spacer(minLength: 4)
                if let worker = row.worker {
                    Text(worker).font(.system(size: 11)).foregroundStyle(KitPalette.dim).lineLimit(1)
                }
            }
            .contextMenu { copyReference(row.ref) }
            .frame(minHeight: 26)
            actions(ref: row.ref, title: row.title, state: row.state, accept: row.state == "spotted")
                .padding(.leading, 24)
            pairingRows(ref: row.ref, pairings: row.pairings, project: row.project).padding(.leading, 24)
        }
        .accessibilityElement(children: .contain)
    }

    private func triageRow(_ row: WorkTriageValue, accept: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                stateGlyph(row.state)
                Text(row.title).font(.system(size: 12)).lineLimit(3)
                if let severity = row.severity {
                    Badge(severity.capitalized, color: severity == "critical" || severity == "high" ? KitPalette.removed : KitPalette.dim,
                          look: .tone)
                }
                Spacer(minLength: 4)
            }
            .contextMenu { copyReference(row.ref) }
            pairingRows(ref: row.ref, pairings: row.pairings).padding(.leading, 24)
            let detail = [row.userSees, row.why, row.where].compactMap { $0 }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).font(.system(size: 11)).foregroundStyle(KitPalette.dim).lineLimit(2)
                    .padding(.leading, 24)
            }
            actions(ref: row.ref, title: row.title, state: row.state, accept: accept).padding(.leading, 24)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .contain)
    }

    private func stateGlyph(_ state: String) -> some View {
        Image(systemName: WorkStateLook.symbol(state))
            .foregroundStyle(WorkStateLook.color(state))
            .frame(width: 16)
            .instantTooltip(state.capitalized)
            .accessibilityLabel(state)
    }

    private func copyReference(_ ref: String) -> some View {
        Button("Copy item ID") { Clipboard.copy(ref, what: "Item ID") }
    }

    @ViewBuilder
    private func pairingRows(ref: String, pairings: [WorkPairingValue]?, project: String? = nil) -> some View {
        if let pairings, !pairings.isEmpty {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(pairings) { pairing in
                        let look = pairing.look
                        let name = pairing.displayName ?? pairing.connector
                        let key = pairing.remoteKey.isEmpty ? "No remote key yet" : pairing.remoteKey
                        let disabledReason = pairing.enabled ? nil : "Sync is turned off for this connector."
                        HStack(spacing: 5) {
                            Badge(look.label, color: look.color, look: .tone, symbol: look.symbol,
                                  tooltip: [look.detail, pairing.note, disabledReason].compactMap { $0 }.joined(separator: "\n"))
                            Text(verbatim: "\(name) · \(key)")
                                .font(.system(size: 11)).lineLimit(1).truncationMode(.middle)
                                .instantTooltip("\(name) · \(key)")
                            if !pairing.enabled {
                                Text("Sync off").font(.caption).foregroundStyle(.secondary)
                            }
                            WorkUnpairButton(name: name, key: key) {
                                perform(.unpair(ref: ref, connector: pairing.connector, project: project))
                            }
                        }
                    }
                }
                Spacer(minLength: 0)
                if pairings.contains(where: { $0.enabled && $0.state == .held }) {
                    KitButton("Release held changes", symbol: "arrow.triangle.2.circlepath", kind: .ghost, size: .small,
                              tooltip: "Release this item's held changes.") {
                        perform(.sync(ref: ref, project: project))
                    }
                }
            }
            .disabled(pending.contains(ref))
        }
    }

    @ViewBuilder
    private func actions(ref: String, title: String, state: String, accept: Bool) -> some View {
        WrapLayout(spacing: 6) {
            if accept && state == "spotted" {
                KitButton("Accept", symbol: "checkmark.circle", kind: .ghost, size: .small, tooltip: "Accept as open work") {
                    perform(.accept(ref: ref))
                }
                .accessibilityLabel("Accept: it becomes open work")
                .disabled(pending.contains(ref))
            }
            if ["open", "active", "reopened"].contains(state) {
                reasonButton(.finish, ref: ref, title: title)
            }
            if ["done", "dropped"].contains(state) {
                reasonButton(.reopen, ref: ref, title: title)
            }
            if state != "dropped" && state != "done" {
                if !handoffs(excluding: ref).isEmpty {
                    MenuButton(items: {
                        let choices = handoffs(excluding: ref)
                        let byTitle = Dictionary(grouping: choices, by: \.title)
                        return choices.map { handoff in
                            let label = byTitle[handoff.title]?.count == 1 ? handoff.title : "\(handoff.title) (\(handoff.ref))"
                            return .action(label) { perform(.addMember(ref: ref, handoff: handoff.ref)) }
                        }
                    }) {
                        Label(accept ? "Accept and add to handoff" : "Add to handoff", systemImage: "tray.and.arrow.down")
                            .font(.system(size: 11)).padding(.horizontal, 5).frame(minHeight: 22)
                    }
                    .instantTooltip("Add to a handoff as one of its tasks")
                    .accessibilityLabel("Add to a handoff")
                    .accessibilityHint(accept ? "Also accepts the spotted item" : "Choose the handoff")
                    .disabled(pending.contains(ref))
                }
                reasonButton(.drop, ref: ref, title: title)
            }
        }
        .overlay(alignment: .trailing) {
            if pending.contains(ref) { ProgressView().controlSize(.mini).offset(x: 18).accessibilityLabel("Saving") }
        }
    }

    private func reasonButton(_ kind: WorkReasonButton.Kind, ref: String, title: String) -> some View {
        let drafts = reasonDrafts ?? $localDrafts
        let key = kind.rawValue + ":" + ref
        let text = Binding(get: { drafts.wrappedValue[key] ?? "" }, set: { drafts.wrappedValue[key] = $0.isEmpty ? nil : $0 })
        return WorkReasonButton(kind: kind, title: title, busy: pending.contains(ref), text: text) { value in
            let action = kind.action(ref: ref, text: value)
            if let submitReason { return await submitReason(action) }
            perform(action)
            return true
        }
    }

    private func handoffs(excluding ref: String) -> [WorkContainerValue] {
        let current = handoffsByMember[ref] ?? []
        return openHandoffs.filter { !current.contains($0.ref) }
    }
}

private extension WorkPairingValue {
    var look: (label: String, symbol: String, color: Color, detail: String) {
        switch state {
        case .synced:
            return ("Synced", "checkmark.circle.fill", KitPalette.added, "The last sync completed.")
        case .pending:
            return ("Pending", "clock", KitPalette.dim, "The pairing is waiting for a push.")
        case .held:
            return ("Held", "pause.circle.fill", KitPalette.renamed, "The local change is waiting for release.")
        case .drift:
            switch driftDirection {
            case .local:
                return ("Local drift", "arrow.triangle.branch", KitPalette.modified, "A field owned by the connector changed here.")
            case .remote:
                return ("Remote drift", "arrow.triangle.branch", KitPalette.modified, "A field owned here changed on the connector.")
            case nil:
                return ("Drift", "arrow.triangle.branch", KitPalette.modified, "The two items differ. The direction was not recorded.")
            }
        case .failed:
            return ("Failed", "exclamationmark.triangle.fill", KitPalette.removed, "The last push failed.")
        }
    }
}

private struct WorkUnpairButton: View {
    let name: String
    let key: String
    let action: () -> Void
    @State private var confirming = false

    var body: some View {
        KitButton("Unpair", symbol: "minus.circle", kind: .ghost, size: .small,
                  tooltip: "Unpair \(name) · \(key). Removes the link and keeps both items.") { confirming = true }
            .accessibilityLabel("Unpair \(name) · \(key). Removes the link and keeps both items.")
            .confirmationDialog("Unpair \(name) · \(key)?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Unpair", role: .destructive, action: action)
                Button("Cancel", role: .cancel) {}
            } message: { Text("Both items remain. Future changes will no longer sync through this link.") }
            .liveRow(selected: confirming)
    }
}

struct WorkReasonButton: View {
    enum Kind: String {
        case finish = "Finish", reopen = "Reopen", drop = "Drop"

        var label: (symbol: String, accessibility: String, prompt: String) {
            switch self {
            case .finish: return ("checkmark.seal", "Finish, with the proof",
                                  "Record what ran, where and on which commit. This finishes the task in every handoff that contains it.")
            case .reopen: return ("arrow.uturn.backward.circle", "Reopen, with what is still wrong",
                                  "What still needs work? The previous worker receives your reason if available.")
            case .drop: return ("xmark.circle", "Drop, with the reason",
                                "Why will this work be dropped? This drops the task in every handoff that contains it.")
            }
        }

        func action(ref: String, text: String) -> WorkScreenAction {
            switch self {
            case .finish: return .finish(ref: ref, proof: text)
            case .reopen: return .reopen(ref: ref, why: text)
            case .drop: return .drop(ref: ref, why: text)
            }
        }
    }

    let kind: Kind
    let title: String
    let busy: Bool
    @Binding var text: String
    let action: (String) async -> Bool
    @State private var asking = false
    @State private var saving = false
    @State private var refused = false
    @FocusState private var typing: Bool

    var body: some View {
        KitButton(kind.rawValue, symbol: kind.label.symbol, kind: .ghost, size: .small, tooltip: "\(kind.rawValue) \(title)") { asking = true }
            .accessibilityLabel(kind.label.accessibility)
            .accessibilityHint(title)
            .disabled(busy || saving)
            .popover(isPresented: $asking, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(verbatim: "\(kind.rawValue) “\(title)”").font(.headline)
                    Text(kind.label.prompt).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    TextEditor(text: $text)
                        .font(.body)
                        .frame(minHeight: 58, maxHeight: 88)
                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(.secondary.opacity(0.4)).allowsHitTesting(false))
                        .accessibilityLabel(kind == .finish ? "Proof" : "Reason")
                        .focused($typing)
                        // The popover only asks for this text: it takes the keys at once, no second click.
                        .onAppear { typing = true }
                    if refused { Text("Your text is here. Check the failure details in Work and try again.").font(.caption) }
                    Text("Return adds a line. ⌘Return submits.").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Spacer()
                        Button("Cancel") { asking = false }.keyboardShortcut(.cancelAction)
                        Button(saving ? "Saving…" : kind.rawValue, action: confirm)
                            .keyboardShortcut(.return, modifiers: .command)
                            .disabled(saving || busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .frame(width: 320).padding(14)
            }
    }

    private func confirm() {
        guard !busy, !saving else { return }
        saving = true
        Task { @MainActor in
            let saved = await Self.saveDraft($text, using: action)
            saving = false
            refused = !saved
            if saved && text.isEmpty { asking = false }
        }
    }

    @MainActor
    static func saveDraft(_ text: Binding<String>, using action: (String) async -> Bool) async -> Bool {
        let submitted = text.wrappedValue
        let value = submitted.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, await action(value) else { return false }
        if text.wrappedValue == submitted { text.wrappedValue = "" }
        return true
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
                let path = FailureReport.shellQuoted("projects.\(project).rules.notify.<type>.<action>")
                Text(verbatim: "tools work config set \(path) '\"inbox\"'")
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
        // The grid holds a cell per type and action (130 today): each one rests its tooltip like a list row.
        .liveRow(selected: false)
    }
}
