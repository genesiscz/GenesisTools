import Foundation
import SwiftUI

/// Owned by WorkMain, outside the beside/replace branches. Selection and resizing do not discard drafts.
/// The rows of the Items pane and the inspector share it: one draft for each item and purpose.
@MainActor
public final class WorkItemInspectorDrafts: ObservableObject {
    struct Key: Hashable { var ref: String; var purpose: String }
    private struct Draft { var text = ""; var revision = UUID() }
    @Published private var values: [Key: Draft] = [:]
    @Published fileprivate var sending: Set<Key> = []

    public init() {}

    func binding(_ key: Key) -> Binding<String> {
        Binding(get: { self.values[key]?.text ?? "" }, set: {
            self.values[key] = Draft(text: $0, revision: UUID())
        })
    }

    /// Capture both text and revision at the press, before the task or a newer edit can run.
    @discardableResult
    func submit(_ key: Key, write: @escaping @MainActor (String) async -> Bool) -> Task<Bool, Never>? {
        guard let draft = values[key], !sending.contains(key) else { return nil }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        sending.insert(key)
        return Task {
            defer { sending.remove(key) }
            let ok = await write(text)
            if ok, values[key]?.revision == draft.revision { values[key] = nil }
            return ok
        }
    }
}

/// The content of the host's trailing inspector or replacement pane. The host owns "All items" and the title bar.
@MainActor
public struct WorkItemInspector: View {
    @ObservedObject private var model: WorkScreenModel
    @ObservedObject private var drafts: WorkItemInspectorDrafts
    private let projectRoot: String?
    private let openCommit: (String) -> Void
    private let openPullRequest: (String) -> Void
    @FocusState private var commentFocused: Bool
    private let externalLink: (String, URL) -> AnyView

    public init(model: WorkScreenModel, drafts: WorkItemInspectorDrafts, projectRoot: String?,
                openCommit: @escaping (String) -> Void,
                openPullRequest: @escaping (String) -> Void,
                externalLink: @escaping (String, URL) -> AnyView) {
        self.model = model
        self.drafts = drafts
        self.projectRoot = projectRoot
        self.openCommit = openCommit
        self.openPullRequest = openPullRequest
        self.externalLink = externalLink
    }

    public var body: some View {
        Group {
            if let ref = model.itemRef {
                if let detail = model.itemDetail {
                    ScrollView {
                        contents(detail, ref: ref)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .scrollOverflowContent()
                    }
                    .scrollOverflowHints()
                    .id(ref)
                } else if let failure = model.failure {
                    FailureInline(.unexpected(failure, outcome: "Could not read \(ref)", action: "Read the item"),
                                  form: .pane, identifier: "work.detail.failure") { model.reload() }
                } else {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Reading the item").font(.callout).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("work.detail.loading")
                }
            } else {
                EmptyState(symbol: "sidebar.trailing", text: "Select an item",
                           detail: "Its fields, tasks, references and history show here.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("work.item-inspector")
    }

    private func contents(_ detail: WorkItemDetail, ref: String) -> some View {
        LazyVStack(alignment: .leading, spacing: 20) {
            if let parent = model.parentRef {
                Button(action: model.returnToContainer) {
                    Label(model.title(for: parent) ?? "Back to container", systemImage: "chevron.left")
                        .font(.callout).lineLimit(1)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Return to the container")
                .accessibilityLabel("Return to container")
                .accessibilityIdentifier("work.detail.container-back")
                .frameProbe("work.detail.container-back")
            }
            itemHeading(detail.item, ref: ref)
            if let previous = model.movedFrom {
                VStack(alignment: .leading, spacing: 6) {
                    Label("This item is no longer in \(previous)", systemImage: "arrow.right.circle")
                        .font(.callout).fixedSize(horizontal: false, vertical: true)
                    Button("Open it", action: model.openMovedItem)
                        .buttonStyle(.genHoverPlain())
                        .accessibilityIdentifier("work.detail.open-moved")
                }
            }
            if let failure = model.failure {
                FailureInline(.unexpected(failure, outcome: "Could not refresh this item", action: "Read the item"),
                              form: .compact, identifier: "work.detail.refresh-failure") { model.reload() }
            }
            actions(detail, ref: ref)
            let pairings = model.pairings(for: ref)
            if !pairings.isEmpty {
                section("Connections") {
                    WorkPairingActions(ref: ref, pairings: pairings, project: detail.item.project,
                                       pending: model.pending) { action in
                        Task { await model.perform(action) }
                    }
                }
            }
            fields(detail.item)
            if let body = detail.item.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               body != detail.item.title {
                section("Description") { WorkInspectorMarkdown(text: body) }
            }
            if let members = detail.members, !members.isEmpty {
                section("Tasks") {
                    ForEach(members) { member in
                        WorkInspectorMember(row: member) { model.selectMember(member.ref) }.equatable()
                    }
                }
            }
            if !detail.refs.isEmpty {
                section("References") { references(detail.refs) }
            }
            if !detail.pointers.isEmpty {
                section("Commits and files") {
                    ForEach(detail.pointers) { pointer in pointerRow(pointer) }
                }
            }
            if !detail.log.isEmpty {
                section("History") { WorkInspectorHistory(events: detail.log) }
            }
            comment(ref: ref)
        }
        .font(.system(size: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("work.detail.\(detail.item.id)")
    }

    private func itemHeading(_ item: WorkItemDetail.Item, ref: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: WorkStateLook.symbol(item.state))
                    .font(.system(size: 19)).foregroundStyle(WorkStateLook.color(item.state))
                    .accessibilityHidden(true)
                Text(verbatim: item.title)
                    .font(.title3.weight(.semibold)).textSelection(.enabled)
                    .lineLimit(3).clipped()
                    .instantTooltip(item.title)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            WrapLayout(spacing: 8, lineSpacing: 6) {
                Text(WorkWords.type(item.type)).foregroundStyle(.secondary)
                Label(WorkWords.state(item.state), systemImage: WorkStateLook.symbol(item.state))
                    .foregroundStyle(WorkStateLook.color(item.state))
                if let severity = item.severity {
                    Badge(WorkWords.severity(severity),
                          color: ["critical", "high"].contains(severity) ? KitPalette.removed : KitPalette.dim,
                          look: .tone)
                }
                CopyChip(label: ref, value: ref, tooltip: "Copy item reference", what: "item reference")
                    .accessibilityIdentifier("work.detail.copyRef")
                if let project = item.project { Text(verbatim: project).foregroundStyle(.secondary) }
                if let revision = item.rev {
                    Text("Revision \(revision)").foregroundStyle(.secondary).monospacedDigit()
                }
            }
            .font(.system(size: 11))
            if let worker = item.worker, !worker.isEmpty {
                Label(worker, systemImage: "person.crop.circle").foregroundStyle(.secondary)
            }
            if let tags = item.tags, !tags.isEmpty {
                Text(verbatim: tags.joined(separator: " · ")).font(.system(size: 11))
                    .foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }

    private func actions(_ detail: WorkItemDetail, ref: String) -> some View {
        let state = detail.item.state
        let handoffClaim = detail.item.type == "handoff" || detail.refs.contains {
            ($0.kind == "member-of" && $0.outgoing) || ($0.kind == "member" && !$0.outgoing)
        }
        let claimed = detail.item.worker?.isEmpty == false || state == "active"
        let pending = model.pending.contains(ref)
        let handoffs = model.snapshot?.openHandoffs.filter { handoff in
            handoff.ref != ref && !handoff.members.contains { $0.ref == ref }
        } ?? []
        return VStack(alignment: .leading, spacing: 6) {
            WrapLayout(spacing: 8, lineSpacing: 6) {
                if state == "spotted" {
                    action("Accept", symbol: "checkmark.circle", id: "accept", pending: pending) {
                        await model.write(.accept(ref: ref))
                    }
                }
                if ["open", "reopened"].contains(state), !claimed {
                    action("Claim", symbol: "person.crop.circle.badge.checkmark", id: "claim", pending: pending) {
                        await model.write(.claim(ref: ref))
                    }
                }
                if state == "active" || (handoffClaim && claimed && ["open", "reopened"].contains(state)) {
                    action("Release", symbol: "person.crop.circle.badge.minus", id: "release", pending: pending) {
                        await model.write(.release(ref: ref))
                    }
                }
                if ["open", "active", "reopened"].contains(state) {
                    reason(.finish, ref: ref, title: detail.item.title, pending: pending)
                }
                if ["done", "dropped"].contains(state) {
                    reason(.reopen, ref: ref, title: detail.item.title, pending: pending)
                }
                if ["spotted", "open", "active", "reopened"].contains(state) {
                    if detail.item.type != "handoff", model.snapshot?.project == detail.item.project, !handoffs.isEmpty {
                        MenuButton(items: {
                            handoffs.map { handoff in
                                .action("\(handoff.title) (\(handoff.ref))") {
                                    Task { await model.write(.addMember(ref: ref, handoff: handoff.ref)) }
                                }
                            }
                        }) { Label("Add to handoff", systemImage: "tray.and.arrow.down") }
                            .instantTooltip("Add this item to a handoff as one of its tasks")
                            .accessibilityLabel("Add to handoff")
                            .accessibilityIdentifier("work.detail.action.add-member")
                            .disabled(pending)
                    }
                    reason(.drop, ref: ref, title: detail.item.title, pending: pending)
                }
            }
            if pending {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Saving this item").foregroundStyle(.secondary)
                }
                .font(.system(size: 11)).accessibilityIdentifier("work.detail.saving")
            }
            if ["open", "active", "reopened"].contains(state), handoffClaim {
                Text("Claiming or releasing applies to the handoff and its tasks.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func action(_ title: String, symbol: String, id: String, pending: Bool,
                        write: @escaping @MainActor () async -> Bool) -> some View {
        Button { Task { await write() } } label: { Label(title, systemImage: symbol) }
            .buttonStyle(.genHoverPlain())
            .disabled(pending)
            .accessibilityIdentifier("work.detail.action.\(id)")
    }

    /// The same button and the same draft as the item's row: a reason typed in one place is there in the other.
    private func reason(_ kind: WorkReasonButton.Kind, ref: String, title: String, pending: Bool) -> some View {
        let key = WorkItemInspectorDrafts.Key(ref: ref, purpose: kind.purpose)
        return WorkReasonButton(kind: kind, title: title, busy: pending, plain: true,
                                identifier: "work.detail.action.\(kind.purpose)", text: drafts.binding(key)) { value in
            await model.write(kind.action(ref: ref, text: value))
        }
        .id(key)
    }

    @ViewBuilder private func fields(_ item: WorkItemDetail.Item) -> some View {
        let values = item.fields ?? [:]
        if let value = nonempty(values["where"]) {
            section("Where") { WorkInspectorPath(value: value, root: projectRoot) }
        }
        if let value = nonempty(values["why"]) { textSection("Why", value) }
        if let value = nonempty(values["userSees"]) { textSection("What a user sees", value) }
        if let value = nonempty(item.acceptance) { textSection("Acceptance", value) }
        ForEach(values.keys.filter { !["where", "why", "userSees"].contains($0) }.sorted(), id: \.self) { key in
            if let value = nonempty(values[key]) { textSection(WorkWords.field(key), value) }
        }
    }

    private func references(_ refs: [WorkItemDetail.Ref]) -> some View {
        let groups = Dictionary(grouping: refs, by: { WorkWords.ref(kind: $0.kind, outgoing: $0.outgoing) })
        return VStack(alignment: .leading, spacing: 12) {
            ForEach(groups.keys.sorted(), id: \.self) { kind in
                VStack(alignment: .leading, spacing: 3) {
                    Text(kind).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    ForEach(groups[kind] ?? []) { reference in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: model.title(for: reference.other) ?? reference.other)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if model.title(for: reference.other) != nil {
                                Text(verbatim: reference.other).font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            if let by = reference.byTitle, !by.isEmpty {
                                Text(verbatim: "Linked by \(by)").font(.system(size: 11)).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4).contentShape(Rectangle())
                        .rowButton(cornerRadius: 4) { model.select(reference.other) }
                        .accessibilityIdentifier("work.detail.reference.\(reference.id)")
                        .liveRow(selected: false)
                    }
                }
            }
        }
    }

    @ViewBuilder private func pointerRow(_ pointer: WorkItemDetail.Pointer) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(WorkWords.pointer(pointer.kind)).font(.system(size: 11)).foregroundStyle(.secondary)
            if pointer.kind == "commit" {
                Button { openCommit(pointer.target) } label: {
                    Label(pointer.target, systemImage: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open commit \(pointer.target)")
                .accessibilityIdentifier("work.detail.commit.\(pointer.target)")
            } else if pointer.kind == "file" {
                WorkInspectorPath(value: pointer.target, root: projectRoot)
            } else if ["pr", "url"].contains(pointer.kind), let url = URL(string: pointer.target),
                      ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil {
                externalLink(pointer.target, url)
                    .accessibilityIdentifier("work.detail.link.\(pointer.id)")
            } else if pointer.kind == "pr",
                      pointer.target.range(of: #"^[^\s#!]+/[^\s/#!]+[#!][1-9][0-9]*$"#,
                                           options: .regularExpression) != nil {
                Button { openPullRequest(pointer.target) } label: {
                    Label(pointer.target, systemImage: "arrow.triangle.pull")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Open pull request \(pointer.target)")
                .accessibilityIdentifier("work.detail.pr.\(pointer.target)")
            } else {
                Text(verbatim: pointer.target).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
        .liveRow(selected: false)
    }

    private func comment(ref: String) -> some View {
        let key = WorkItemInspectorDrafts.Key(ref: ref, purpose: "comment")
        let text = drafts.binding(key)
        let pending = model.pending.contains(ref) || drafts.sending.contains(key)
        return section("Comment") {
            TextField("Add a comment", text: text, axis: .vertical)
                .focused($commentFocused)
                .textFieldStyle(.roundedBorder).lineLimit(2...6)
                .accessibilityLabel("Comment")
                .accessibilityIdentifier("work.detail.comment")
            HStack(spacing: 8) {
                Text("Return adds a line. ⌘Return sends.").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button { sendComment(key) } label: { Label("Comment", systemImage: "paperplane") }
                    .buttonStyle(.genHoverPlain())
                    .keyboardShortcut(commentFocused ? KeyboardShortcut(.return, modifiers: .command) : nil)
                    .instantTooltip("Add comment (⌘Return)")
                    .disabled(pending || text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("work.detail.comment.send")
            }
        }
    }

    private func sendComment(_ key: WorkItemInspectorDrafts.Key) {
        guard !model.pending.contains(key.ref) else { return }
        drafts.submit(key) { text in await model.write(.comment(ref: key.ref, text: text)) }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 12, weight: .semibold)).accessibilityAddTraits(.isHeader)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func textSection(_ title: String, _ text: String) -> some View {
        section(title) { Text(verbatim: text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
    }

    private func nonempty(_ value: String?) -> String? {
        value.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    }
}

private struct WorkInspectorMember: View, Equatable {
    let row: WorkRowValue
    let select: () -> Void
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: WorkStateLook.symbol(row.state)).foregroundStyle(WorkStateLook.color(row.state))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: row.title).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: [row.slot ?? row.ref, WorkWords.state(row.state), row.worker]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .padding(.vertical, 4).contentShape(Rectangle())
        .rowButton(cornerRadius: 4, select)
        .accessibilityLabel(row.title)
        .accessibilityValue(WorkWords.state(row.state))
        .accessibilityIdentifier("work.detail.member.\(row.ref)")
        .frameProbe("work.detail.member.\(row.ref)")
        .liveRow(selected: false)
    }
}

private struct WorkInspectorHistory: View {
    let events: [WorkItemDetail.Event]
    @State private var expanded = false
    private var sorted: [WorkItemDetail.Event] {
        events.sorted { $0.ts == $1.ts ? $0.seq > $1.seq : $0.ts > $1.ts }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(sorted.prefix(30))) { event in WorkInspectorEvent(event: event).equatable() }
            if events.count > 30 {
                GenDisclosure(isExpanded: $expanded, identifier: "work.detail.history.more", accessibilityTitle: "All history") {
                    ForEach(Array(sorted.dropFirst(30))) { event in WorkInspectorEvent(event: event).equatable() }
                } label: { Text(expanded ? "Show less" : "Show all history (\(events.count))").font(.callout) }
            }
        }
    }
}

private struct WorkInspectorEvent: View, Equatable {
    let event: WorkItemDetail.Event
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            (Text(verbatim: event.actor).fontWeight(.medium) + Text(verbatim: " \(event.action)"))
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            if let summary = event.summary, !summary.isEmpty {
                Text(verbatim: summary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            LiveAgo(date: event.ts, style: .brief).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .liveRow(selected: false)
    }
}

private struct WorkInspectorMarkdown: View {
    let text: String
    @State private var expanded = false
    @State private var height: CGFloat = 0
    private let previewHeight: CGFloat = 340 // Twenty 14 pt lines with 3 pt leading.

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !expanded {
                markdown.fixedSize(horizontal: false, vertical: true)
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: WorkInspectorMarkdownHeight.self, value: proxy.size.height)
                    })
                    .frame(maxHeight: previewHeight, alignment: .top).clipped()
            }
            if height > previewHeight || expanded {
                GenDisclosure(isExpanded: $expanded, identifier: "work.detail.description.more",
                              accessibilityTitle: "Full description") {
                    markdown
                } label: { Text(expanded ? "Show less" : "Show all").font(.callout) }
            }
        }
        .onPreferenceChange(WorkInspectorMarkdownHeight.self) { if $0 > 0 { height = $0 } }
    }

    @ViewBuilder private var markdown: some View {
        if let rendered = GenesisKit.host?.transcriptMarkdown(text, style: .sessionTranscript) {
            rendered
        } else {
            Text(.init(text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct WorkInspectorMarkdownHeight: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// File existence and symlink resolution happen in a task, never during a view-body read.
private struct WorkInspectorPath: View {
    let value: String
    let root: String?
    @State private var resolved: WorkInspectorResolvedPath?
    private var request: String { (root ?? "") + "\n" + value }

    var body: some View {
        Group {
            if let resolved, resolved.request == request {
                PathLabel(path: resolved.path, showIcons: false, line: resolved.line, title: value)
                    .accessibilityIdentifier("work.detail.path.\(value)")
            } else {
                Text(verbatim: value).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .task(id: request) {
            let value = value, root = root, request = request
            let result = await Task.detached(priority: .utility) {
                WorkInspectorResolvedPath.resolve(value, root: root, request: request)
            }.value
            guard !Task.isCancelled else { return }
            resolved = result
        }
    }
}

private struct WorkInspectorResolvedPath: Sendable {
    var request: String
    var path: String
    var line: Int?

    static func resolve(_ raw: String, root: String?, request: String) -> Self? {
        guard let root, !root.isEmpty, !raw.contains("\n") else { return nil }
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var line: Int?
        if let colon = value.lastIndex(of: ":"), let number = Int(value[value.index(after: colon)...]), number > 0 {
            line = number
            value = String(value[..<colon])
            // path:line:column is accepted, and PathLabel opens its line.
            if let second = value.lastIndex(of: ":"), let number = Int(value[value.index(after: second)...]), number > 0 {
                line = number
                value = String(value[..<second])
            }
        }
        let base = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL.resolvingSymlinksInPath()
        let file = value.hasPrefix("/") ? URL(fileURLWithPath: value) : base.appendingPathComponent(value)
        let canonical = file.standardizedFileURL.resolvingSymlinksInPath()
        let prefix = base.path == "/" ? "/" : base.path + "/"
        guard canonical.path == base.path || canonical.path.hasPrefix(prefix),
              FileManager.default.fileExists(atPath: canonical.path) else { return nil }
        return Self(request: request, path: canonical.path, line: line)
    }
}
