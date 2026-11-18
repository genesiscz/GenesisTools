import AppKit
import SwiftUI

/// The transcript beside the review rows, in the meeting's trailing pane slot (`MeetingDetailView.trailingPane`): a
/// header with "Follows playback" and "Jump to now", then the Riverside blocks that follow the player (R39, R42), the
/// selection popover with Comment and Clip 5s, and the comments staged for the listening agent (R43).
struct TranscriptPane: View {
    @Bindable var detail: MeetingDetailModel
    @State private var visibilityToken = UUID()

    var body: some View {
        LoadablePane(state: detail.transcript, reading: "Reading the transcript…", retry: detail.loadTranscript,
                     noSource: detail.noTranscriptSource("transcript")) { transcript in
            if transcript.entries.isEmpty {
                EmptyState(symbol: "text.alignleft", text: "This meeting has no transcript",
                           detail: "A transcript comes from its source (Wispr Flow) once the meeting is linked.")
            } else {
                TranscriptBlocksPane(detail: detail, entries: transcript.entries, showsHeader: true)
            }
        }
        .onAppear {
            detail.setTranscriptPane(visibilityToken, visible: true)
            detail.ensureTranscript()
        }
        .onDisappear { detail.setTranscriptPane(visibilityToken, visible: false) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Transcript")
    }
}

/// The transcript as Riverside blocks (R39), for the pane and the Transcript tab: the heard line follows the player
/// (R42), a click on a line plays from it, ⇧-click and ⌘-click select lines for a comment or a clip (R43), and the staged
/// comments sit under the blocks with one Send.
///
/// The header is one row and one count line (window audit M1): the title or the filter, Follows playback and a "…"
/// menu (Word timings…, Check by ear…); under it "Names at 50 % ▾" with the line counts, where the menu shows what each
/// value would show. "Who was there" folds above the blocks. Everything the header and the blocks draw is computed in
/// `TranscriptPaneProjection` when an input changes, never in a body (M11).
struct TranscriptBlocksPane: View {
    @Bindable var detail: MeetingDetailModel
    let entries: [TranscriptLine]
    var filter = ""
    /// The pane's own title ("Transcript"); the tab has its filter field there instead.
    var showsHeader = false
    /// The tab's filter field, which takes the header's free room.
    var headerField: AnyView?

    @AppStorage(MeetingsPreferences.Panes.followPlayback.key) private var followSetting =
        MeetingsPreferences.Panes.followPlayback.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.dimPast.key) private var dimPast = MeetingsPreferences.Transcript.dimPast.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.flashRaised.key) private var flashRaised = MeetingsPreferences.Transcript.flashRaised.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.raisedFlashSec.key) private var raisedFlashSec = MeetingsPreferences.Transcript.raisedFlashSec.defaultValue
    @State private var raisedFlash = RaisedLineFlash()
    @State private var raisedLineIDs: Set<String> = []
    @State private var flashTask: Task<Void, Never>?
    @AppStorage(MeetingsPreferences.Transcript.avatars.key) private var avatars = MeetingsPreferences.Transcript.avatars.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.blockBreakSec.key) private var blockBreakSec =
        MeetingsPreferences.Transcript.blockBreakSec.defaultValue
    @AppStorage(MeetingsPreferences.Transcript.clipSec.key) private var clipSec = MeetingsPreferences.Transcript.clipSec.defaultValue
    /// Follows the playback now: the setting's value until the reader scrolls away, then off until "Jump to now".
    @State private var following: Bool?
    @State private var selection: Set<String> = []
    @State private var wordSelection: TranscriptSelection?
    @State private var anchor: TranscriptBlockLine?
    @State private var popoverLine: String?
    @State private var jump = 0
    @State private var sentExpanded = false
    @State private var paneSheet: PaneSheet?
    /// The range "Word timings…" times, and where it comes from; set when the popover opens.
    @State private var timing: WordTimingOptions.Range?
    @AppStorage(MeetingsPreferences.Transcript.timingModel.key) private var timingModel =
        MeetingsPreferences.Transcript.timingModel.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Transcript.timingLanguage.key) private var timingLanguage =
        MeetingsPreferences.Transcript.timingLanguage.defaultValue.rawValue
    /// The one transcript threshold (the Transcript tab picks the service's preview by it too).
    @State private var threshold = MeetingsApplyThreshold.shared
    private var applyAbove: Double { threshold.percent ?? 70 }
    @AppStorage(MeetingsPreferences.Transcript.echoAbove.key) private var echoAbove = MeetingsPreferences.Transcript.defaultEchoAbove
    /// The Items tab's question group: a check prepared here opens that tab on the group it prepared.
    @AppStorage("meetings.rows.questionGroup") private var questionGroup = "all"
    /// "Who was there" open or folded, remembered across meetings; folded at first, so the lines get the room.
    @AppStorage("meetings.transcript.presenceOpen") private var presenceOpen = false
    @State private var projection: TranscriptPaneProjection?

    /// The popovers of the header's "…" menu, anchored on it.
    enum PaneSheet: String, Identifiable {
        case timings, check
        var id: String { rawValue }
    }

    /// The lines as the pane shows them at the threshold (I14). A suggested name at or above it is the name; under it,
    /// or while an open question asks who said the line (I9), it is a guess (`guess`, drawn by `TranscriptLine.who`).
    /// Everything else the engine sent stays: the speaking indicator (I1), the open questions, the times and the words.
    /// The line keeps the speaker the engine sent, which a rename or an assignment acts on.
    static func shownLines(_ entries: [TranscriptLine], applyAbove: Double) -> [TranscriptLine] {
        entries.map { entry in
            guard let confidence = entry.confidence, entry.band != "confirmed", let name = entry.suggestedSpeaker else { return entry }
            let guess = entry.questioned == true || confidence * 100 < Double(applyAbove)
            var shown = entry
            shown.confidence = confidence
            shown.suggestedSpeaker = name
            shown.guess = guess
            shown.band = guess ? "guess" : "applied"
            return shown
        }
    }

    /// The lines with a suggestion, by how the pane shows them (I14): named, guessed with a percent, or still open
    /// ("Who is this?"). Lines no suggestion covers are not counted.
    struct BandCount: Equatable {
        var applied = 0, guesses = 0, open = 0

        init(applied: Int = 0, guesses: Int = 0, open: Int = 0) {
            self.applied = applied; self.guesses = guesses; self.open = open
        }

        init(_ shown: [TranscriptLine]) {
            for line in shown where line.band != nil {
                let who = line.who
                if who.isGuess { guesses += 1 } else if who.isOpen { open += 1 } else { applied += 1 }
            }
        }

        /// One word per state, the same as the chips draw them, and the noun the counts share: lines.
        var words: String { "\(applied) named · \(guesses) guessed · \(open) open lines" }
    }

    /// The one speaker range whose rule set this line's name (T3), picked as the engine picks it
    /// (`correctTranscript`): the ranges over the line's start that are not rejected, a confirmed one first, else the
    /// last. The line's own suggestion (its name and confidence) rules out a range of another voice there.
    static func namingRange(of line: TranscriptLine, in items: [MeetingItem]) -> MeetingItem? {
        guard line.band != nil, let at = line.startSec else { return nil }
        let ranges = items.filter { item in
            item.kind == "speaker-range" && item.status != "rejected"
                && (item.fromSec ?? .infinity) <= at && at <= (item.toSec ?? -.infinity)
                && (line.suggestedSpeaker == nil || item.speaker == line.suggestedSpeaker)
                && (line.confidence == nil || item.confidence == line.confidence)
        }
        return ranges.last { $0.status == "confirmed" } ?? ranges.last
    }

    /// What the line popover says about the selected lines: the range that named each one with its rules, and what the
    /// speaking indicator showed on it. One sentence per range, however many of its lines are selected.
    static func lineEvidence(_ lines: [TranscriptLine], items: [MeetingItem], ruleNames: [String: String]) -> [String] {
        var seen = Set<String>()
        var texts: [String] = []
        for line in lines {
            if let range = namingRange(of: line, in: items) {
                let span = "\(MeetingsFormat.clock(range.fromSec ?? 0)) to \(MeetingsFormat.clock(range.toSec ?? 0))"
                let evidence = range.speakerEvidenceText(ruleNames: ruleNames).map { " " + $0 } ?? ""
                texts.append("Named by the speaker range \(span).\(evidence)")
            }
            if let indicator = line.indicator { texts.append("Speaking indicator: \(indicator.shownText)") }
        }
        return texts.filter { seen.insert($0).inserted }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            presence
            Divider()
            if let projection {
                if projection.blocks.isEmpty {
                    EmptyState(symbol: "magnifyingglass", text: "No line holds “\(filter)”")
                } else {
                    FollowingBlocks(blocks: projection.blocks, names: projection.names, player: detail.window?.player, meeting: detail.id,
                                    follows: isFollowing, jump: jump, selection: selection.union(raisedLineIDs), popoverLine: popoverLine,
                                    dimsPast: dimPast, showsAvatar: avatars,
                                    play: { detail.play(at: $0, from: .transcript) },
                                    select: select, selectWords: selectWords,
                                    scrolledAway: { if isFollowing { following = false } },
                                    popover: { popover() },
                                    closePopover: { popoverLine = nil })
                }
            } else {
                Spacer(minLength: 0)
            }
            staged
        }
        .onChange(of: projectionInput, initial: true) { _, input in
            let span = HubPerf.begin("meetings.transcript.projection", "\(input.entries.count) lines")
            projection = TranscriptPaneProjection.make(input)
            span.end()
        }
        .onAppear {
            detail.restoreRowsForReopen()
            detail.ensureComments()
            if detail.rows.value == nil { detail.loadRows() }
            // The line popover words a range's rules with the engine's sentences.
            detail.window?.ensureRuleNames()
        }
        .onChange(of: detail.rows.value, initial: true) { _, rows in
            let indexes = raisedFlash.receive(rows, enabled: flashRaised)
            guard !indexes.isEmpty else { return }
            flashTask?.cancel()
            raisedLineIDs = Set(entries.enumerated().compactMap { indexes.contains($0.element.sourceIndex ?? $0.offset) ? $0.element.rowID : nil })
            flashTask = Task {
                try? await Task.sleep(for: .seconds(raisedFlashSec))
                if !Task.isCancelled { raisedLineIDs = [] }
            }
        }
        .onChange(of: flashRaised) { _, enabled in if !enabled { flashTask?.cancel(); raisedLineIDs = [] } }
        .onDisappear { flashTask?.cancel(); raisedLineIDs = [] }
        .task { await threshold.load() }
    }

    // MARK: Blocks

    /// What the projection is made from; a change of any part makes it again. The arrays compare by their storage first.
    private var projectionInput: TranscriptPaneProjection.Input {
        .init(entries: entries, applyAbove: applyAbove, hints: detail.speakers.value?.hints ?? [],
              items: detail.record.value?.items ?? [], comments: detail.comments.value?.comments ?? [],
              evidence: detail.rows.value?.lineEvidence ?? [], echoAbove: echoAbove, blockBreakSec: blockBreakSec,
              durationSec: durationSec, filter: filter, people: detail.record.value?.participants?.count ?? 0)
    }

    private var durationSec: Double? {
        detail.window.map { $0.player.timeline.durationSec(detail.id, fallback: $0.meeting(detail.id)?.durationSec) }
            .flatMap { $0 > 0 ? $0 : nil }
    }

    private var isFollowing: Bool { following ?? followSetting }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if showsHeader {
                    Text("Transcript").font(.system(size: 13, weight: .semibold))
                        .accessibilityAddTraits(.isHeader)
                }
                if let headerField {
                    headerField.frame(minWidth: 140, idealWidth: 220, maxWidth: 320)
                }
                Spacer(minLength: 4)
                if detail.busy.contains("word-timings") {
                    ProgressView().controlSize(.small).accessibilityLabel("Generating word timings")
                    GhostButton("Cancel timings", symbol: "xmark", tooltip: "Stop generating the word timings",
                                identifier: "meetings.transcript.timings.cancel", action: detail.cancelWordTimings)
                }
                KitToggleChip("Follows playback", isOn: Binding(get: { isFollowing }, set: { following = $0; if $0 { jump += 1 } }),
                              hue: .play, size: .small,
                              tooltip: "The heard line stays in view while a Moment plays; scrolling away stops it",
                              identifier: "meetings.transcript.follows")
                if !isFollowing, detail.window?.player.top?.meeting == detail.id {
                    IconButton(systemName: "scope", tooltip: "Jump to now: scroll to the heard line and follow the playback again") {
                        following = true
                        jump += 1
                    }
                    .accessibilityLabel("Jump to now")
                    .accessibilityIdentifier("meetings.transcript.jump")
                }
                moreMenu
            }
            countLine
        }
        .padding(.horizontal, 14).padding(.vertical, 7)
    }

    /// "Names at 50 % ▾ · 302 named · 18 guessed · 487 open lines", then the spot check's result when it has one.
    private var countLine: some View {
        WrapLayout(spacing: 6, lineSpacing: 2) {
            thresholdMenu
            if let words = projection?.bands.words {
                Text(verbatim: words)
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                    .instantTooltip("Lines with a suggested speaker at \(Self.percentText(applyAbove)): shown as the name, as a guess with its percent, or as Who is this?")
                    .accessibilityLabel("Lines at \(Self.percentText(applyAbove)): \(words)")
            }
            if let rate = projection?.spotCheck {
                Text(verbatim: "Spot check: \(rate.sentence)")
                    .font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                    .accessibilityIdentifier("meetings.transcript.spotCheckRate")
            }
            if let error = threshold.failure {
                FailureInline(FailureReport.toolsCall(error, outcome: "The threshold was not read or saved", action: "Read or save the transcript threshold"), form: .compact) {
                    Task { await threshold.load() }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The threshold as a menu: each value with what it would show, computed at the click (it merges the picker and
    /// the Probe popover that stood beside it).
    private var thresholdMenu: some View {
        let saved = threshold.percent
        return MenuButton(style: .genHoverPlain(), items: { thresholdItems(saved) }) {
            HStack(spacing: 3) {
                Text("Names at").foregroundStyle(.secondary)
                Text(verbatim: saved.map(Self.percentText) ?? (threshold.failure == nil ? "…" : "not read")).fontWeight(.semibold)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 7, weight: .semibold)).foregroundStyle(.secondary)
            }
            .font(.system(size: 11)).monospacedDigit()
            .frame(minHeight: 22).contentShape(Rectangle())
        }
        .disabled(saved == nil || threshold.busy)
        .instantTooltip("From this confidence a suggested speaker shows as the name; below it, as a guess. The menu says what each value would show")
        .accessibilityLabel("Names at \(saved.map(Self.percentText) ?? "not read")")
        .accessibilityIdentifier("meetings.transcript.threshold")
    }

    private func thresholdItems(_ saved: Double?) -> [MenuButtonItem] {
        var values: [Double] = [0, 50, 60, 70, 80, 90, 100]
        if let saved, !values.contains(saved) { values.append(saved); values.sort() }
        var items: [MenuButtonItem] = [.note("Show a suggested speaker as the name from")]
        for value in values {
            let bands = BandCount(Self.shownLines(entries, applyAbove: value))
            let questions = ListenTranscriptQuality.probe(entries, percent: Int(value)).questions
            items.append(.action("\(Self.percentText(value)): \(bands.words), \(Plural.count(questions, "long-stretch question"))",
                                 checked: value == saved) {
                Task { await threshold.set(value) }
            })
        }
        return items
    }

    static func percentText(_ value: Double) -> String {
        "\(value.formatted(.number.precision(.fractionLength(0...2)))) %"
    }

    /// "…": Word timings… and Check by ear…, each a popover on this button.
    private var moreMenu: some View {
        MenuButton(style: .genHoverPlain(), items: {
            [.action("Word timings…", enabled: !detail.busy.contains("word-timings")) { openTimings() },
             .action("Check by ear…") { paneSheet = .check }]
        }) {
            Image(systemName: "ellipsis.circle").font(.system(size: 14)).foregroundStyle(.secondary)
                .frame(width: 24, height: 22).contentShape(Rectangle())
        }
        .instantTooltip("More: word timings for a short range, or check the speakers by ear")
        .accessibilityLabel("More transcript actions")
        .accessibilityIdentifier("meetings.transcript.more")
        .popover(item: $paneSheet, arrowEdge: .bottom) { sheet in
            switch sheet {
            case .timings: timingOptions
            case .check:
                ListenCheckPopover(detail: detail, rate: projection?.spotCheck) { group in
                    paneSheet = nil
                    questionGroup = group
                    detail.show(.items)
                }
            }
        }
    }

    /// The range comes from the selected lines; with none, from the first short line at or after the heard spot.
    private func openTimings() {
        let selected = selectedLines.map { (start: $0.startSec, end: $0.endSec) }
        timing = WordTimingOptions.Range.of(selected: selected)
            ?? WordTimingOptions.Range.near(entries.lazy.map { (start: $0.startSec, end: $0.endSec) },
                                            position: detail.window?.player.position ?? 0)
        paneSheet = .timings
    }

    @ViewBuilder
    private var timingOptions: some View {
        if let timing {
            let choice = MeetingsPreferences.Transcript.TimingLanguage(rawValue: timingLanguage)
                ?? MeetingsPreferences.Transcript.timingLanguage.defaultValue
            let meetingLanguage = detail.window?.settings.value?.global.language
            let code = MeetingsPreferences.Transcript.timingLanguageCode(choice, meeting: meetingLanguage)
            WordTimingOptions(range: timing,
                              model: SidePanelWords.choice(timingModel, key: MeetingsPreferences.Transcript.timingModel.key),
                              language: WordTimingOptions.languageWords(choice, code: code),
                              openSettings: {
                                  paneSheet = nil
                                  detail.window?.sidePanelOpen = true
                              },
                              cancel: { paneSheet = nil }) {
                detail.generateWordTimings(from: timing.from, to: timing.to, model: timingModel, language: code)
                paneSheet = nil
            }
        }
    }

    /// "Who was there (N)": the presence strip, folded until opened; the choice is remembered.
    @ViewBuilder
    private var presence: some View {
        let people = projection?.people ?? 0
        if people > 0 {
            GenDisclosure(isExpanded: $presenceOpen, minHeight: 22, identifier: "meetings.transcript.presence") {
                ListenPresenceStrip(detail: detail, duration: durationSec ?? entries.last?.endSec ?? 1)
                    .padding(.bottom, 4)
            } label: {
                Text(verbatim: "Who was there (\(people))").font(.system(size: 12))
            }
            .padding(.horizontal, 14).padding(.bottom, 4)
        }
    }

    // MARK: Selection (R43)

    /// ⇧ extends from the last clicked line through the lines between; ⌘ adds or removes one. The popover opens at the
    /// line clicked last.
    private func select(_ line: TranscriptBlockLine, _ click: TranscriptLineClick) {
        wordSelection = nil
        switch click {
        case .play:
            return
        case .toggleSelection:
            if selection.contains(line.id) { selection.remove(line.id) } else { selection.insert(line.id) }
        case .extendSelection:
            if let anchor {
                let range = min(anchor.index, line.index)...max(anchor.index, line.index)
                for block in projection?.built ?? [] { for other in block.lines where range.contains(other.index) { selection.insert(other.id) } }
            } else {
                selection.insert(line.id)
            }
        }
        anchor = line
        popoverLine = selection.isEmpty ? nil : line.id
    }

    private func selectWords(_ line: TranscriptBlockLine, _ range: NSRange) {
        guard let chosen = TranscriptSelection.words(line, range: range) else { return }
        wordSelection = chosen
        selection = [line.id]
        anchor = line
        popoverLine = line.id
    }

    private var selectedLines: [TranscriptBlockLine] {
        (projection?.built ?? []).flatMap(\.lines).filter { selection.contains($0.id) }
    }

    /// Built only while the selection popover is open.
    private func popover() -> AnyView {
        guard let chosen = wordSelection ?? TranscriptSelection.lines(selectedLines) else { return AnyView(EmptyView()) }
        let shown = projection?.shown ?? []
        return AnyView(VStack(alignment: .leading, spacing: 8) {
            ForEach(selectedLines) { line in
                let sourceIndex = entries.indices.contains(line.index) ? (entries[line.index].sourceIndex ?? line.index) : line.index
                if let match = detail.record.value?.evidence?.voice?.lines[String(sourceIndex)] {
                    ListenVoiceScores(match: match)
                }
                if let acoustic = detail.rows.value?.lineEvidence?.first(where: { $0.index == sourceIndex }) {
                    ForEach(acoustic.acousticText, id: \.self) { Text($0).font(.system(size: 11)).foregroundStyle(.secondary) }
                    if let echo = acoustic.echoText {
                        Label(echo, systemImage: "speaker.wave.2").font(.system(size: 11)).foregroundStyle(.pink)
                    }
                }
            }
            SelectionPopover(
            selection: chosen,
            clipLengthSec: clipSec > 0 ? clipSec : MeetingsPreferences.Transcript.clipSec.defaultValue,
            stage: { selection, text in
                detail.stageComment(selection, text: text)
                clearSelection()
            },
            clip: { target, length in
                detail.window?.player.play(target, in: detail.id, from: .selection, lengthSec: length)
            },
            playAll: { target in
                detail.window?.player.play(target, in: detail.id, from: .selection)
            },
            saveClip: { selection, length in
                detail.saveSelectionClip(selection, length: length) { clearSelection() }
            },
            savingClip: detail.isBusy("clip.save"),
            speakerEvidence: Self.lineEvidence(selectedLines.compactMap { shown.indices.contains($0.index) ? shown[$0.index] : nil },
                                               items: detail.record.value?.items ?? [], ruleNames: detail.window?.ruleNames ?? [:]),
            close: { clearSelection() })
        })
    }

    private func clearSelection() {
        wordSelection = nil
        selection = []
        anchor = nil
        popoverLine = nil
    }

    // MARK: Staged comments (G60)

    @ViewBuilder
    private var staged: some View {
        let all = detail.comments.value?.comments ?? []
        let comments = all.filter { $0.state == "staged" }
        let sent = all.filter { $0.state == "sent" }
        if !comments.isEmpty || !sent.isEmpty || detail.commentDelivery != .idle {
            Divider()
            if !comments.isEmpty || detail.commentDelivery != .idle {
                StagedCommentsBar(comments: comments.map(StagedCommentLine.init), listeners: detail.comments.value?.listeners ?? [],
                                  delivery: detail.commentDelivery, send: { detail.sendComments() },
                                  unstage: { detail.unstageComment($0) })
            }
            if !sent.isEmpty {
                GenDisclosure(isExpanded: $sentExpanded, minHeight: 22, identifier: "meetings.transcript.sentComments") {
                    ForEach(sent.reversed()) { comment in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(StagedCommentLine(comment).rangeText).monospacedDigit()
                            Text(comment.text).frame(maxWidth: .infinity, alignment: .leading)
                            Text(comment.withdrawnAt != nil ? "Withdrawn" : comment.readAt != nil ? "Read" : "Unread")
                                .foregroundStyle(.secondary)
                                .help(comment.readAt.map { "Acknowledged at \($0)" } ?? "Waiting for a receiver to acknowledge this comment")
                            if comment.canWithdraw {
                                Button("Withdraw") { detail.withdrawComment(comment.id) }
                                    .buttonStyle(.link)
                                    .accessibilityIdentifier("meetings.comment.withdraw.\(comment.id)")
                            }
                        }
                        .font(.system(size: 11))
                        .padding(.vertical, 3)
                    }
                } label: {
                    Text(verbatim: "Sent comments (\(sent.count))").font(.system(size: 12))
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .onChange(of: detail.commentDelivery) { _, delivery in
                    if case .sent = delivery { sentExpanded = true }
                }
            }
        }
    }
}

/// What the transcript pane draws, made when one of its inputs changes (window audit M11). Before, the pane's body ran
/// the line marks (every line against every hint, term and comment range), built every block, counted the bands, summed
/// the words and filtered the items for the spot check on each redraw: a keystroke in the Word timings form, a line
/// selection, a popover toggle.
struct TranscriptPaneProjection: Equatable {
    struct Input: Equatable {
        var entries: [TranscriptLine] = []
        var applyAbove: Double = 70
        var hints: [SpeakerHint] = []
        var items: [MeetingItem] = []
        var comments: [MeetingComment] = []
        var evidence: [WindowLineEvidence] = []
        var echoAbove = MeetingsPreferences.Transcript.defaultEchoAbove
        var blockBreakSec = 0.0
        var durationSec: Double?
        var filter = ""
        /// The meeting's participants, the rows of "Who was there".
        var people = 0
    }

    /// The lines at the threshold (`TranscriptBlocksPane.shownLines`).
    var shown: [TranscriptLine] = []
    /// Every block, and the blocks the filter keeps.
    var built: [TranscriptBlock] = []
    var blocks: [TranscriptBlock] = []
    /// The shown names, sorted, for the person colours.
    var names: [String] = []
    var bands = TranscriptBlocksPane.BandCount()
    var spotCheck: SpotCheckRate?
    /// The people of "Who was there".
    var people = 0

    @MainActor
    static func make(_ input: Input) -> Self {
        var result = Self()
        result.shown = TranscriptBlocksPane.shownLines(input.entries, applyAbove: input.applyAbove)
        let marks = MeetingDetailModel.lineMarks(entries: input.entries, hints: input.hints, items: input.items, comments: input.comments)
        result.built = TranscriptBlock.build(from: result.shown, durationSec: input.durationSec, marks: marks, evidence: input.evidence,
                                             items: input.items, echoAbove: input.echoAbove,
                                             breakAfterGapSec: MeetingsPreferences.Transcript.breakAfterGapSec(input.blockBreakSec))
        result.blocks = TranscriptBlock.filter(result.built, query: input.filter)
        result.names = TranscriptBlock.names(result.built)
        result.bands = TranscriptBlocksPane.BandCount(result.shown)
        result.spotCheck = SpotCheckRate.of(input.items)
        result.people = input.people
        return result
    }
}

/// Existing evidence primes the ledger; only a fresh answer token raises a new flash. Reopening never replays it.
struct RaisedLineFlash {
    private var tokens: [String: String]?
    mutating func receive(_ rows: ReviewRows?, enabled: Bool) -> Set<Int> {
        guard let rows else { return [] }
        let previous = tokens
        tokens = rows.questionDetailsTokens
        guard enabled, let previous else { return [] }
        var indexes: Set<Int> = []
        for evidence in rows.questionDetails ?? [] {
            guard let token = rows.questionDetailsTokens[evidence.id], previous[evidence.id] != token else { continue }
            indexes.formUnion((evidence.raisedLines ?? []).map(\.index))
        }
        return indexes
    }
}

/// The only reader of the player's position in the transcript. Each tick derives two values that change every few
/// seconds (the heard line, and the end of the last block passed) and hands the list those, never the position: the
/// list is `Equatable` on what it shows, so a tick that changes neither renders nothing below this view. Handing it
/// the position re-ran the lazy stack ten times a second, and each re-run laid out the whole meeting column: a main
/// thread at 97 % of a core for the length of every clip (2026-11-11).
private struct FollowingBlocks: View {
    @AppStorage(MeetingsPreferences.Transcript.wordHighlights.key) private var wordHighlights = MeetingsPreferences.Transcript.wordHighlights.defaultValue
    let blocks: [TranscriptBlock]
    /// The shown names, sorted (`TranscriptPaneProjection.names`).
    let names: [String]
    let player: MomentPlayer?
    let meeting: String
    let follows: Bool
    let jump: Int
    let selection: Set<String>
    let popoverLine: String?
    let dimsPast: Bool
    let showsAvatar: Bool
    let play: (Double) -> Void
    let select: (TranscriptBlockLine, TranscriptLineClick) -> Void
    let selectWords: (TranscriptBlockLine, NSRange) -> Void
    let scrolledAway: () -> Void
    let popover: () -> AnyView
    let closePopover: () -> Void

    var body: some View {
        let position = player?.top?.meeting == meeting ? player?.position : nil
        FollowingList(blocks: blocks, names: names, heard: TranscriptBlock.heard(in: blocks, at: position, wordHighlights: wordHighlights),
                      passedEnd: dimsPast ? TranscriptBlock.passedEnd(in: blocks, at: position) : nil,
                      follows: follows, jump: jump, selection: selection, popoverLine: popoverLine, dimsPast: dimsPast,
                      showsAvatar: showsAvatar, play: play, select: select, selectWords: selectWords, scrolledAway: scrolledAway, popover: popover,
                      closePopover: closePopover)
            .equatable()
    }
}

/// Where the transcript's follow scrolls when the heard line moves.
enum TranscriptFollowTarget: Equatable {
    /// A new block: centre it (the lazy stack places it by its id), then keep its heard line in view.
    case block(String)
    /// A next line of the same block: the least scroll that keeps it in view. A speaker's block taller than the pane
    /// did not follow at all: its id did not change while the heard line left the view.
    case line(String)

    /// Nil when only the heard word moved.
    static func of(from old: TranscriptHeard?, to now: TranscriptHeard) -> Self? {
        guard old?.blockID == now.blockID else { return .block(now.blockID) }
        return old?.lineID == now.lineID ? nil : .line(now.lineID)
    }
}

/// The blocks, given the heard line and the end of the last block passed: only the heard block redraws when the
/// heard line moves (G-TR-2); a new heard block scrolls into view while the pane follows, instantly under Reduce
/// Motion. `==` compares what it shows and leaves the callbacks out.
private struct FollowingList: View, Equatable {
    let blocks: [TranscriptBlock]
    let names: [String]
    let heard: TranscriptHeard?
    /// `TranscriptBlock.passedEnd(in:at:)`, nil when past blocks are not dimmed.
    let passedEnd: Double?
    let follows: Bool
    /// Bumped by "Jump to now": scroll to the heard block once more.
    let jump: Int
    let selection: Set<String>
    let popoverLine: String?
    let dimsPast: Bool
    let showsAvatar: Bool
    let play: (Double) -> Void
    let select: (TranscriptBlockLine, TranscriptLineClick) -> Void
    let selectWords: (TranscriptBlockLine, NSRange) -> Void
    let scrolledAway: () -> Void
    let popover: () -> AnyView
    let closePopover: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func == (lhs: FollowingList, rhs: FollowingList) -> Bool {
        lhs.heard == rhs.heard && lhs.passedEnd == rhs.passedEnd && lhs.follows == rhs.follows && lhs.jump == rhs.jump
            && lhs.selection == rhs.selection && lhs.popoverLine == rhs.popoverLine && lhs.dimsPast == rhs.dimsPast
            && lhs.showsAvatar == rhs.showsAvatar && lhs.names == rhs.names && lhs.blocks == rhs.blocks
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                TranscriptBlocksList(blocks: blocks, heard: heard, selection: selection, dimsPast: dimsPast,
                                     showsAvatar: showsAvatar, pastBefore: passedEnd,
                                     popoverLine: popoverLine, popover: popover, closePopover: closePopover,
                                     play: play, select: select, selectWords: selectWords, speakerNames: names)
                    .padding(.vertical, 4)
                    .background(UserScrollProbe(onUserScroll: scrolledAway))
            }
            .onChange(of: heard) { old, now in
                guard follows, let now, let target = TranscriptFollowTarget.of(from: old, to: now) else { return }
                switch target {
                case .block(let block): scroll(proxy, to: block, anchor: .center, thenLine: now.lineID)
                case .line(let line): scroll(proxy, to: line, anchor: nil)
                }
            }
            // A pane that opens while a Moment plays starts at the heard line: it scrolled only when the heard block
            // changed, so beside a clip that stays in one block it showed the meeting's first lines to the end.
            .onAppear {
                guard follows, let heard else { return }
                DispatchQueue.main.async {
                    proxy.scrollTo(heard.blockID, anchor: .center)
                    DispatchQueue.main.async { proxy.scrollTo(heard.lineID, anchor: .center) }
                }
            }
            // "Jump to now" centres the heard line: a long block centred on its middle could leave that line outside.
            .onChange(of: jump) { _, _ in
                if let heard { scroll(proxy, to: heard.blockID, anchor: .center, thenLine: heard.lineID, lineAnchor: .center) }
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, to id: String, anchor: UnitPoint?, thenLine line: String? = nil,
                        lineAnchor: UnitPoint? = nil) {
        if reduceMotion {
            proxy.scrollTo(id, anchor: anchor)
        } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: anchor) }
        }
        // The line's id is known once its block is laid out: one turn later.
        if let line { DispatchQueue.main.async { proxy.scrollTo(line, anchor: lineAnchor) } }
    }
}

/// Tells when the reader scrolls the enclosing scroll view by hand (a wheel or trackpad drag), never for a scroll the
/// code makes, so following the playback stops only when they scroll away.
private struct UserScrollProbe: NSViewRepresentable {
    let onUserScroll: () -> Void

    func makeNSView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.onUserScroll = onUserScroll
        return view
    }

    func updateNSView(_ view: ProbeView, context: Context) {
        view.onUserScroll = onUserScroll
    }

    final class ProbeView: NSView {
        var onUserScroll: (() -> Void)?
        private var observer: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
            guard window != nil, let scroll = enclosingScrollView else { return }
            observer = NotificationCenter.default.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scroll,
                                                              queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.onUserScroll?() }
            }
        }

        deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
        }
    }
}

/// The explicit generation form owns its validation, so its initial bound values and later edits use the same rule.
struct WordTimingOptions: View {
    /// Up to 20 seconds of the transcript clock, and where they come from, in words.
    struct Range: Equatable {
        static let longest = 20.0
        let from: Double
        let to: Double
        let source: String

        /// The selected lines from the first start to the last end, cut at 20 s; nil when no selected line is timed.
        static func of(selected lines: [(start: Double?, end: Double?)]) -> Range? {
            let starts = lines.compactMap(\.start)
            guard let from = starts.min() else { return nil }
            let end = lines.compactMap { $0.end ?? $0.start }.max() ?? from
            let to = min(max(end, from + 1), from + longest)
            let cut = end > from + longest ? ", cut at 20 s" : ""
            return Range(from: from, to: to, source: "the \(Plural.count(lines.count, "selected line"))\(cut)")
        }

        /// The first line of 20 s or less that ends after `position` (else the first such line), and 20 s from its start.
        static func near<Lines: Sequence>(_ lines: Lines, position: Double) -> Range where Lines.Element == (start: Double?, end: Double?) {
            var first: Double?
            for line in lines {
                guard let start = line.start, let end = line.end, end > start, end - start <= longest else { continue }
                if first == nil { first = start }
                if end > position { return Range(from: start, to: start + longest, source: "from the line at the heard spot") }
            }
            let from = first ?? position
            return Range(from: from, to: from + longest, source: "from the line at the heard spot")
        }
    }

    let range: Range
    let model: String
    let language: String
    let openSettings: () -> Void
    let cancel: () -> Void
    let generate: () -> Void

    /// The language row: the choice in words, with the code the meeting's language resolved to.
    static func languageWords(_ choice: MeetingsPreferences.Transcript.TimingLanguage, code: String?) -> String {
        switch choice {
        case .meeting: code.map { "\(MeetingsLanguage.name($0)), the meeting's language" } ?? "Detected (the meeting's language is not read yet)"
        case .detect: "Detected by the model"
        case .cs, .en: MeetingsLanguage.name(choice.rawValue)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Generate word timings").font(.headline)
            Text("A cached model times each word of the range; only exact, unambiguous words are highlighted. Lines that "
                 + "cross the range's edge keep the line highlight.")
                .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                GridRow {
                    Text("Range").foregroundStyle(.secondary)
                    Text(verbatim: "\(MeetingsFormat.clock(range.from)) to \(MeetingsFormat.clock(range.to)), \(range.source)")
                        .monospacedDigit().fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("meetings.transcript.timings.range")
                }
                GridRow {
                    Text("Model").foregroundStyle(.secondary)
                    Text(verbatim: model)
                }
                GridRow {
                    Text("Language").foregroundStyle(.secondary)
                    Text(verbatim: language)
                }
            }
            .font(.system(size: 12))
            HStack {
                Button("Model and language…", action: openSettings)
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 12))
                    .instantTooltip("Opens the side panel, where the Transcript section sets the model and the language")
                    .accessibilityIdentifier("meetings.transcript.timings.settings")
                Spacer()
                Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
                Button("Generate", action: generate)
                    .accessibilityIdentifier("meetings.transcript.timings.generate")
            }
        }
        .padding(16).frame(width: 420)
    }
}
