import SwiftUI

private struct CompactWorkRowsKey: EnvironmentKey {
    static let defaultValue = false
}

private extension EnvironmentValues {
    var compactWorkRows: Bool {
        get { self[CompactWorkRowsKey.self] }
        set { self[CompactWorkRowsKey.self] = newValue }
    }
}

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

/// The Items pane consumes the model's projection; the legacy initializer renders the same rows.
/// The host owns the find bar and scroll view.
public struct WorkItemsView: View {
    let snapshot: WorkSnapshotValue
    let projection: WorkItemsProjection?
    let filter: WorkFilter
    let selection: String?
    let pending: Set<String>
    let indexLoading: Bool
    let indexFailure: String?
    let select: (String) -> Void
    let toggleExpansion: ((String, Bool) -> Void)?
    let showMore: () -> Void
    let clearFilters: () -> Void
    let retryIndex: () -> Void
    let perform: @MainActor (WorkScreenAction) -> Task<Bool, Never>
    @State private var expanded: Set<String>
    @State private var compact = false
    @State private var localFolded: Set<String> = []
    private var foldedSections: Binding<Set<String>>?

    public init(snapshot: WorkSnapshotValue, pending: Set<String>, expandAll: Bool = false,
                foldedSections: Binding<Set<String>>? = nil,
                perform: @escaping (WorkScreenAction) -> Void) {
        self.snapshot = snapshot; self.pending = pending
        self.perform = { action in perform(action); return Task { true } }
        projection = nil; filter = .default; selection = nil
        indexLoading = false; indexFailure = nil
        select = { _ in }; toggleExpansion = nil; showMore = {}; clearFilters = {}; retryIndex = {}
        self.foldedSections = foldedSections
        _expanded = State(initialValue: expandAll ? Set(snapshot.containers.map(\.ref)) : [])
    }

    public init(snapshot: WorkSnapshotValue, projection: WorkItemsProjection, filter: WorkFilter,
                selection: String?, pending: Set<String>, indexLoading: Bool = false, indexFailure: String? = nil,
                foldedSections: Binding<Set<String>>? = nil, select: @escaping (String) -> Void, toggleExpansion: @escaping (String, Bool) -> Void,
                showMore: @escaping () -> Void, clearFilters: @escaping () -> Void,
                retryIndex: @escaping () -> Void, perform: @escaping @MainActor (WorkScreenAction) async -> Bool) {
        self.snapshot = snapshot; self.projection = projection; self.filter = filter
        self.selection = selection; self.pending = pending
        self.indexLoading = indexLoading; self.indexFailure = indexFailure
        self.select = select; self.toggleExpansion = toggleExpansion; self.showMore = showMore
        self.clearFilters = clearFilters; self.retryIndex = retryIndex
        self.foldedSections = foldedSections
        self.perform = { action in Task { await perform(action) } }
        _expanded = State(initialValue: [])
    }

    private var items: WorkItemsProjection {
        projection ?? WorkItemsProjection(snapshot: snapshot, expanded: expanded)
    }

    private var showsOpenSections: Bool {
        filter.states.isEmpty || !filter.states.isDisjoint(with: [.open, .spotted, .reopened])
    }

    public var body: some View {
        let items = items
        VStack(alignment: .leading, spacing: 22) {
            if filter.isActive && items.isEmpty && !indexLoading && indexFailure == nil {
                EmptyState(symbol: "magnifyingglass", text: "No item matches", detail: filter.text)
                Button("Clear filters", action: clearFilters)
                    .buttonStyle(.genHoverPlain())
                    .accessibilityIdentifier("work-clear-empty-filters")
            } else { sections(items) }
        }
        .accessibilityIdentifier("work-items")
        .environment(\.compactWorkRows, compact)
        .onGeometryChange(for: Bool.self) { $0.size.width < 510 } action: { compact = $0 }
    }

    /// The scroll ID of a section's header, so a count elsewhere (the hub's title bar) can bring that section into view.
    public static func sectionID(_ title: String) -> String { "work.section." + title }
    public static let containersTitle = "Handoffs and epics"
    public static let spottedTitle = "Spotted"
    public static let reopenedTitle = "Reopened, nobody working"

    @ViewBuilder
    private func sections(_ items: WorkItemsProjection) -> some View {
        if showsOpenSections {
            section(Self.containersTitle, count: items.containers.count,
                    empty: "No open handoff or epic in \(snapshot.project)") {
                ForEach(items.containers) { container in
                    ContainerRow(container: container, filtered: filter.isActive,
                                 snapshot: snapshot, pending: pending, selection: selection,
                                 selectable: projection != nil, select: select,
                                 toggle: { open in
                                     if let toggleExpansion { toggleExpansion(container.ref, open) }
                                     else if open { expanded.insert(container.ref) }
                                     else { expanded.remove(container.ref) }
                                 }, perform: perform)
                        .equatable()
                }
            }
            section(Self.spottedTitle, count: items.spotted.count, empty: "Nothing spotted waits for a look") {
                ForEach(items.spottedGroups) { group in
                    Text(Plural.count(group.rows.count, WorkWords.type(group.type).lowercased()))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(KitPalette.dim)
                        .padding(.top, 4)
                    ForEach(group.rows) { triage($0, accept: true) }
                }
            }
            section(Self.reopenedTitle, count: items.reopened.count,
                    empty: "No reopened item waits for a worker") {
                ForEach(items.reopened) { triage($0, accept: false) }
            }
        }
        if !items.other.isEmpty {
            section("Other matching items", count: items.other.count, empty: "") {
                ForEach(items.other) { row($0) }
            }
        }
        if filter.requiresIndex {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 7) {
                    Text("Done and dropped").font(.system(size: 13, weight: .semibold))
                    CountBadge(items.archiveCount, tooltip: Plural.count(items.archiveCount, "item"))
                    Spacer()
                }
                if indexLoading {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading done and dropped items").font(.system(size: 12))
                            .foregroundStyle(KitPalette.dim)
                    }
                    .accessibilityIdentifier("work-index-loading")
                }
                if let indexFailure {
                    FailureInline(.unexpected(indexFailure, outcome: "Could not read done and dropped items",
                                              action: "Read the project items"), form: .compact) { retryIndex() }
                        .accessibilityIdentifier("work-index-failure")
                }
                if items.archive.isEmpty && !indexLoading && indexFailure == nil {
                    Text("No match in Done and dropped").font(.system(size: 12)).foregroundStyle(KitPalette.faint)
                }
                ForEach(items.archive) { row($0, archive: true) }
                if items.hasMoreArchive {
                    Button("Show 200 more", action: showMore)
                        .buttonStyle(.genHoverPlain())
                        .accessibilityIdentifier("work-show-more-archive")
                }
            }
        }
    }

    private func row(_ value: WorkRowValue, archive: Bool = false) -> some View {
        ItemRow(value: value, detail: nil, summary: nil, accept: false, archive: archive,
                showActions: true, snapshot: snapshot, pending: pending,
                selected: selection == value.ref, selectable: projection != nil,
                select: select, perform: perform).equatable()
    }

    private func triage(_ value: WorkTriageValue, accept: Bool) -> some View {
        ItemRow(value: WorkRowValue(ref: value.ref, state: value.state, type: value.type,
                                   severity: value.severity, worker: value.worker, title: value.title,
                                   pairings: value.pairings),
                detail: [value.userSees, value.why, value.where].compactMap { $0 }.joined(separator: " · "), summary: nil,
                accept: accept, archive: false, showActions: true, snapshot: snapshot, pending: pending,
                selected: selection == value.ref, selectable: projection != nil,
                select: select, perform: perform).equatable()
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
                Text(filter.isActive ? "No match in \(title)" : empty)
                    .font(.system(size: 12)).foregroundStyle(KitPalette.faint)
            } else {
                LazyVStack(alignment: .leading, spacing: 4) { content() }
            }
        } label: {
            Text(title).font(.system(size: 13, weight: .semibold))
            CountBadge(count, tooltip: Plural.count(count, "item"))
        }
        .id(Self.sectionID(title))
    }

    private struct ContainerRow: View, Equatable {
        let container: WorkItemsProjection.Container
        let filtered: Bool
        let snapshot: WorkSnapshotValue
        let pending: Set<String>
        let selection: String?
        let selectable: Bool
        let select: (String) -> Void
        let toggle: (Bool) -> Void
        let perform: @MainActor (WorkScreenAction) -> Task<Bool, Never>

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.container == rhs.container && lhs.filtered == rhs.filtered && lhs.snapshot == rhs.snapshot
                && lhs.pending == rhs.pending && lhs.selection == rhs.selection && lhs.selectable == rhs.selectable
        }

        var body: some View {
            let value = container.value
            let summary = filtered ? "\(container.matchingCount) of \(value.total) tasks match"
                : value.progressLabel
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .top, spacing: 0) {
                    // The disclosure and selection are sibling controls, never a button inside a button.
                    GenDisclosure(isExpanded: Binding(get: { container.isExpanded }, set: toggle),
                                  identifier: "work-container-\(value.ref)", accessibilityTitle: value.title) {
                        EmptyView()
                    } label: { EmptyView() }
                    .frame(width: 24)
                    ItemRow(value: WorkRowValue(ref: value.ref, state: value.state, type: value.type,
                                                title: value.title, pairings: value.pairings),
                            detail: nil, summary: summary, accept: false, archive: false, showActions: false,
                            snapshot: snapshot, pending: pending, selected: selection == value.ref,
                            selectable: selectable, select: select, perform: perform).equatable()
                }
                if container.isExpanded {
                    VStack(alignment: .leading, spacing: 2) {
                        if value.members.isEmpty {
                            Text("No tasks in this \(value.type == "epic" ? "epic" : "handoff")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(container.members) { member in
                            ItemRow(value: member, detail: nil, summary: nil, accept: member.state == "spotted", archive: false,
                                    showActions: true, snapshot: snapshot, pending: pending,
                                    selected: selection == member.ref, selectable: selectable,
                                    select: select, perform: perform).equatable()
                        }
                    }
                    .padding(.leading, 24)
                    .transition(.genReveal)
                }
            }
            .clipShape(Rectangle().inset(by: -3))
            .liveRow(selected: selection == value.ref || container.isExpanded)
        }
    }

    private struct ItemRow: View, Equatable {
        @Environment(\.compactWorkRows) private var compact
        let value: WorkRowValue
        let detail: String?
        let summary: String?
        let accept: Bool
        let archive: Bool
        let showActions: Bool
        let snapshot: WorkSnapshotValue
        let pending: Set<String>
        let selected: Bool
        let selectable: Bool
        let select: (String) -> Void
        let perform: @MainActor (WorkScreenAction) -> Task<Bool, Never>

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.value == rhs.value && lhs.detail == rhs.detail && lhs.summary == rhs.summary
                && lhs.accept == rhs.accept && lhs.archive == rhs.archive && lhs.showActions == rhs.showActions
                && lhs.snapshot == rhs.snapshot && lhs.pending == rhs.pending
                && lhs.selected == rhs.selected && lhs.selectable == rhs.selectable
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                Group {
                    if selectable {
                        label.rowButton { select(value.ref) }
                            .accessibilityLabel("\(value.title), \(WorkWords.state(value.state))")
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier("work-select-\(value.ref)")
                    } else { label }
                }
                // The ID is not printed on the row, so long titles keep their width; the menu copies it.
                .contextMenu { Button("Copy item ID") { Clipboard.copy(value.ref, what: "Item ID") } }
                if !archive, let pairings = value.pairings, !pairings.isEmpty {
                    WorkPairingActions(ref: value.ref, pairings: pairings, project: value.project,
                                       pending: pending) { _ = perform($0) }.padding(.leading, 24)
                }
                if let detail, !detail.isEmpty {
                    Text(detail).font(.system(size: 11)).foregroundStyle(KitPalette.dim).lineLimit(2)
                        .padding(.leading, 24)
                }
                // Actions sit under the title, so a title is never squeezed by its buttons.
                if showActions { actions(ref: value.ref, state: value.state, accept: accept).padding(.leading, 24) }
            }
            .padding(.vertical, detail == nil ? 0 : 3)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.clear)
            .accessibilityElement(children: .contain)
            .id(value.ref)
            .liveRow(selected: selected)
        }

        @ViewBuilder private var label: some View {
            if compact, selectable, summary == nil {
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: value.title).font(.system(size: 12)).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 6) {
                        stateGlyph(value.state)
                        rowFacts
                    }
                }
                .padding(.vertical, 4).contentShape(Rectangle())
            } else {
                HStack(spacing: 8) {
                    if summary != nil {
                        Image(systemName: value.type == "epic" ? "square.stack.3d.up" : "tray.full")
                            .foregroundStyle(KitPalette.dim)
                    } else { stateGlyph(value.state) }
                    Text(value.title).font(.system(size: summary == nil ? 12 : 12.5,
                                                   weight: summary == nil ? .regular : .medium)).lineLimit(summary == nil ? 3 : 2)
                        .foregroundStyle(value.isOpen ? KitPalette.text : KitPalette.dim)
                    rowFacts
                }
                .frame(maxWidth: .infinity, minHeight: 26, alignment: .leading)
                .contentShape(Rectangle())
            }
        }

        @ViewBuilder private var rowFacts: some View {
            if let severity = value.severity {
                Badge(WorkWords.severity(severity),
                      color: severity == "critical" || severity == "high" ? KitPalette.removed : KitPalette.dim,
                      look: .tone)
            }
            Spacer(minLength: 4)
            if let summary {
                Text(verbatim: summary).font(.system(size: 11)).foregroundStyle(KitPalette.dim)
                    .fixedSize(horizontal: true, vertical: false)
            } else if let worker = value.worker {
                Text(worker).font(.system(size: 11)).foregroundStyle(KitPalette.faint).lineLimit(1)
            }
        }

        private func stateGlyph(_ state: String) -> some View {
            Image(systemName: WorkStateLook.symbol(state))
                .foregroundStyle(WorkStateLook.color(state))
                .frame(width: 16)
                .instantTooltip(WorkWords.state(state))
                .accessibilityLabel(WorkWords.state(state))
        }
        @ViewBuilder
        private func actions(ref: String, state: String, accept: Bool) -> some View {
            if pending.contains(ref) {
                ProgressView().controlSize(.small).accessibilityLabel("Saving")
            } else {
                HStack(spacing: 4) {
                    if accept && state == "spotted" {
                        IconButton(systemName: "checkmark.circle", tooltip: "Accept: it becomes open work") {
                            _ = perform(.accept(ref: ref))
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
                                    .action("\(handoff.title) (\(handoff.ref))") { _ = perform(.addMember(ref: ref, handoff: handoff.ref)) }
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
}

struct WorkPairingActions: View {
    let ref: String
    let pairings: [WorkPairingValue]
    let project: String?
    let pending: Set<String>
    let perform: (WorkScreenAction) -> Void

    var body: some View {
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
                        IconButton(systemName: "minus.circle", tooltip: "Unpair \(name) · \(key). Removes the link and keeps both items.") {
                            perform(.unpair(ref: ref, connector: pairing.connector, project: project))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            if pairings.contains(where: \.enabled) {
                let syncTip = "Sync now. Push this item's local fields to enabled connectors and release held changes."
                let driftTip = " A successful push clears the drift flag without pulling remote fields."
                IconButton(systemName: "arrow.triangle.2.circlepath",
                           tooltip: syncTip + (pairings.contains { $0.enabled && $0.state == .drift } ? driftTip : "")) {
                    perform(.sync(ref: ref, project: project))
                }
            }
        }
        .disabled(pending.contains(ref))
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

/// An icon button that asks for one line of text (a reason, a proof) in a popover before it acts.
struct WorkReasonButton: View {
    private let symbol: String
    private let tooltip: String
    private let prompt: String
    private let title: String?
    private let externalText: Binding<String>?
    private let isPending: Bool
    private let identifier: String
    private let action: @MainActor (String) -> Task<Bool, Never>?
    @State private var asking = false
    @State private var localText = ""
    @State private var localRevision = UUID()
    @State private var sending = false
    @State private var presentation = UUID()
    @FocusState private var focused: Bool

    /// Compatibility initializer for the existing row actions.
    init(symbol: String, tooltip: String, prompt: String, action: @escaping @MainActor (String) -> Task<Bool, Never>?) {
        self.symbol = symbol
        self.tooltip = tooltip
        self.prompt = prompt
        self.title = nil
        self.externalText = nil
        self.isPending = false
        self.identifier = "work.reason.\(symbol)"
        self.action = action
    }

    /// Labelled inspector action. Success is true only after the write is confirmed by the model.
    init(title: String, symbol: String, tooltip: String, prompt: String, text: Binding<String>,
         isPending: Bool = false, identifier: String,
         action: @escaping @MainActor (String) -> Task<Bool, Never>?) {
        self.symbol = symbol
        self.tooltip = tooltip
        self.prompt = prompt
        self.title = title
        self.externalText = text
        self.isPending = isPending
        self.identifier = identifier
        self.action = action
    }

    private var text: Binding<String> {
        externalText ?? Binding(get: { localText }, set: { localText = $0; localRevision = UUID() })
    }
    private var verb: String { title ?? tooltip.components(separatedBy: ",").first ?? "Save" }
    private var empty: Bool { text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        Group {
            if let title {
                Button(action: toggle) { Label(title, systemImage: symbol) }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(tooltip)
            } else {
                IconButton(systemName: symbol, tooltip: tooltip, action: toggle)
            }
        }
        .accessibilityLabel(verb)
        .accessibilityIdentifier(identifier)
        .disabled(isPending || sending)
        .popover(isPresented: $asking, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                Text(prompt).font(.system(size: 12, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                TextField("", text: text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...6)
                    .focused($focused)
                    .accessibilityLabel(prompt)
                    .accessibilityIdentifier("\(identifier).text")
                Text("Return adds a line. ⌘Return saves.").font(.system(size: 11)).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    if sending {
                        ProgressView().controlSize(.small)
                        Text("Saving").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Button("Cancel") { asking = false }
                        .buttonStyle(.genHoverPlain())
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("\(identifier).cancel")
                    Button(verb, action: confirm)
                        .buttonStyle(.genHoverPlain())
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(empty || sending || isPending)
                        .accessibilityIdentifier("\(identifier).save")
                }
            }
            .frame(width: 288)
            .padding(14)
            // The popover only asks for this text: it takes the keys at once, no second click.
            .onAppear { focused = true }
        }
    }

    private func toggle() {
        guard !isPending, !sending else { return }
        if !asking { presentation = UUID() }
        asking.toggle()
    }

    private func confirm() {
        let value = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !isPending, !sending else { return }
        let submittedRevision = localRevision
        let shown = presentation
        guard let submitted = action(value) else { return }
        sending = true
        Task {
            let ok = await submitted.value
            sending = false
            if externalText == nil, ok, localRevision == submittedRevision { localText = "" }
            // External-draft clearing is owned by the caller's revision check. A failed write stays open;
            // a new draft, typed during the write, also stays open. Cancel/dismiss never erases text.
            if ok, text.wrappedValue.isEmpty, presentation == shown { asking = false }
        }
    }
}
