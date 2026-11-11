import SwiftUI
import GenesisToolsHost

/// One meeting: the header (title, time, project, labels, the editor and the export), the tabs, and the notices of
/// its actions floating over the tabs, so an answer never moves the rows under the pointer.
struct MeetingDetailView: View {
    @Bindable var detail: MeetingDetailModel
    let window: MeetingsWindowModel
    /// Below this width the header's two actions become icon buttons and the tabs share the width. At the window's
    /// minimum (900 pt) this column gets about 438 pt, and the labelled buttons and five 84 pt tabs needed more, so
    /// the split view drew the column wider than the window and cut Export, the last tab and the ends of lines.
    static let narrowWidth: CGFloat = 600
    @State private var narrow = false
    /// The column's width, for the trailing pane's rule (`trailingPane`).
    @State private var width: CGFloat = 0
    @Environment(\.meetingsDockInset) private var dockInset
    @AppStorage(MeetingsPreferences.Panes.transcriptPane.key) private var transcriptPaneSetting =
        MeetingsPreferences.Panes.transcriptPane.defaultValue.rawValue

    /// What the trailing pane shows beside the tab: the transcript beside the review rows (decision 2 of WaveB-Plan.md),
    /// or the settings side panel, which replaces it while open, as an inspector.
    enum TrailingPane: Equatable { case transcript, settings }

    /// The pane width, and the column width from which `auto` shows the transcript beside the rows: the rows keep about
    /// 500 pt. At the window's smallest size (900 pt) the column is about 438 pt, so the Transcript tab answers there.
    static let paneWidth: CGFloat = 320
    static let transcriptPaneMinWidth: CGFloat = 820

    static func trailingPane(tab: MeetingDetailModel.Tab, width: CGFloat, setting: MeetingsPreferences.Panes.TranscriptPane,
                             sidePanelOpen: Bool, hasTranscript: Bool = true) -> TrailingPane? {
        if sidePanelOpen { return .settings }
        // A meeting without a transcript has nothing for the pane: beside "No items yet" it was a second empty state
        // that said the same thing at another height.
        guard tab == .items, hasTranscript else { return nil }
        switch setting {
        case .always: return .transcript
        case .never: return nil
        case .auto: return width >= transcriptPaneMinWidth ? .transcript : nil
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                Divider()
                // The notices float inside the dock's inset too: put on the padded view, a bottom stack sat under the
                // playing dock, and an answer's Undo was never seen while the next row played.
                tabContent
                    .noticeStack(detail.notices, alignment: window.noticePlace.alignment)
                    .safeAreaPadding(.bottom, dockInset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .frameProbe("meetings.detail.content")
            }
            .onGeometryChange(for: Bool.self, of: { $0.size.width < Self.narrowWidth }) { narrow = $0 }
            if let pane = trailingPane {
                Divider()
                trailing(pane)
                    .safeAreaPadding(.bottom, dockInset)
                    .frame(width: Self.paneWidth)
                    .frame(maxHeight: .infinity)
                    .frameProbe("meetings.detail.trailing")
            }
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
        .sheet(item: $detail.pendingReach) { pending in ReachSheet(pending: pending, detail: detail) }
        .sheet(item: $detail.history) { history in HistorySheetView(detail: detail, history: history) }
        .onChange(of: window.meeting(detail.id)?.id) { _, _ in detail.listLanded(window.meeting(detail.id)) }
        .navigationTitle(detail.record.value?.displayTitle ?? window.meeting(detail.id)?.displayTitle ?? "Meeting")
    }

    private var trailingPane: TrailingPane? {
        Self.trailingPane(tab: detail.tab, width: width,
                          setting: MeetingsPreferences.Panes.TranscriptPane(rawValue: transcriptPaneSetting) ?? .auto,
                          sidePanelOpen: window.sidePanelOpen, hasTranscript: window.meeting(detail.id)?.hasTranscript ?? true)
    }

    @ViewBuilder
    private func trailing(_ pane: TrailingPane) -> some View {
        switch pane {
        case .transcript: TranscriptPane(detail: detail)
        case .settings: MeetingsSidePanel(window: window, detail: detail)
        }
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
                headerAction("History", symbol: "clock.arrow.circlepath",
                             tooltip: "Every decision on this meeting: who made it, when and why, each with an Undo",
                             identifier: "meetings.detail.history") { detail.openHistory() }
                headerAction("Export", symbol: "square.and.arrow.up", tooltip: exportTooltip(record),
                             identifier: "meetings.detail.export") { detail.export() }
                    .disabled(record == nil || detail.isBusy("export"))
            }
            if window.liveUpdatesOff {
                // R36, G46: without events a row decided elsewhere would not change; say so, with the way back.
                HStack(spacing: 8) {
                    Label("Live updates off: changes made elsewhere show after a reload", systemImage: "antenna.radiowaves.left.and.right.slash")
                        .font(.system(size: 12)).foregroundStyle(KitPalette.modified)
                    Button("Reload") { window.reloadAll() }.buttonStyle(.link).font(.system(size: 12))
                        .accessibilityIdentifier("meetings.detail.reload")
                }
            }
            // The time, the badges, the project and the labels share one wrapping line. The project and the labels had a
            // line of their own, so a 900 x 600 window spent about 240 of its 600 pt on the header.
            WrapLayout(spacing: 8, lineSpacing: 8) {
                Text(verbatim: whenLine(overview)).font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                if let overview { MeetingBadgesView(meeting: overview, open: { detail.show($0) }) }
                if let reason = record?.recording?.stopReason, reason == "failed" || reason == "error" {
                    Badge("Recording failed", color: KitPalette.removed, symbol: "exclamationmark.triangle")
                        .instantTooltip("The screen recording stopped by itself (\(reason)); the frames until then are kept.")
                }
                projectPicker(record)
                labelsPicker(record)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
            GenSegmentedTabs("Meeting tab", items: MeetingDetailModel.Tab.allCases.map { tabItem($0, record) },
                             selection: Binding(get: { detail.tab }, set: { detail.show($0) }), minSegmentWidth: narrow ? 0 : 84,
                             identifier: "meetings.detail.tabs", fillsWidth: narrow, size: narrow ? .regular : .large)
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

    /// A tab with its glyph (a wide header only) and its count: the open rows of Items in the colour of a question,
    /// the files of Context without one.
    private func tabItem(_ tab: MeetingDetailModel.Tab, _ record: MeetingRecordView?) -> GenSegmentedTabs<MeetingDetailModel.Tab>.Item {
        var count: Int?
        var hue = KitHue.neutral
        if let record {
            switch tab {
            case .items:
                count = detail.rows.value?.rows.filter(\.isOpen).count ?? record.items.filter { $0.status == "suggested" }.count
                hue = .ask
            case .context: count = record.context.count
            default: break
            }
        }
        return .init(tab, tab.title, symbol: narrow ? nil : tab.symbol, count: count == 0 ? nil : count, hue: hue)
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
        // The labels are items of the header's wrapping line, so many labels wrap to a new row; in an HStack the last
        // ones were squeezed until "+ Label" broke into two lines (2026-11-05).
        return Group {
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
        .onChange(of: open) { _, isOpen in
            // A refused label or a popover closed by hand must not close a later one when that label arrives.
            if !isOpen { pending = nil }
        }
    }

    private func commit() {
        switch LabelCommit(typed: text, labels: labels) {
        case .nothing:
            return
        case .present:
            text = ""
            open = false
        case .add(let label):
            pending = label
            add(label)
        }
    }
}

/// What Return in the "+ Label" field does: nothing for an empty field, close for a label the meeting has already (an
/// add would change nothing, so the popover would wait forever), else add it.
enum LabelCommit: Equatable {
    case nothing
    case present
    case add(String)

    init(typed: String, labels: [String]) {
        let label = typed.trimmingCharacters(in: .whitespaces)
        if label.isEmpty {
            self = .nothing
        } else if labels.contains(label) {
            self = .present
        } else {
            self = .add(label)
        }
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

/// A pane's read state in one place: the content, a spinner with what is being read, or the error with Retry.
struct LoadablePane<Value: Equatable, Content: View>: View {
    let state: Loadable<Value>
    let reading: String
    let retry: () -> Void
    var noSource: NoTranscriptSource? = nil
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        if let noSource, state.failure?.code == NoTranscriptSource.code {
            EmptyState(symbol: "waveform.slash", text: "This meeting has no \(noSource.what)",
                       // The window has no link action, so the text names the command: it said only that linking helps.
                       detail: "It has no linked source with a transcript or audio, so there is nothing to list yet. Its Wispr Flow meeting brings both. Link it in a terminal:\ntools meetings link <meeting> wisprflow:<id>",
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
