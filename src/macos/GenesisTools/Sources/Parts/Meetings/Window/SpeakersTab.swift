import SwiftUI

// MARK: - Speakers

/// Each label of the transcript with its turns and spoken time; a rename edits in place and commits on Return. Above
/// the rows, the talk time per speaker over the meeting with "?" banners at the open questions (R40, R21); under a
/// row, each range of its hints is a chip that plays it, or a "Show" chip that zooms the dock (R20, G-SPK-1, G-SPK-3).
struct SpeakersTab: View {
    @Bindable var detail: MeetingDetailModel
    /// Below this width a speaker's rename field goes under its numbers: beside them, at the window's smallest size the
    /// field and the Play button left the numbers about 20 pt, one letter per line.
    static let stackWidth: CGFloat = 560
    @State private var reviewing: String?
    @AppStorage(MeetingsPreferences.Speakers.showQuestions.key) private var showQuestions =
        MeetingsPreferences.Speakers.showQuestions.defaultValue
    @AppStorage(MeetingsPreferences.Speakers.hintChips.key) private var hintChips = MeetingsPreferences.Speakers.hintChips.defaultValue

    var body: some View {
        LoadablePane(state: detail.speakers, reading: "Reading the speakers…", retry: detail.loadSpeakers,
                     noSource: detail.noTranscriptSource("speakers")) { stats in
            if stats.speakers.isEmpty {
                EmptyState(symbol: "person.2", text: "No speaker yet", detail: "The speakers come from the transcript.")
            } else {
                let renames = detail.record.value?.speakers.labels ?? [:]
                // The most spoken first: in the CLI's order a label with 7 turns stood above one with 427.
                let speakers = stats.speakers.sorted { $0.spokenSec > $1.spokenSec }
                // The width straight from a GeometryReader, not a state an onGeometryChange sets: the window opened at
                // its smallest size reported no change, so the rows stayed side by side and wrapped one letter per line.
                GeometryReader { proxy in
                    let stacked = proxy.size.width < Self.stackWidth
                    List {
                        lanes(stats, names: renames)
                            .listRowSeparator(.hidden)
                        ForEach(speakers) { speaker in
                            SpeakerRow(speaker: SpeakerStat(speaker), rename: renames[speaker.label], stacked: stacked,
                                       hints: MeetingsWords.speakerHintLines(stats.hints, for: speaker.label),
                                       play: speaker.firstSec.map { first in { detail.play(at: first, from: .speakerChip) } },
                                       chips: { line in
                                           if !line.ranges.isEmpty {
                                               SpeakerHintChips(ranges: line.ranges, longestClipSec: longestClipSec,
                                                                maxShown: hintChips > 0 ? hintChips : MeetingsPreferences.Speakers.hintChips.defaultValue,
                                                                play: { from, to in playRange(from, to) },
                                                                zoom: { from, to in zoom(from, to) },
                                                                review: { reviewing = speaker.label })
                                           }
                                       }, commit: { detail.rename(label: speaker.label, to: $0) })
                        }
                    }
                    .listStyle(.inset)
                }
                .sheet(item: Binding(get: { reviewing.map(ReviewLabel.init) }, set: { reviewing = $0?.label })) { review in
                    HintRangesSheet(label: review.label, names: renames,
                                    ranges: MeetingsWords.speakerHintLines(stats.hints, for: review.label).flatMap(\.ranges),
                                    longestClipSec: longestClipSec,
                                    play: { from, to in playRange(from, to) },
                                    zoom: { from, to in zoom(from, to) },
                                    close: { reviewing = nil })
                }
            }
        }
        .onAppear {
            // The "?" banners are the open questions of the review rows.
            if case .idle = detail.rows { detail.loadRows() }
        }
    }

    // MARK: The talk-time lanes (R40)

    private func lanes(_ stats: MeetingsAPI.MeetingSpeakers.Result, names: [String: String]) -> some View {
        let player = detail.window?.player
        let top = player?.top.flatMap { $0.meeting == detail.id ? $0 : nil }
        return SpeakerTalkTimeLanes(speakers: stats.speakers, durationSec: durationSec(stats), timed: stats.timed,
                                    questions: Self.questions(detail.rows.value?.rows ?? []),
                                    activeRange: top.map { $0.startSec...max($0.startSec, $0.endSec) },
                                    showsQuestions: showQuestions,
                                    names: names,
                                    playSpan: { from, to in playRange(from, to) },
                                    zoom: { from, to in zoom(from, to) },
                                    openQuestion: { ids in if let first = ids.first { detail.reveal(row: first) } },
                                    assign: { stretch, person in detail.startAssign(stretch, to: person, email: nil) })
    }

    /// The meeting's length for the lanes: the recording's, else the overview's, else the last line's time.
    private func durationSec(_ stats: MeetingsAPI.MeetingSpeakers.Result) -> Double {
        let last = stats.speakers.compactMap(\.lastSec).max() ?? 0
        let known = detail.window?.player.timeline.durationSec(detail.id, fallback: detail.window?.meeting(detail.id)?.durationSec) ?? 0
        return max(known, last, 1)
    }

    /// The open questions with a time, as banners ("Q12").
    static func questions(_ rows: [ReviewRow]) -> [TalkTimeQuestion] {
        rows.compactMap { row in
            guard row.isQuestion, row.isOpen, let at = row.startSec else { return nil }
            return TalkTimeQuestion(id: row.id, atSec: at, label: row.label)
        }
    }

    // MARK: Play and zoom

    /// A chip or a lane block plays only that stretch, over what plays (R20).
    private func playRange(_ from: Double, _ to: Double) {
        detail.play(.range(from: from, to: max(from, to)), from: .speakerChip)
    }

    /// A range longer than a clip (or a joined block) shows in the dock instead: the meeting plays from the range's
    /// start, also when it plays already from another time, and the timeline shows the range (G-SPK-3, G-SPK-8).
    private func zoom(_ from: Double, _ to: Double) {
        guard let player = detail.window?.player else { return }
        player.showMeeting(detail.id, from: from)
        player.timeline.showView(from...max(from + 1, to), layer: player.top?.id)
    }

    /// `global.playback.listen.longestClipSec` (30 when the config does not say): a range longer than that is a "Show"
    /// chip, because the engine plays only its first `longestClipSec` seconds.
    private var longestClipSec: Double {
        if case .number(let value) = detail.window?.settingsRaw?.at(["global", "playback", "listen", "longestClipSec"]), value > 0 {
            return value
        }
        return 30
    }
}

private struct ReviewLabel: Identifiable {
    let label: String
    var id: String { label }
}

/// "Review N" (G-SPK-1): every range of a label's hints, each with its chip.
struct HintRangesSheet: View {
    let label: String
    let names: [String: String]
    let ranges: [SpeakerHint.Range]
    let longestClipSec: Double
    let play: (Double, Double) -> Void
    let zoom: (Double, Double) -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: "Every stretch of \(names[label] ?? label) to check").font(.system(size: 15, weight: .semibold))
            ScrollView {
                SpeakerHintChips(ranges: ranges, longestClipSec: longestClipSec, maxShown: ranges.count, play: play, zoom: zoom)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 320)
            HStack {
                Spacer()
                Button("Done", action: close).keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 460)
        .closesOnEscape(close)
    }
}
