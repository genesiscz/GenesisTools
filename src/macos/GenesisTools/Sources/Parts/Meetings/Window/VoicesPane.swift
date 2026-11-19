import GenesisToolsHost
import SwiftUI

// MARK: - The voices of a meeting (P7): the project's people and their voice samples, what the voice model would name
// (Preview, nothing saved), its names as suggestions (Apply), and Confirm or Not this person on each suggested line.
// The pane calls the voices methods of the Meetings service (MeetingsAPI+Voices.swift), the same functions as
// `tools meetings voices`.

/// The preview and suggestion actions for one meeting. The window owns its scoped sample library separately.
@Observable
@MainActor
final class VoicesModel {
    enum Run: Equatable { case preview, apply }

    let meeting: String
    @ObservationIgnored weak var detail: MeetingDetailModel?
    var meetingOnlyOverride: Bool?
    private(set) var preview: Loadable<VoicesPreviewSummary> = .idle
    /// The pane is open in the meeting's trailing slot ("…" → "Voices…").
    var open = false
    /// The person the pane opens on and scrolls to (a voice row's sample count, U13); cleared once shown.
    var focus: String?
    /// The long call that runs now, and its newest step from the service's `$/progress`.
    var running: Run?
    var progress: MeetingsCallProgress?

    var busy: Set<String> = []

    /// The running Preview or Apply, so Cancel can stop it.
    @ObservationIgnored private var runTask: Task<Void, Never>?

    init(meeting: String, detail: MeetingDetailModel?) {
        self.meeting = meeting
        self.detail = detail
    }

    private var service: MeetingsService? { detail?.service }

    /// The lines the voice model would name now (`voices.preview`): saves nothing. A cold voice pass reports its steps.
    func runPreview() {
        guard running == nil else { return }
        guard let service else {
            preview = .failed(Self.noService, previous: preview.value)
            return
        }
        start(.preview)
        let previous = preview.value
        preview = .loading(previous: previous)
        runTask = Task {
            defer { finish() }
            do {
                let result = try await service.call(MeetingsAPI.VoicesPreview.self, .init(meeting: meeting)) { [weak self] step in
                    self?.progress = step
                }
                preview = .loaded(VoicesPreviewSummary(result.lines))
            } catch where Task.isCancelled || error is CancellationError {
                preview = previous.map { .loaded($0) } ?? .idle
            } catch {
                preview = .failed(asFailure(error), previous: preview.value)
            }
        }
    }

    /// The voice model's names as suggestions on the record (`voices.apply`). They stay suggestions with their score.
    func apply() {
        guard running == nil, let service else { return }
        start(.apply)
        runTask = Task {
            defer { finish() }
            do {
                let result = try await service.call(MeetingsAPI.VoicesApply.self, .init(meeting: meeting)) { [weak self] step in
                    self?.progress = step
                }
                detail?.refreshAfterDecision()
                detail?.notices.push(StackedNotice(text: Self.appliedText(result.added),
                                                   detail: result.warnings.isEmpty ? nil : result.warnings.joined(separator: "\n")))
            } catch where Task.isCancelled || error is CancellationError {
                detail?.notices.push(StackedNotice(text: "Stopped naming by voice; nothing was saved"))
            } catch {
                detail?.notices.push(.meetingsFailure(error) { [weak self] in self?.apply() })
            }
        }
    }

    /// Stops the running Preview or Apply: the service hears `$/cancel`, kills its voice workers and saves nothing.
    func cancelRun() {
        runTask?.cancel()
    }

    static func appliedText(_ added: Int) -> String {
        added == 0 ? "The voice model named no new lines"
            : "The voice model named \(Plural.count(added, "line")); each stays a suggestion until you confirm it"
    }

    private func start(_ run: Run) {
        running = run
        progress = nil
    }

    private func finish() {
        running = nil
        progress = nil
        runTask = nil
    }

    func play(from: Double, to: Double) {
        detail?.window?.player.play(.range(from: from, to: max(from, to)), in: meeting, from: .row)
    }

    /// Confirm keeps the voice model's name and keeps the line as a voice sample; Not this person rejects the name, and
    /// the engine does not give that line the name again. Either notice carries its Undo.
    func decide(_ items: [String], confirm: Bool) {
        guard let detail, !items.isEmpty else { return }
        let key = "decide.\(items.joined(separator: ","))"
        guard !busy.contains(key) else { return }
        busy.insert(key)
        var action = DecisionAction(kind: confirm ? "confirm" : "reject")
        action.items = items
        Task {
            defer { busy.remove(key) }
            do {
                let result = try await MeetingDetailModel.applyDecision(meeting: meeting, action: action, reason: nil,
                                                                       service: detail.service)
                detail.refreshAfterDecision()
                guard let entry = result.entry else { return }
                detail.ownTokens.insert(entry.token)
                detail.notices.push(StackedNotice(text: Self.decidedText(count: items.count, confirm: confirm),
                                                  actions: [.undo { [weak detail] id in detail?.revert(token: entry.token, items: nil, replacing: id) }]))
            } catch {
                detail.notices.push(.meetingsFailure(error) { [weak self] in self?.decide(items, confirm: confirm) })
            }
        }
    }

    /// The suggested voice names of `person` on the lines of a stretch: what a transcript chip's Confirm or Not acts on.
    /// Read at the click, never in a body.
    func items(named person: String, in stretch: DecisionAction.Stretch) -> [String] {
        (detail?.record.value?.items ?? []).compactMap { item in
            guard item.kind == "speaker-range", item.status == "suggested", item.rules?.contains("voice-embedding") == true,
                  item.speaker == person, let from = item.fromSec, from >= stretch.fromSec - 0.01, from <= stretch.toSec + 0.01,
                  stretch.label == nil || item.label == stretch.label else { return nil }
            return item.id
        }
    }

    static func decidedText(count: Int, confirm: Bool) -> String {
        confirm ? "Confirmed \(Plural.count(count, "line")) by ear. Eligible samples will be learned in the background."
            : "Marked \(Plural.count(count, "line")) as not this person; the voice model will not name \(count == 1 ? "it" : "them") so again"
    }

    static let noService = MeetingsCLI.Failure(
        sentence: "Voices need the Meetings service, and it does not answer yet. Try again in a moment.",
        detail: "voices.* has no command form in the window")
}

/// A preview's lines with their counts, made once when it lands.
struct VoicesPreviewSummary: Equatable {
    let lines: [VoicePreviewLine]
    let named: Int
    /// Per person without a sample: the lines that wait for one.
    let waiting: [String: Int]
    let open: Int

    init(_ lines: [VoicePreviewLine]) {
        self.lines = lines
        named = lines.lazy.filter { $0.person != nil }.count
        var waiting: [String: Int] = [:]
        for line in lines { if let person = line.waitsFor { waiting[person, default: 0] += 1 } }
        self.waiting = waiting
        open = lines.count - named
    }

    /// "312 lines: 140 named, 172 left open".
    var headline: String {
        "\(Plural.count(lines.count, "line")): \(named) named, \(open) left open"
    }
}

/// A line the voice model named on the record: its item, the line, the name, the score and where it stands.
struct VoiceNamedLine: Equatable, Identifiable {
    let id: String
    let fromSec: Double
    let toSec: Double
    let speaker: String
    let score: Double?
    let state: DecisionState
    let text: String?

    /// The voice model's speaker ranges of the record, in time order, with the words of their line when the transcript
    /// is read. Made once per change of the items or the transcript.
    static func of(items: [MeetingItem], entries: [TranscriptLine]?) -> [VoiceNamedLine] {
        items.compactMap { item -> VoiceNamedLine? in
            guard item.kind == "speaker-range", item.rules?.contains("voice-embedding") == true, let speaker = item.speaker,
                  let from = item.fromSec else { return nil }
            let line = number(item.evidence?["transcriptLine"]).map { Int($0) }
            let end = number(item.evidence?["endSec"])
            let score = number(item.evidence?["score"]) ?? item.confidence
            let text = line.flatMap { index in entries.flatMap { $0.indices.contains(index) ? $0[index].text : nil } }
            return VoiceNamedLine(id: item.id, fromSec: from, toSec: end ?? item.toSec ?? from, speaker: speaker, score: score,
                                  state: DecisionState.of(status: item.status), text: text)
        }
        .sorted { $0.fromSec < $1.fromSec }
    }

    private static func number(_ value: JSONValue?) -> Double? {
        if case .number(let number) = value { return number }
        return nil
    }
}

/// The mark of a name the voice model gave: the waveform glyph and the score, in the tentative hue (ux 12a), so a model
/// name never looks like a confirmed one. The transcript, the rows, the timeline and this pane draw the same mark.
struct VoiceModelMark: View {
    let score: Double?
    var size: CGFloat = 11

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "waveform").font(.system(size: size - 1, weight: .semibold))
            Text(verbatim: score.map(VoiceScore.text) ?? "voice").font(.system(size: size, weight: .medium).monospacedDigit())
        }
        .foregroundStyle(KitHue.play.ink)
        .instantTooltip(Self.tooltip(score))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.words(score))
    }

    static func tooltip(_ score: Double?) -> String {
        "Named by the voice model" + (score.map { ", \(VoiceScore.text($0)) like the person's samples" } ?? "")
            + ". It stays a suggestion until you confirm it by ear."
    }

    static func words(_ score: Double?) -> String {
        "by voice" + (score.map { " \(VoiceScore.text($0))" } ?? "")
    }
}

/// The Voices pane: an inspector in the meeting's trailing pane slot, opened from the "…" menu ("Voices…").
struct VoicesPane: View {
    let detail: MeetingDetailModel
    let close: () -> Void
    @State private var namedLines: [VoiceNamedLine] = []
    @AppStorage("meetings.voices.meetingOnly") private var preferredMeetingOnly = false
    @State private var showAllPreview = false
    @State private var showAllNamed = false

    private var model: VoicesModel { detail.voices }
    private var project: String? { detail.record.value?.project }
    /// The rows a list shows before "Show all": a person can hold 1,500 samples and a preview 2,000 lines.
    static let shownRows = 40
    /// The preview's rows before "Show all": it sits under the buttons, above the people.
    static let shownPreviewRows = 8

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if project == nil, detail.record.value != nil {
                EmptyState(symbol: "person.wave.2", text: "Choose a project first",
                           detail: "Choose a project for this meeting to learn from confirmed voices.")
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                            actions
                            // The preview answers the button above it, so it shows right under it.
                            previewSection
                            Divider().padding(.vertical, 6)
                            if let project, let window = detail.window {
                                let only = model.meetingOnlyOverride ?? preferredMeetingOnly
                                Picker("Samples from", selection: Binding(get: { only }, set: { model.meetingOnlyOverride = $0 })) {
                                    Text("This project").tag(false)
                                    Text("This meeting").tag(true)
                                }
                                .pickerStyle(.segmented)
                                .accessibilityIdentifier("meetings.voices.scope")
                                VoiceSampleRows(model: window.voiceLibrary,
                                                destination: .inspector(meeting: model.meeting, project: project, meetingOnly: only),
                                                focus: model.focus, reveal: { id in
                                                    model.focus = nil
                                                    Task { @MainActor in proxy.scrollTo(id, anchor: .top) }
                                                }, waiting: model.preview.value)
                            }
                            namedSection
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                    }
                }
            }
        }
        .onChange(of: NamedInput(items: detail.record.value?.items, entries: detail.transcript.value?.entries), initial: true) { _, input in
            namedLines = VoiceNamedLine.of(items: input.items ?? [], entries: input.entries)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Voices")
    }

    private struct NamedInput: Equatable {
        let items: [MeetingItem]?
        let entries: [TranscriptLine]?
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Voices").font(.system(size: 13, weight: .semibold))
            if let project {
                Text(verbatim: project).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 6)

            IconButton(systemName: "xmark", tooltip: "Close the Voices pane", action: close)
                .accessibilityLabel("Close the Voices pane")
                .accessibilityIdentifier("meetings.voices.close")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    // MARK: Preview and Apply

    @ViewBuilder
    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button("Preview") { model.runPreview() }
                    .buttonStyle(.kit(.tinted, hue: .play, size: .small))
                    .disabled(model.running != nil)
                    .instantTooltip("List the lines the voice model would name now, with the score. Saves nothing.")
                    .accessibilityIdentifier("meetings.voices.preview")
                Button("Apply") { model.apply() }
                    .buttonStyle(.kit(.ghost, size: .small))
                    .disabled(model.running != nil || detail.service == nil)
                    .instantTooltip("Name the lines by voice on this meeting. Each name stays a suggestion until you confirm it.")
                    .accessibilityIdentifier("meetings.voices.apply")
                Spacer(minLength: 0)
            }
            if let run = model.running {
                VoicesRunView(run: run, progress: model.progress) { model.cancelRun() }
            } else {
                Text("Preview reads the voices and lists what Apply would name. Nothing changes until Apply.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// "12 lines wait for one sample of Dana" once a preview counted them; before, how to count them.
    static func waitingText(_ person: String, preview: VoicesPreviewSummary?) -> String {
        guard let preview else { return "Preview counts the lines that wait for one." }
        let count = preview.waiting[person] ?? 0
        return count == 0 ? "No line waits for a sample of this person."
            : "\(Plural.count(count, "line")) wait\(count == 1 ? "s" : "") for one. Confirm one line of this person to add a sample."
    }

    // MARK: Lines the voice model named on the record

    @ViewBuilder
    private var namedSection: some View {
        if !namedLines.isEmpty {
            Divider().padding(.vertical, 6)
            sectionTitle("Named by voice (\(namedLines.count))")
            ForEach(namedLines.prefix(showAllNamed ? namedLines.count : Self.shownRows)) { line in namedRow(line) }
            if namedLines.count > Self.shownRows, !showAllNamed {
                Button { showAllNamed = true } label: { Text(verbatim: "Show all \(namedLines.count)") }
                    .buttonStyle(.genHoverPlain()).font(.system(size: 11.5)).foregroundStyle(Color.accentColor)
            }
        }
    }

    private func namedRow(_ line: VoiceNamedLine) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                IconButton(systemName: "play.fill", tooltip: "Play this line") { model.play(from: line.fromSec, to: line.toSec) }
                    .accessibilityLabel("Play the line at \(MeetingsFormat.clock(line.fromSec))")
                Text(verbatim: MeetingsFormat.clock(line.fromSec)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                DecisionStateValue(text: line.speaker, state: line.state, size: 12)
                    .lineLimit(1)
                if line.state == .suggested { VoiceModelMark(score: line.score) }
                Spacer(minLength: 0)
            }
            if let text = line.text {
                Text(verbatim: text).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2).padding(.leading, 26)
            }
            if line.state == .suggested {
                HStack(spacing: 6) {
                    Button("Confirm") { model.decide([line.id], confirm: true) }
                        .buttonStyle(.kit(.tinted, hue: .done, size: .small))
                        .instantTooltip("It is \(line.speaker): keep the name and keep this line as a voice sample")
                    Button("Not this person") { model.decide([line.id], confirm: false) }
                        .buttonStyle(.kit(.ghost, size: .small))
                        .instantTooltip("It is not \(line.speaker): remove the name; the voice model will not give this line that name again")
                }
                .disabled(model.busy.contains("decide.\(line.id)"))
                .padding(.leading, 26)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: Preview list

    @ViewBuilder
    private var previewSection: some View {
        switch model.preview {
        case .idle:
            EmptyView()
        case .loading(previous: nil):
            EmptyView()
        case .failed(let failure, nil):
            Divider().padding(.vertical, 6)
            FailureInline(FailureReport.unexpected(failure.detail ?? failure.sentence, outcome: failure.sentence,
                                                   action: "Preview the voice names", title: "The voice preview failed", area: "meetings"),
                          form: .compact) { model.runPreview() }
        default:
            if let summary = model.preview.value {
                Divider().padding(.vertical, 6)
                sectionTitle("Preview")
                Text(summary.headline).font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.secondary).padding(.bottom, 4)
                ForEach(summary.lines.prefix(showAllPreview ? summary.lines.count : Self.shownPreviewRows)) { line in previewRow(line) }
                if summary.lines.count > Self.shownPreviewRows, !showAllPreview {
                    Button { showAllPreview = true } label: { Text(verbatim: "Show all \(summary.lines.count)") }
                        .buttonStyle(.genHoverPlain()).font(.system(size: 11.5)).foregroundStyle(Color.accentColor)
                }
            }
        }
    }

    private func previewRow(_ line: VoicePreviewLine) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                IconButton(systemName: "play.fill", tooltip: "Play this line") { model.play(from: line.fromSec, to: line.toSec) }
                    .accessibilityLabel("Play the line at \(MeetingsFormat.clock(line.fromSec))")
                Text(verbatim: MeetingsFormat.clock(line.fromSec)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                if let person = line.person {
                    DecisionStateValue(text: person, state: .suggested, size: 12).lineLimit(1)
                    VoiceModelMark(score: line.score)
                } else {
                    Text(line.outcome).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            Text(verbatim: line.text).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(2).padding(.leading, 26)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary).padding(.vertical, 4)
    }
}

/// A running Preview or Apply: the service's newest step as a bar with its words, or a spinner before the first step,
/// as the Items tab shows a running suggest (`SuggestRunView`).
struct VoicesRunView: View {
    let run: VoicesModel.Run
    let progress: MeetingsCallProgress?
    var cancel: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if let fraction = progress?.fraction {
                    ProgressView(value: min(1, max(0, fraction))).progressViewStyle(.linear)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(height: 14)
            HStack(spacing: 8) {
                Text(verbatim: Self.label(run, progress)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(run == .preview ? "Previewing the voice names" : "Naming lines by voice")
                    .accessibilityValue(Self.label(run, progress))
                Spacer(minLength: 4)
                if let cancel {
                    GhostButton("Cancel", symbol: "xmark", tooltip: "Stop the voice pass; nothing is saved", height: 22,
                                identifier: "meetings.voices.cancel", action: cancel)
                }
            }
        }
    }

    static func label(_ run: VoicesModel.Run, _ progress: MeetingsCallProgress?) -> String {
        guard progress != nil else { return run == .preview ? "Reading the voices…" : "Naming lines by voice…" }
        return SuggestRunView.label(progress)
    }
}
