import SwiftUI

/// "Link a meeting…" of a meeting with no transcript source: the source meetings that started near it (the service's
/// `meeting.sources.near`), nearest first, one picked and linked with Link. A source meeting another record holds is
/// listed greyed with that record's title, since the engine refuses to share one. Replaces the terminal command the empty
/// state named (audit M9).
struct LinkSourceSheet: View {
    @Bindable var detail: MeetingDetailModel
    let close: () -> Void
    @State private var list: Loadable<MeetingsAPI.MeetingSourcesNear.Result>
    @State private var picked: String?
    @State private var linking = false
    @State private var failure: MeetingsCLI.Failure?

    /// `list`: a list read already (a snapshot); idle reads it when the sheet shows.
    init(detail: MeetingDetailModel, list: Loadable<MeetingsAPI.MeetingSourcesNear.Result> = .idle, close: @escaping () -> Void) {
        self.detail = detail
        self.close = close
        _list = State(initialValue: list)
        _picked = State(initialValue: list.value?.meetings.first { $0.linkedTo == nil }?.ref)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Link a meeting").font(.headline)
                Text(verbatim: subtitle)
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            content
                .frame(minHeight: 120, maxHeight: 320)
            if let failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [failure.detailsFix { link() }], dismiss: { self.failure = nil })
            }
            HStack {
                Spacer()
                Button("Cancel", action: close).keyboardShortcut(.cancelAction)
                Button(linking ? "Linking…" : "Link") { link() }
                    .disabled(chosen == nil || linking)
                    .instantTooltip(chosen == nil ? "Pick a meeting first" : "Link it: the transcript, the people and the times come from it")
                    .accessibilityIdentifier("meetings.link.confirm")
            }
        }
        .padding(16)
        .frame(width: 480)
        .task { if case .idle = list { await read() } }
    }

    private var subtitle: String {
        let start = detail.record.value.map { MeetingsFormat.dayTime($0.start) } ?? ""
        return "The source meetings that started within 3 hours of this one\(start.isEmpty ? "" : " (\(start))"). The link brings their transcript, people and times."
    }

    private var chosen: MeetingsAPI.MeetingSourcesNear.Candidate? {
        list.value?.meetings.first { $0.ref == picked && $0.linkedTo == nil }
    }

    @ViewBuilder
    private var content: some View {
        switch list {
        case .idle, .loading(previous: _):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reading the source meetings near this one…").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let error, previous: _):
            NoticePill(text: error.sentence, more: error.detail, tone: .error,
                       fixes: [.button("Retry", symbol: "arrow.clockwise") { Task { await read() } },
                               error.detailsFix { Task { await read() } }])
        case .loaded(let result):
            if result.meetings.isEmpty {
                EmptyState(symbol: "calendar.badge.exclamationmark", text: "No source meeting started near this one",
                           detail: result.unavailable.isEmpty ? "None started within 3 hours of its start."
                               : "\(result.unavailable.joined(separator: " and ")) keeps no list of meetings on this Mac.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(result.meetings) { candidate in row(candidate) }
                    }
                }
                .scrollOverflowContent()
                .scrollOverflowHints()
            }
        }
    }

    private func row(_ candidate: MeetingsAPI.MeetingSourcesNear.Candidate) -> some View {
        let taken = candidate.linkedTo != nil
        let selected = picked == candidate.ref
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(selected ? Color.accentColor : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: candidate.title).font(.system(size: 13)).lineLimit(1).truncationMode(.tail)
                Text(verbatim: Self.facts(candidate, start: detail.record.value?.start))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .rowButton(cornerRadius: 6) { picked = candidate.ref }
        .disabled(taken)
        .opacity(taken ? 0.55 : 1)
        .help(candidate.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("meetings.link.candidate")
    }

    /// "Wispr Flow · Thu 12 Nov 14:17 · 2 min before · 2 h 52 min", then "no transcript" or "linked to <title>".
    static func facts(_ candidate: MeetingsAPI.MeetingSourcesNear.Candidate, start: String?) -> String {
        var parts = [candidate.source, MeetingsFormat.dayTime(candidate.start)]
        if let offset = offsetWords(candidate.start, from: start) { parts.append(offset) }
        if let from = MeetingsFormat.date(candidate.start), let to = MeetingsFormat.date(candidate.end),
           let length = MeetingsFormat.length(to.timeIntervalSince(from)) {
            parts.append(length)
        }
        if !candidate.hasTranscript { parts.append("no transcript") }
        if let linked = candidate.linkedTo { parts.append("linked to “\(linked.title)”") }
        return parts.joined(separator: " · ")
    }

    /// "at the same minute", "2 min before", "1 h 05 min after".
    static func offsetWords(_ text: String, from start: String?) -> String? {
        guard let date = MeetingsFormat.date(text), let base = MeetingsFormat.date(start) else { return nil }
        let seconds = date.timeIntervalSince(base)
        guard abs(seconds) >= 60 else { return "at the same minute" }
        return "\(MeetingsFormat.length(abs(seconds)) ?? "") \(seconds < 0 ? "before" : "after")"
    }

    private func read() async {
        list = .loading(previous: nil)
        do {
            let result = try await detail.sourceMeetingsNear()
            list = .loaded(result)
            picked = result.meetings.first { $0.linkedTo == nil }?.ref
        } catch {
            list = .failed(asFailure(error), previous: nil)
        }
    }

    private func link() {
        guard let candidate = chosen, !linking else { return }
        linking = true
        failure = nil
        Task {
            defer { linking = false }
            do {
                try await detail.linkSource(candidate)
                close()
            } catch {
                failure = asFailure(error)
            }
        }
    }
}
