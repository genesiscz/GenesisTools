import SwiftUI

/// One meeting: the header (title, time, project, labels, the editor and the export), the tabs, and the note of the
/// last action on the pane that ran it.
struct MeetingDetailView: View {
    @Bindable var detail: MeetingDetailModel
    let window: MeetingsWindowModel

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
                if overview?.hasRecording == true {
                    GhostButton("Open in the recorder editor", symbol: "film", tooltip: "Open the screen recording as an editor project, with the transcript as captions",
                                identifier: "meetings.detail.recorder") { detail.openInRecorder() }
                        .disabled(detail.isBusy("recorder"))
                }
                GhostButton("Export", symbol: "square.and.arrow.up", tooltip: exportTooltip(record),
                            identifier: "meetings.detail.export") { detail.export() }
                    .disabled(record == nil || detail.isBusy("export"))
            }
            ChipFlow(spacing: 8) {
                Text(verbatim: whenLine(overview)).font(.system(size: 12).monospacedDigit()).foregroundStyle(.secondary)
                if let overview { MeetingBadgesView(meeting: overview) }
            }
            HStack(spacing: 10) {
                projectPicker(record)
                labelsPicker(record)
                Spacer(minLength: 0)
            }
            if let failure = detail.record.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { detail.reloadRecord() }])
            }
            GenSegmentedTabs("Meeting tab", items: MeetingDetailModel.Tab.allCases.map { GenSegmentedTabs.Item($0, tabTitle($0, record)) },
                             selection: Binding(get: { detail.tab }, set: { detail.show($0) }), minSegmentWidth: 84,
                             identifier: "meetings.detail.tabs")
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
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
            if !proposed.isEmpty {
                items.append(.note("Proposed"))
                items += proposed.map { proposal in
                    .action("\(proposal.project)  (\(Int((proposal.score * 100).rounded())) %)", checked: proposal.project == current) {
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
        .instantTooltip("The meeting's project: its dictionary, labels and export folder apply")
        .accessibilityLabel("Project: \(current ?? "none")")
    }

    private func labelsPicker(_ record: MeetingRecordView?) -> some View {
        let labels = record?.labels ?? []
        let known = record?.project.flatMap { window.settings.value?.projects[$0]?.labels } ?? []
        let all = (known + labels.filter { !known.contains($0) })
        return HStack(spacing: 6) {
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
            AddLabelButton(enabled: record?.project != nil) { detail.toggleLabel($0, on: true) }
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
    let add: (String) -> Void
    @State private var open = false
    @State private var text = ""
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
    }

    private func commit() {
        let label = text.trimmingCharacters(in: .whitespaces)
        guard !label.isEmpty else { return }
        add(label)
        text = ""
        open = false
    }
}

/// A pane's read state in one place: the content, a spinner with what is being read, or the error with Retry.
struct LoadablePane<Value: Equatable, Content: View>: View {
    let state: Loadable<Value>
    let reading: String
    let retry: () -> Void
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
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
