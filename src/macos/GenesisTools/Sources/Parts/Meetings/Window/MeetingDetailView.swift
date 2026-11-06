import SwiftUI
import GenesisToolsHost

/// One meeting: the header (title, time, project, labels, the editor and the export), the tabs, and the note of the
/// last action on the pane that ran it.
struct MeetingDetailView: View {
    @Bindable var detail: MeetingDetailModel
    let window: MeetingsWindowModel
    /// Below this width the header's two actions become icon buttons and the tabs share the width. At the window's
    /// minimum (900 pt) this column gets about 438 pt, and the labelled buttons and five 84 pt tabs needed more, so
    /// the split view drew the column wider than the window and cut Export, the last tab and the ends of lines.
    static let narrowWidth: CGFloat = 600
    @State private var narrow = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if let notice = detail.notice {
                NoticePill(text: notice.text, detail: notice.detail, more: notice.more, tone: notice.tone,
                           fixes: notice.actionTitle.map { title in
                               [NoticeFix.button(title, symbol: notice.actionSymbol) {
                                   detail.notice = nil
                                   notice.action?()
                               }]
                           } ?? []) { detail.notice = nil }
                    .padding(.horizontal, 14).padding(.top, 8)
                    .id(notice.id)
            }
            tabContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onGeometryChange(for: Bool.self, of: { $0.size.width < Self.narrowWidth }) { narrow = $0 }
        .navigationTitle(detail.record.value?.displayTitle ?? window.meeting(detail.id)?.displayTitle ?? "Meeting")
    }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        let overview = window.meeting(detail.id)
        let record = detail.record.value
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(verbatim: record?.displayTitle ?? overview?.displayTitle ?? "")
                    .font(.system(size: 17, weight: .semibold)).lineLimit(2).textSelection(.enabled)
                Spacer(minLength: 8)
                if overview?.hasRecording == true, AppParts.isLinked("recorder") {
                    headerAction("Open in the recorder editor", symbol: "film",
                                 tooltip: "Open the screen recording as an editor project, with the transcript as captions",
                                 identifier: "meetings.detail.recorder") { detail.openInRecorder() }
                        .disabled(detail.isBusy("recorder"))
                }
                headerAction("Export", symbol: "square.and.arrow.up", tooltip: exportTooltip(record),
                             identifier: "meetings.detail.export") { detail.export() }
                    .disabled(record == nil || detail.isBusy("export"))
            }
            WrapLayout(spacing: 8, lineSpacing: 8) {
                Text(verbatim: whenLine(overview)).font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                if let overview { MeetingBadgesView(meeting: overview, open: { detail.show($0) }) }
                if let reason = record?.recording?.stopReason, reason == "failed" || reason == "error" {
                    Badge("Recording failed", color: KitPalette.removed, symbol: "exclamationmark.triangle")
                        .instantTooltip("The screen recording stopped by itself (\(reason)); the frames until then are kept.")
                }
            }
            HStack(spacing: 10) {
                projectPicker(record)
                labelsPicker(record).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let failure = detail.record.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { detail.reloadRecord() }])
            }
            // The picker lists the proposals and the known projects; a failed read of either says so here, so a short
            // list is never mistaken for the whole one.
            ForEach(MeetingsUnread.of([(.proposals, detail.proposals.failure), (.projects, window.settings.failure)]), id: \.source) { unread in
                NoticePill(text: unread.text, more: unread.failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") {
                               if unread.source == .proposals { detail.loadProposals() } else { window.loadSettings() }
                           }])
            }
            GenSegmentedTabs("Meeting tab", items: MeetingDetailModel.Tab.allCases.map { GenSegmentedTabs.Item($0, tabTitle($0, record)) },
                             selection: Binding(get: { detail.tab }, set: { detail.show($0) }), minSegmentWidth: narrow ? 0 : 84,
                             identifier: "meetings.detail.tabs", fillsWidth: narrow)
                .frameProbe("meetings.detail.tabs")
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
        .frameProbe("meetings.detail.header")
    }

    /// A labelled action, or its icon with the same words as tooltip and label when the column is narrow.
    @ViewBuilder
    private func headerAction(_ title: String, symbol: String, tooltip: String, identifier: String,
                              action: @escaping () -> Void) -> some View {
        if narrow {
            IconButton(systemName: symbol, tooltip: "\(title): \(tooltip)", action: action)
                .accessibilityLabel(title)
                .accessibilityIdentifier(identifier)
        } else {
            GhostButton(title, symbol: symbol, tooltip: tooltip, identifier: identifier, action: action)
        }
    }

    private func whenLine(_ meeting: OverviewMeeting?) -> String {
        guard let meeting else { return "" }
        return [MeetingsFormat.dayTitle(meeting.day), MeetingsFormat.time(meeting.start), MeetingsFormat.length(meeting.durationSec)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func exportTooltip(_ record: MeetingRecordView?) -> String {
        guard let project = record?.project else { return "Write the polished transcript as a markdown note; it asks where" }
        if let folder = window.settings.value?.projects[project]?.export?.folder {
            return "Write the polished transcript into \((folder as NSString).abbreviatingWithTildeInPath)"
        }
        return "Write the polished transcript as a markdown note; it asks for the \(project) folder once"
    }

    private func tabTitle(_ tab: MeetingDetailModel.Tab, _ record: MeetingRecordView?) -> String {
        guard let record else { return tab.title }
        switch tab {
        case .items:
            let open = record.items.filter { $0.status == "suggested" }.count
            return open > 0 ? "Items \(open)" : "Items"
        case .context: return record.context.isEmpty ? "Context" : "Context \(record.context.count)"
        default: return tab.title
        }
    }

    private func projectPicker(_ record: MeetingRecordView?) -> some View {
        let current = record?.project
        let proposed = detail.proposals.value?.proposals.projects ?? []
        let known = window.settings.value?.projectNames ?? []
        return MenuButton(items: {
            var items: [MenuButtonItem] = []
            // A meeting with a project reads its proposals only now (or on the hover before): say so in the menu.
            detail.ensureProposals()
            if proposed.isEmpty, detail.proposals.isLoading {
                items.append(.note("Reading the proposed projects…"))
                items.append(.divider)
            }
            if !proposed.isEmpty {
                items.append(.note("Proposed"))
                items += proposed.map { proposal in
                    .action("\(proposal.project)  (\(Int(proposal.score.rounded())) points)", checked: proposal.project == current) {
                        detail.setProject(proposal.project)
                    }
                }
                items.append(.divider)
            }
            items += known.filter { name in !proposed.contains { $0.project == name } }.map { name in
                .action(name, checked: name == current) { detail.setProject(name) }
            }
            items.append(.divider)
            items.append(.action("No project", checked: current == nil) { detail.setProject(nil) })
            return items
        }) {
            pickerLabel(symbol: "folder", text: current ?? "No project", warn: current == nil)
        }
        .disabled(record == nil || detail.isBusy("project"))
        .onHover { if $0 { detail.ensureProposals() } }
        .instantTooltip("The meeting's project: its dictionary, labels and export folder apply")
        .accessibilityLabel("Project: \(current ?? "none")")
    }

    private func labelsPicker(_ record: MeetingRecordView?) -> some View {
        let labels = record?.labels ?? []
        let known = record?.project.flatMap { window.settings.value?.projects[$0]?.labels } ?? []
        let all = (known + labels.filter { !known.contains($0) })
        // A project with many labels wraps them to a new row; in an HStack the last ones were squeezed until
        // "+ Label" broke into two lines (2026-11-05).
        return WrapLayout(spacing: 6, lineSpacing: 6) {
            ForEach(all, id: \.self) { label in
                let on = labels.contains(label)
                Button {
                    detail.toggleLabel(label, on: !on)
                } label: {
                    Badge(label, color: on ? KitPalette.renamed : KitPalette.faint, look: on ? .filled : .tag,
                          symbol: on ? "checkmark" : "plus")
                }
                .buttonStyle(.genHoverPlain())
                .disabled(detail.isBusy("label.\(label)"))
                .instantTooltip(on ? "Remove the label \(label)" : "Add the label \(label)")
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            AddLabelButton(enabled: record?.project != nil, labels: record?.labels ?? []) { detail.toggleLabel($0, on: true) }
        }
    }

    private func pickerLabel(symbol: String, text: String, warn: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 11))
            Text(verbatim: text).font(.system(size: 12, weight: .medium))
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
        }
        .foregroundStyle(warn ? AnyShapeStyle(KitPalette.modified) : AnyShapeStyle(.primary))
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
    }

    // MARK: Tabs

    @ViewBuilder
    private var tabContent: some View {
        switch detail.tab {
        case .transcript: TranscriptTab(detail: detail)
        case .screen: ScreenTab(detail: detail)
        case .items: ItemsTab(detail: detail)
        case .speakers: SpeakersTab(detail: detail)
        case .context: ContextTab(detail: detail)
        }
    }
}

/// "+ Label": a popover with one field; Return adds, Esc closes. A new label joins the project's labels.
private struct AddLabelButton: View {
    let enabled: Bool
    /// The meeting's labels: the field clears and the popover closes once the new one is among them, so a refused
    /// label keeps what was typed.
    let labels: [String]
    let add: (String) -> Void
    @State private var open = false
    @State private var text = ""
    @State private var pending: String?
    @FocusState private var focused: Bool

    var body: some View {
        Button {
            open = true
        } label: {
            Label("Label", systemImage: "plus").font(.system(size: 12)).labelStyle(.titleAndIcon)
        }
        .buttonStyle(.genHoverPlain())
        .disabled(!enabled)
        .instantTooltip(enabled ? "Add a new label to this meeting and its project" : "Choose a project first: labels belong to a project")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            HStack {
                TextField("New label", text: $text)
                    .textFieldStyle(.roundedBorder).frame(width: 180)
                    .focused($focused)
                    .onSubmit(commit)
                Button("Add", action: commit).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)
            .onAppear { focused = true }
        }
        .onChange(of: labels) { _, now in
            guard let pending, now.contains(pending) else { return }
            self.pending = nil
            text = ""
            open = false
        }
    }

    private func commit() {
        let label = text.trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty else { return }
        pending = label
        add(label)
    }
}

/// What a pane says for a meeting with no source that has a transcript or audio, where the CLI answers
/// `[no-transcript-source]`: an empty state, not the refusal as an error.
struct NoTranscriptSource {
    /// What the pane would list ("transcript", "speakers").
    let what: String
    /// Opens the Screen tab; nil when the meeting has no screen recording either.
    let showScreen: (() -> Void)?

    static let code = "no-transcript-source"
}

struct LoadablePane<Value: Equatable, Content: View>: View {
    let state: Loadable<Value>
    let reading: String
    let retry: () -> Void
    var noSource: NoTranscriptSource? = nil
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        if let noSource, state.failure?.code == NoTranscriptSource.code {
            EmptyState(symbol: "waveform.slash", text: "This meeting has no \(noSource.what)",
                       detail: "It has no linked source with a transcript or audio, so there is nothing to list yet. Linking its Wispr Flow meeting brings both.",
                       actionTitle: noSource.showScreen == nil ? nil : "Show the screen recording", action: noSource.showScreen)
        } else {
            pane
        }
    }

    private var pane: some View {
        VStack(spacing: 0) {
            if let failure = state.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise", perform: retry)])
                    .padding(12)
            }
            if let value = state.value {
                content(value)
            } else if state.failure == nil {
                VStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(reading).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Spacer()
            }
        }
    }
}
