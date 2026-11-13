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
    @State private var reviewing: ReviewHint?
    @AppStorage(MeetingsPreferences.Speakers.showQuestions.key) private var showQuestions =
        MeetingsPreferences.Speakers.showQuestions.defaultValue
    @AppStorage(MeetingsPreferences.Speakers.hintChips.key) private var hintChips = MeetingsPreferences.Speakers.hintChips.defaultValue

    @AppStorage(MeetingsPreferences.speakerOrderKey) private var order = MeetingsPreferences.SpeakerOrder.spoken.rawValue

    var body: some View {
        LoadablePane(state: detail.speakers, reading: "Reading the speakers…", retry: detail.loadSpeakers,
                     noSource: detail.noTranscriptSource("speakers")) { stats in
            if stats.speakers.isEmpty {
                EmptyState(symbol: "person.2", text: "No speaker yet", detail: "The speakers come from the transcript.")
            } else {
                let renames = detail.record.value?.speakers.labels ?? [:]
                let chosenOrder = MeetingsPreferences.SpeakerOrder(rawValue: order) ?? .spoken
                let speakers = chosenOrder.ordered(stats.speakers.map(SpeakerStat.init))
                // The width straight from a GeometryReader, not a state an onGeometryChange sets: the window opened at
                // its smallest size reported no change, so the rows stayed side by side and wrapped one letter per line.
                GeometryReader { proxy in
                    let stacked = proxy.size.width < Self.stackWidth
                    List {
                        if let evidence = stats.evidence {
                            DisclosureGroup("Evidence facts") {
                                ForEach(Array(evidence.summary.enumerated()), id: \.offset) { _, text in Text(text).textSelection(.enabled) }
                                Text(evidence.lines).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                            }
                            .accessibilityIdentifier("meetings.speakers.evidence")
                        }
                        lanes(stats, names: renames)
                            .listRowSeparator(.hidden)
                        ForEach(speakers) { speaker in
                            // A value row: a rename, a play or a hint chip re-runs only the rows whose values changed,
                            // and its controls rest until the pointer is on it.
                            SpeakerListRow(speaker: speaker, rename: renames[speaker.label], stacked: stacked,
                                           hints: MeetingsWords.speakerHintLines(stats.hints, for: speaker.label),
                                           longestClipSec: longestClipSec,
                                           maxShown: hintChips > 0 ? hintChips : MeetingsPreferences.Speakers.hintChips.defaultValue,
                                           actions: SpeakerListRow.Actions(
                                               playFirst: { detail.play(at: $0, from: .speakerChip) },
                                               playRange: { from, to in playRange(from, to) },
                                               zoom: { from, to in zoom(from, to) },
                                               review: { line in reviewing = ReviewHint(label: speaker.label, ranges: line.ranges) },
                                               rename: { detail.rename(label: speaker.label, to: $0) }))
                                .equatable()
                                .liveRow()
                        }
                    }
                    .listStyle(.inset)
                }
                .sheet(item: $reviewing) { review in
                    HintRangesSheet(label: review.label, names: renames,
                                    ranges: review.ranges,
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

/// One speaker of the list as values: a dense row takes values and compares them, so an update of the tab re-runs only
/// the rows whose values changed. The closures only run the row's actions, so `==` leaves them out.
struct SpeakerListRow: View, Equatable {
    struct Actions {
        /// Plays the label from its first line (the second it starts at).
        var playFirst: (Double) -> Void
        var playRange: (Double, Double) -> Void
        var zoom: (Double, Double) -> Void
        /// "Review all N" under one hint line: that line's ranges.
        var review: (SpeakerHintLine) -> Void
        var rename: (String) -> Void
    }

    let speaker: SpeakerStat
    let rename: String?
    let stacked: Bool
    let hints: [SpeakerHintLine]
    let longestClipSec: Double
    let maxShown: Int
    // lint-rules-ignore: closures only (the row's actions), which run on a click and show nothing, so == leaves them out
    let actions: Actions

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.speaker == rhs.speaker && lhs.rename == rhs.rename && lhs.stacked == rhs.stacked && lhs.hints == rhs.hints
            && lhs.longestClipSec == rhs.longestClipSec && lhs.maxShown == rhs.maxShown
    }

    var body: some View {
        SpeakerRow(speaker: speaker, rename: rename, stacked: stacked, hints: hints,
                   play: speaker.firstSec.map { first in { actions.playFirst(first) } },
                   chips: { line in
                       if !line.ranges.isEmpty {
                           SpeakerHintChips(ranges: line.ranges, longestClipSec: longestClipSec, maxShown: maxShown,
                                            play: actions.playRange, zoom: actions.zoom,
                                            review: { actions.review(line) })
                       }
                   }, commit: actions.rename)
    }
}

private struct ReviewHint: Identifiable {
    let id = UUID()
    let label: String
    let ranges: [SpeakerHint.Range]
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
