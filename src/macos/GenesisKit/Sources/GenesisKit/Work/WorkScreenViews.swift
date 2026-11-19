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
    /// The reason and proof drafts. A host that also shows the inspector gives the store both share.
    @State private var localDrafts: WorkItemInspectorDrafts
    private let drafts: WorkItemInspectorDrafts?
    private let handoffs: HandoffChoices

    public init(snapshot: WorkSnapshotValue, pending: Set<String>, expandAll: Bool = false,
                foldedSections: Binding<Set<String>>? = nil, drafts: WorkItemInspectorDrafts? = nil,
                perform: @escaping (WorkScreenAction) -> Void) {
        handoffs = HandoffChoices(snapshot: snapshot)
        self.snapshot = snapshot; self.pending = pending
        self.perform = { action in perform(action); return Task { true } }
        projection = nil; filter = .default; selection = nil
        indexLoading = false; indexFailure = nil
        select = { _ in }; toggleExpansion = nil; showMore = {}; clearFilters = {}; retryIndex = {}
        self.foldedSections = foldedSections
        self.drafts = drafts
        _localDrafts = State(initialValue: drafts ?? WorkItemInspectorDrafts())
        _expanded = State(initialValue: expandAll ? Set(snapshot.containers.map(\.ref)) : [])
    }

    public init(snapshot: WorkSnapshotValue, projection: WorkItemsProjection, filter: WorkFilter,
                selection: String?, pending: Set<String>, indexLoading: Bool = false, indexFailure: String? = nil,
                foldedSections: Binding<Set<String>>? = nil, drafts: WorkItemInspectorDrafts? = nil,
                select: @escaping (String) -> Void, toggleExpansion: @escaping (String, Bool) -> Void,
                showMore: @escaping () -> Void, clearFilters: @escaping () -> Void,
                retryIndex: @escaping () -> Void, perform: @escaping @MainActor (WorkScreenAction) async -> Bool) {
        handoffs = HandoffChoices(snapshot: snapshot)
        self.snapshot = snapshot; self.projection = projection; self.filter = filter
        self.selection = selection; self.pending = pending
        self.indexLoading = indexLoading; self.indexFailure = indexFailure
        self.select = select; self.toggleExpansion = toggleExpansion; self.showMore = showMore
        self.clearFilters = clearFilters; self.retryIndex = retryIndex
        self.perform = { action in Task { await perform(action) } }
        self.foldedSections = foldedSections
        self.drafts = drafts
        _localDrafts = State(initialValue: drafts ?? WorkItemInspectorDrafts())
        _expanded = State(initialValue: [])
    }

    private var items: WorkItemsProjection {
        projection ?? WorkItemsProjection(snapshot: snapshot, expanded: expanded)
    }

    /// The scroll ID of a section's header, so a count elsewhere (the hub's title bar) can bring that section into view.
    public static func sectionID(_ title: String) -> String { "work.section." + title }
    public static let containersTitle = "Handoffs and epics"
    public static let spottedTitle = "Spotted"
    public static let reopenedTitle = "Reopened, nobody working"
    public static let otherTitle = "Other matching items"
    public static let archiveTitle = "Done and dropped"

    /// False while the state filter leaves out every open state: then the three open sections are not on screen.
    public static func showsOpenSections(_ filter: WorkFilter) -> Bool {
        filter.states.isEmpty || !filter.states.isDisjoint(with: [.open, .spotted, .reopened])
    }

    /// The section that shows a row, so a selection that arrives by the keyboard or a route can open a folded one.
    public static func sectionTitle(of ref: String, in items: WorkItemsProjection) -> String? {
        if items.containers.contains(where: { $0.ref == ref || $0.members.contains { $0.ref == ref } }) { return containersTitle }
        if items.spotted.contains(where: { $0.ref == ref }) { return spottedTitle }
        if items.reopened.contains(where: { $0.ref == ref }) { return reopenedTitle }
        if items.other.contains(where: { $0.ref == ref }) { return otherTitle }
        if items.archive.contains(where: { $0.ref == ref }) { return archiveTitle }
        return nil
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

    @ViewBuilder
    private func sections(_ items: WorkItemsProjection) -> some View {
        if Self.showsOpenSections(filter) {
            section(Self.containersTitle, count: items.containers.count,
                    empty: "No open handoff or epic in \(snapshot.project)") {
                ForEach(items.containers) { container in
                    ContainerRow(container: container, filtered: filter.isActive, showsRef: showsRef,
                                 handoffs: handoffs, pending: pending, selection: selection,
                                 selectable: projection != nil, drafts: drafts ?? localDrafts, select: select,
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
            section(Self.otherTitle, count: items.other.count, empty: "") {
                ForEach(items.other) { row($0) }
            }
        }
        if filter.requiresIndex {
            disclosure(Self.archiveTitle, count: items.archiveCount) {
                VStack(alignment: .leading, spacing: 8) {
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
    }

    /// A row shows its ID only while the reader searches by words, where a match can be the ID itself. At other
    /// times the ID is in the row's context menu and in the item details.
    private var showsRef: Bool { !filter.text.trimmingCharacters(in: .whitespaces).isEmpty }

    private func row(_ value: WorkRowValue, archive: Bool = false) -> some View {
        ItemRow(value: value, detail: nil, summary: nil, accept: value.state == "spotted", archive: archive,
                showActions: true, showsRef: showsRef, handoffs: handoffs, pending: pending,
                selected: selection == value.ref, selectable: projection != nil, drafts: drafts ?? localDrafts,
                select: select, perform: perform).equatable()
    }

    private func triage(_ value: WorkTriageValue, accept: Bool) -> some View {
        ItemRow(value: WorkRowValue(ref: value.ref, state: value.state, type: value.type,
                                   severity: value.severity, worker: value.worker, title: value.title,
                                   pairings: value.pairings),
                detail: [value.userSees, value.why, value.where].compactMap { $0 }.joined(separator: " · "), summary: nil,
                accept: accept, archive: false, showActions: true, showsRef: showsRef, handoffs: handoffs, pending: pending,
                selected: selection == value.ref, selectable: projection != nil, drafts: drafts ?? localDrafts,
                select: select, perform: perform).equatable()
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, count: Int, empty: String,
                                        @ViewBuilder content: () -> Content) -> some View {
        disclosure(title, count: count) {
            if count == 0 {
                Text(filter.isActive ? "No match in \(title)" : empty)
                    .font(.system(size: 12)).foregroundStyle(KitPalette.faint)
            } else {
                // Not lazy: a routed or keyboard-selected row far below the fold needs a place to scroll to.
                VStack(alignment: .leading, spacing: 4) { content() }
            }
        }
    }

    /// Every section folds, and its header carries the scroll ID a count elsewhere jumps to.
    private func disclosure<Content: View>(_ title: String, count: Int,
                                           @ViewBuilder content: () -> Content) -> some View {
        let folded = foldedSections ?? $localFolded
        let isExpanded = Binding(get: { !folded.wrappedValue.contains(title) }, set: { show in
            if show { folded.wrappedValue.remove(title) } else { folded.wrappedValue.insert(title) }
        })
        return GenDisclosure(isExpanded: isExpanded, identifier: Self.sectionID(title), accessibilityTitle: title) {
            content()
        } label: {
            Text(title).font(.system(size: 13, weight: .semibold))
            CountBadge(count, tooltip: Plural.count(count, "item"))
        }
        .id(Self.sectionID(title))
    }

    private struct ContainerRow: View, Equatable {
        let container: WorkItemsProjection.Container
        let filtered: Bool
        let showsRef: Bool
        let handoffs: HandoffChoices
        let pending: Set<String>
        let selection: String?
        let selectable: Bool
        let drafts: WorkItemInspectorDrafts
        let select: (String) -> Void
        let toggle: (Bool) -> Void
        let perform: @MainActor (WorkScreenAction) -> Task<Bool, Never>

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.container == rhs.container && lhs.filtered == rhs.filtered && lhs.showsRef == rhs.showsRef
                && lhs.handoffs == rhs.handoffs && lhs.pending == rhs.pending && lhs.selection == rhs.selection
                && lhs.selectable == rhs.selectable && lhs.drafts === rhs.drafts
        }

        var body: some View {
            let value = container.value
            let summary = filtered ? "\(container.matchingCount) of \(value.total) tasks match" : value.progressLabel
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .top, spacing: 0) {
                    // The disclosure and selection are sibling controls, never a button inside a button.
                    GenDisclosure(isExpanded: Binding(get: { container.isExpanded }, set: toggle),
                                  identifier: "work-container-\(value.ref)", accessibilityTitle: value.title) {
                        EmptyView()
                    } label: { EmptyView() }
                    .frame(width: 24)
                    // The container's own pairing is part of this row, so it stays in reach while the tasks are folded.
                    ItemRow(value: WorkRowValue(ref: value.ref, state: value.state, type: value.type,
                                                title: value.title, pairings: value.pairings),
                            detail: nil, summary: summary, accept: false, archive: false, showActions: false,
                            showsRef: showsRef, handoffs: handoffs, pending: pending, selected: selection == value.ref,
                            selectable: selectable, drafts: drafts, select: select, perform: perform).equatable()
                }
                if container.isExpanded {
                    VStack(alignment: .leading, spacing: 2) {
                        if value.members.isEmpty {
                            Text("No tasks in this \(value.type == "epic" ? "epic" : "handoff")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(container.members) { member in
                            ItemRow(value: member, detail: nil, summary: nil, accept: member.state == "spotted",
                                    archive: false, showActions: true, showsRef: showsRef, handoffs: handoffs,
                                    pending: pending, selected: selection == member.ref, selectable: selectable,
                                    drafts: drafts, select: select, perform: perform).equatable()
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
        let showsRef: Bool
        let handoffs: HandoffChoices
        let pending: Set<String>
        let selected: Bool
        let selectable: Bool
        let drafts: WorkItemInspectorDrafts
        let select: (String) -> Void
        let perform: @MainActor (WorkScreenAction) -> Task<Bool, Never>

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.value == rhs.value && lhs.detail == rhs.detail && lhs.summary == rhs.summary
                && lhs.accept == rhs.accept && lhs.archive == rhs.archive && lhs.showActions == rhs.showActions
                && lhs.showsRef == rhs.showsRef && lhs.handoffs == rhs.handoffs && lhs.pending == rhs.pending
                && lhs.selected == rhs.selected && lhs.selectable == rhs.selectable && lhs.drafts === rhs.drafts
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
                .contextMenu { Button("Copy item ID") { Clipboard.copy(value.ref, what: "Item ID") } }
                if !archive, let pairings = value.pairings, !pairings.isEmpty {
                    WorkPairingActions(ref: value.ref, pairings: pairings, project: value.project,
                                       pending: pending) { _ = perform($0) }.padding(.leading, 24)
                }
                if let detail, !detail.isEmpty {
                    Text(detail).font(.system(size: 11)).foregroundStyle(KitPalette.dim).lineLimit(2)
                        .padding(.leading, 24)
                }
                // The actions have their own line under the row: labelled buttons need the room, and they wrap.
                if showActions {
                    actions(ref: value.ref, title: value.title, state: value.state, accept: accept)
                        .padding(.leading, 24)
                }
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
                    Text(verbatim: value.title).font(.system(size: 12)).lineLimit(3)
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
                                                   weight: summary == nil ? .regular : .medium))
                        .lineLimit(summary == nil ? 3 : 2)
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
            if showsRef {
                Text(verbatim: value.slot ?? value.ref).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(KitPalette.faint).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if let summary {
                Text(verbatim: summary).font(.system(size: 11)).foregroundStyle(KitPalette.dim)
                    .fixedSize(horizontal: true, vertical: false)
            } else if let worker = value.worker {
                Text(worker).font(.system(size: 11)).foregroundStyle(KitPalette.dim).lineLimit(1)
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
        private func actions(ref: String, title: String, state: String, accept: Bool) -> some View {
            WrapLayout(spacing: 6) {
                if accept && state == "spotted" {
                    KitButton("Accept", symbol: "checkmark.circle", kind: .ghost, size: .small, tooltip: "Accept as open work") {
                        _ = perform(.accept(ref: ref))
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
                    let excluded = handoffs.excludedByItem[ref] ?? []
                    if excluded.count < handoffs.open.count {
                        MenuButton(items: {
                            let choices = handoffs.open.filter { !excluded.contains($0.ref) }
                            let byTitle = Dictionary(grouping: choices, by: \.title)
                            return choices.map { handoff in
                                let label = byTitle[handoff.title]?.count == 1 ? handoff.title : "\(handoff.title) (\(handoff.ref))"
                                return .action(label) { _ = perform(.addMember(ref: ref, handoff: handoff.ref)) }
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
            WorkReasonButton(kind: kind, title: title, busy: pending.contains(ref),
                             identifier: "work.reason.\(kind.purpose).\(ref)",
                             text: drafts.binding(.init(ref: ref, purpose: kind.purpose))) { value in
                await perform(kind.action(ref: ref, text: value)).value
            }
        }

    }

    private struct HandoffChoices: Equatable {
        struct Choice: Equatable {
            let ref: String
            let title: String
        }

        let open: [Choice]
        let excludedByItem: [String: Set<String>]

        init(snapshot: WorkSnapshotValue) {
            let openHandoffs = snapshot.openHandoffs
            open = openHandoffs.map { Choice(ref: $0.ref, title: $0.title) }
            var index: [String: Set<String>] = [:]
            for handoff in openHandoffs {
                index[handoff.ref, default: []].insert(handoff.ref)
                for member in handoff.members {
                    index[member.ref, default: []].insert(handoff.ref)
                }
            }
            excludedByItem = index
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

/// A button that asks for a reason or a proof in a popover before it acts. The text lives in the caller's draft
/// store, so a refused write, a dismissed popover and a redrawn row all keep it.
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

        /// This kind's part of a draft key and of an identifier.
        var purpose: String { rawValue.lowercased() }

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
    /// The inspector's actions are plain labelled buttons; a row's are small ghost buttons.
    var plain = false
    var identifier: String?
    /// The caller's draft. The row and the inspector of one item give the same one.
    @Binding var text: String
    /// True only when the service acknowledged this write.
    let action: (String) async -> Bool
    @State private var asking = false
    @State private var saving = false
    @State private var refused = false
    /// The editor's own copy of the draft: typing redraws this button only, never the row or the list around it.
    @State private var draft = ""
    @State private var presentation = UUID()
    @FocusState private var typing: Bool

    private var id: String { identifier ?? "work.reason.\(kind.purpose)" }
    /// The editor and the caller's draft change together.
    private var editor: Binding<String> { Binding(get: { draft }, set: { draft = $0; text = $0 }) }

    var body: some View {
        Group {
            if plain {
                Button(action: toggle) { Label(kind.rawValue, systemImage: kind.label.symbol) }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(kind.label.accessibility)
            } else {
                KitButton(kind.rawValue, symbol: kind.label.symbol, kind: .ghost, size: .small,
                          tooltip: "\(kind.rawValue) \(title)") { toggle() }
            }
        }
        .accessibilityLabel(kind.label.accessibility)
        .accessibilityHint(title)
        .accessibilityIdentifier(id)
        .disabled(busy || saving)
        .popover(isPresented: $asking, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 10) {
                Text(verbatim: "\(kind.rawValue) “\(title)”").font(.headline)
                Text(kind.label.prompt).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                TextEditor(text: $draft)
                    .font(.body)
                    .frame(minHeight: 58, maxHeight: 88)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(.secondary.opacity(0.4)).allowsHitTesting(false))
                    .accessibilityLabel(kind == .finish ? "Proof" : "Reason")
                    .accessibilityIdentifier("\(id).text")
                    .focused($typing)
                    // The popover only asks for this text: it takes the keys at once, no second click.
                    .onAppear { draft = text; typing = true }
                    .onChange(of: draft) { _, value in if text != value { text = value } }
                if refused { Text("Your text is here. Check the failure details in Work and try again.").font(.caption) }
                Text("Return adds a line. ⌘Return submits.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel") { asking = false }.keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("\(id).cancel")
                    Button(saving ? "Saving…" : kind.rawValue, action: confirm)
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(saving || busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("\(id).save")
                }
            }
            .frame(width: 320).padding(14)
        }
    }

    private func toggle() {
        guard !busy, !saving else { return }
        if !asking { presentation = UUID() }
        asking.toggle()
    }

    private func confirm() {
        guard !busy, !saving else { return }
        saving = true
        let shown = presentation
        Task { @MainActor in
            let saved = await Self.saveDraft(editor, using: action)
            saving = false
            refused = !saved
            // A refused write stays open, and so does a draft typed during the write or a popover opened again.
            if saved, draft.isEmpty, presentation == shown { asking = false }
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
